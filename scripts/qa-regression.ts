/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { prisma as db } from "../src/lib/db";
import { parseTelnyxWebhook } from "../src/lib/telephony/telnyx";
import { processProviderEvent } from "../src/lib/telephony/events";

if (process.env.QA_LOCAL !== "1" || new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1" || process.env.TELEPHONY_PROVIDER !== "mock") throw new Error("Local mock QA only");
async function main() {
const base = process.env.QA_BASE!;
const rows: any[] = [];
const tag = crypto.randomUUID().slice(0, 8);
const hash = await bcrypt.hash("qa-password", 4);
async function fixture(suffix: string) {
  const b = await db.business.create({ data: { slug: `reg-${tag}-${suffix}`, name: `QA ${suffix}`, settings: { maxDialsPerMinute: 100, dialWindow: { start: "00:00", end: "23:59", days: [0,1,2,3,4,5,6], timezone: "Asia/Jerusalem" } } } });
  const users = await Promise.all(["admin", "agent", "agent"].map((role, i) => db.user.create({ data: { businessId: b.id, fullName: `QA ${suffix} ${i}`, email: `${tag}-${suffix.toLowerCase()}-${i}@qa.local`, passwordHash: hash, role: role as any } })));
  const team = await db.team.create({ data: { businessId: b.id, name: "QA team" } });
  const number = await db.phoneNumber.create({ data: { businessId: b.id, e164: suffix === "A" ? "+97239990001" : "+97239990002", isDefault: true, provider: "mock" } });
  const script = await db.script.create({ data: { businessId: b.id, title: "QA script", body: "private test script" } });
  const list = await db.dialList.create({ data: { businessId: b.id, name: "QA list" } });
  for (let i=0;i<8;i++) {
    const contact = await db.contact.create({ data: { businessId: b.id, fullName: `QA lead ${i}`, phoneE164: `+97252999000${i}`, phoneRaw: `052999000${i}`, ownerUserId: users[1].id } });
    await db.listLead.create({ data: { businessId: b.id, listId: list.id, contactId: contact.id } });
  }
  const clients = await Promise.all(users.map(async u => {
    const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: "qa-password" }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    return async (method: string, path: string, body?: any) => {
      const r = await fetch(base + path, { method, headers: { cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = await r.json(); return { status: r.status, ...j };
    };
  }));
  return { b, users, clients, team, number, script, list };
}
const a = await fixture("A"), b = await fixture("B");
const [admin, agent, agent2] = a.clients;
async function reset() {
  await db.call.updateMany({ where: { businessId: a.b.id }, data: { endedAt: new Date(), activeForUser: null, status: "ended", outcomeSavedAt: new Date() } });
  await db.dialerSession.updateMany({ where: { businessId: a.b.id }, data: { status: "ended", endedAt: new Date() } });
  await db.listLead.updateMany({ where: { businessId: a.b.id }, data: { status: "pending", lockedByUserId: null, lockToken: null, lockExpiresAt: null, nextAttemptAt: null, attempts: 0 } });
  await db.dialList.update({ where: { id: a.list.id }, data: { isPaused: false } });
  await db.user.updateMany({ where: { businessId: a.b.id }, data: { presence: "available" } });
}
async function test(id: string, name: string, fn: () => Promise<any>) {
  await reset();
  try { const detail = await fn(); rows.push({ id, name, status: "עבר", mode: "mock/API/local PostgreSQL", detail }); console.log("PASS", id, name, detail ?? ""); }
  catch (e) { rows.push({ id, name, status: "נכשל", detail: (e as Error).message }); console.log("FAIL", id, name, (e as Error).message); }
}
const dial = (extra: any = {}) => agent("POST", "/api/dialer/call", { idempotencyKey: crypto.randomUUID(), mode: "manual", phone: "0529990003", ...extra });
async function session() { const s = await agent("POST", "/api/dialer/session", { mode: "preview", listId: a.list.id, browserSessionId: "qa-browser-tab" }); assert.equal(s.status,200); return s.data; }
async function held(s: any) { const r=await agent("POST", "/api/dialer/next-lead", { sessionId: s.id, browserSessionId: "qa-browser-tab" }); assert.equal(r.status,200); return r.data; }
await test("R1", "Paused session cannot dial a held lead", async () => {
  const s=await session(), l=await held(s);
  await agent("PATCH", "/api/dialer/session", { sessionId:s.id,browserSessionId:"qa-browser-tab",action:"pause" });
  const r=await dial({mode:"preview",sessionId:s.id,browserSessionId:"qa-browser-tab",leadId:l.id,lockToken:l.lockToken}); assert.equal(r.status,409,JSON.stringify(r)); assert.equal(r.code,"session_paused");
});
await test("R2", "Power call requires session and lead", async () => { const r=await dial({mode:"power"}); assert.equal(r.status,409,JSON.stringify(r)); });
await test("R3", "Session ownership cannot be omitted", async () => { const s=await session(); const r=await dial({sessionId:s.id}); assert.equal(r.status,409,JSON.stringify(r)); });
await test("R4", "Manager-paused list prevents dialing an already held lead", async () => {
  const s=await session(),l=await held(s); await db.dialList.update({where:{id:a.list.id},data:{isPaused:true}});
  const r=await dial({mode:"preview",sessionId:s.id,browserSessionId:"qa-browser-tab",leadId:l.id,lockToken:l.lockToken}); assert.equal(r.status,409,JSON.stringify(r)); assert.equal(r.code,"list_paused");
});
await test("R5", "Wrap-up blocks a new manual call", async () => {
  const c=await dial(); assert.equal(c.status,200);
  await db.call.update({where:{id:c.data.id},data:{endedAt:new Date(),activeForUser:null,status:"ended"}});
  const r=await dial({phone:"0529990004"}); assert.equal(r.status,409,JSON.stringify(r)); assert.equal(r.code,"outcome_required");
});
await test("R6", "Concurrent agents cannot call the same normalized number", async () => {
  const rs=await Promise.all([dial(),agent2("POST","/api/dialer/call",{idempotencyKey:crypto.randomUUID(),mode:"manual",phone:"+972529990003"})]);
  assert.equal(rs.filter(r=>r.status===200).length,1,JSON.stringify(rs.map(r=>({status:r.status,code:r.code}))));
  assert.equal(await db.call.count({where:{businessId:a.b.id,endedAt:null}}),1);
});
await test("R7", "Concurrent next-lead requests hold at most one lead per agent", async () => {
  const s=await session(); const rs=await Promise.all(Array.from({length:8},()=>agent("POST","/api/dialer/next-lead",{sessionId:s.id,browserSessionId:"qa-browser-tab"})));
  assert.ok(rs.every(r=>r.status===200),JSON.stringify(rs.map(r=>r.status)));
  assert.equal(new Set(rs.map(r=>r.data.id)).size,1); assert.equal(await db.listLead.count({where:{lockedByUserId:a.users[1].id,status:"locked"}}),1);
});
await test("R8", "Concurrent callback saves create one task", async () => {
  const c=await dial(); await db.call.update({where:{id:c.data.id},data:{endedAt:new Date(),activeForUser:null,status:"ended"}});
  const rs=await Promise.all(Array.from({length:5},()=>agent("POST",`/api/dialer/call/${c.data.id}/outcome`,{outcome:"callback",callbackAt:new Date(Date.now()+3600000).toISOString(),note:"QA callback"})));
  assert.ok(rs.every(r=>r.status===200)); assert.equal(await db.task.count({where:{callId:c.data.id}}),1);
});
await test("R9", "Reject cross-tenant contact owner before write", async () => { const r=await admin("POST","/api/contacts",{fullName:"QA foreign owner",phone:"0529990099",ownerUserId:b.users[1].id}); assert.equal(r.status,400); assert.equal(await db.contact.count({where:{businessId:a.b.id,ownerUserId:b.users[1].id}}),0); });
await test("R10", "Reject cross-tenant list relations before write", async () => { const r=await admin("POST","/api/lists",{name:"QA foreign list",agentIds:[b.users[1].id],scriptId:b.script.id,phoneNumberId:b.number.id}); assert.equal(r.status,400); });
await test("R11", "Rejected list patch leaves caller ID unchanged", async () => { const r=await admin("PATCH",`/api/lists/${a.list.id}`,{phoneNumberId:b.number.id}); assert.equal(r.status,400); assert.equal((await db.dialList.findUniqueOrThrow({where:{id:a.list.id}})).phoneNumberId,null); });
await test("R12", "Reject cross-tenant user team", async () => { const r=await admin("PATCH",`/api/users/${a.users[1].id}`,{teamId:b.team.id}); assert.equal(r.status,400); });
await test("R13", "Simulation endpoint cannot route into another tenant", async () => { const before=await db.call.count({where:{businessId:b.b.id}}); const r=await admin("POST","/api/dev/simulate-inbound",{from:"0529990088",to:b.number.e164}); assert.equal(r.status,400); assert.equal(await db.call.count({where:{businessId:b.b.id}}),before); });
await test("R14", "Recording webhook retains provider recording ID", async () => {
  const c=await dial(); const ev=parseTelnyxWebhook({data:{id:crypto.randomUUID(),event_type:"call.recording.saved",payload:{call_control_id:"qa-leg",client_state:Buffer.from(JSON.stringify({callId:c.data.id,leg:"lead"})).toString("base64"),recording_id:"qa-recording-id"} as any}})!;
  await processProviderEvent(ev); assert.equal((await db.call.findUniqueOrThrow({where:{id:c.data.id}})).recordingId,"qa-recording-id");
});
await test("R15", "Concurrent session starts leave one live session", async () => { const rs=await Promise.all(Array.from({length:5},(_,i)=>agent("POST","/api/dialer/session",{mode:"manual",browserSessionId:`qa-browser-tab-${i}`}))); assert.ok(rs.every(r=>r.status===200)); assert.equal(await db.dialerSession.count({where:{userId:a.users[1].id,status:{in:["active","paused"]}}}),1); });
await test("R16", "Future retry and owner grace use UTC on a non-UTC database", async () => {
  await db.listLead.updateMany({ where: { listId: a.list.id }, data: { status: "pending", nextAttemptAt: new Date(Date.now()+30*60000) } });
  const s=await session(); const r=await agent("POST","/api/dialer/next-lead",{sessionId:s.id,browserSessionId:"qa-browser-tab"});assert.equal(r.data,null);
  const l=await db.listLead.findFirstOrThrow({where:{listId:a.list.id}});
  await db.listLead.update({where:{id:l.id},data:{status:"callback",preferredUserId:a.users[2].id,nextAttemptAt:new Date(Date.now()-60000)}});
  const denied=await agent("POST","/api/dialer/next-lead",{sessionId:s.id,browserSessionId:"qa-browser-tab"});assert.equal(denied.data,null);
  await db.listLead.update({where:{id:l.id},data:{preferredUserId:a.users[1].id}});
  const got=await held(s);assert.equal(got.id,l.id);assert.ok(new Date(got.lockExpiresAt).getTime()-Date.now()<100000);
});
await test("R17", "Failed outcome transaction keeps summary and task unsaved", async () => {
  const c=await dial();await db.call.update({where:{id:c.data.id},data:{endedAt:new Date(),activeForUser:null,status:"ended"}});
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION dialer.qa_fail_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.note = 'QA injected failure' THEN RAISE EXCEPTION 'QA injected failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER qa_fail_task BEFORE INSERT ON dialer.tasks FOR EACH ROW EXECUTE FUNCTION dialer.qa_fail_task()`);
  try {
    const r=await agent("POST",`/api/dialer/call/${c.data.id}/outcome`,{outcome:"callback",callbackAt:new Date(Date.now()+3600000).toISOString(),note:"QA injected failure"});assert.equal(r.status,500);
    assert.equal((await db.call.findUniqueOrThrow({where:{id:c.data.id}})).outcomeSavedAt,null);assert.equal(await db.task.count({where:{callId:c.data.id}}),0);
  } finally { await db.$executeRawUnsafe(`DROP TRIGGER qa_fail_task ON dialer.tasks`);await db.$executeRawUnsafe(`DROP FUNCTION dialer.qa_fail_task()`); }
  const retry=await agent("POST",`/api/dialer/call/${c.data.id}/outcome`,{outcome:"callback",callbackAt:new Date(Date.now()+3600000).toISOString(),note:"QA retry"});assert.equal(retry.status,200);assert.equal(await db.task.count({where:{callId:c.data.id}}),1);
});
await test("R18", "An inbound number cannot be registered to a second tenant", async () => { const r=await admin("POST","/api/phone-numbers",{phone:b.number.e164});assert.equal(r.status,409); });
await test("R19", "Cross-tenant import owner is rejected atomically", async () => { const r=await admin("POST","/api/contacts/import",{rows:[{fullName:"QA foreign import",phone:"0529990089",ownerUserId:b.users[1].id}]});assert.equal(r.status,400);assert.equal(await db.contact.count({where:{businessId:a.b.id,phoneE164:"+972529990089"}}),0); });
await test("R20", "Exhausted attempt count cannot reenter the queue as pending", async () => { await db.listLead.updateMany({where:{listId:a.list.id},data:{attempts:99}});const s=await session();const r=await agent("POST","/api/dialer/next-lead",{sessionId:s.id,browserSessionId:"qa-browser-tab"});assert.equal(r.data,null); });
await test("R21", "Expired signed session is rejected by direct API", async () => {
  const token=await new SignJWT({businessId:a.b.id,role:"admin"}).setProtectedHeader({alg:"HS256"}).setSubject(a.users[0].id).setExpirationTime(Math.floor(Date.now()/1000)-60).sign(new TextEncoder().encode(process.env.JWT_SECRET!));
  const r=await fetch(base+"/api/dialer/state",{headers:{cookie:`dialer_session=${token}`}});assert.equal(r.status,401);
});
await test("R22", "Contact card cannot expose another agent's private follow-up task", async () => {
  const contact=await db.contact.findFirstOrThrow({where:{businessId:a.b.id}});
  const task=await db.task.create({data:{businessId:a.b.id,userId:a.users[2].id,contactId:contact.id,type:"callback",dueAt:new Date(),note:"QA private task for agent 2"}});
  const r=await agent("GET",`/api/contacts/${contact.id}`);assert.equal(r.status,200);assert.ok(!r.data.tasks.some((t:any)=>t.id===task.id));
});
await reset();
fs.writeFileSync(process.env.QA_RESULT ?? ".qa-local/regression.json", JSON.stringify({at:new Date().toISOString(),rows},null,2));
await db.$disconnect();
process.exitCode=rows.some(r=>r.status==="נכשל")?1:0;
}
main().catch(async e => { console.error(e); await db.$disconnect(); process.exitCode=1; });
