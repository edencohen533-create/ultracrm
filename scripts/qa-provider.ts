import { stopMonitor, startMonitor, switchMode, markMonitorEnded } from "../src/lib/dialer/monitor";
import { businessDayStart } from "../src/lib/business-day";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { prisma as db } from "../src/lib/db";
import { startCall, hangupCall, reconcileCall } from "../src/lib/dialer/calls";
import { processProviderEvent } from "../src/lib/telephony/events";
import { mockAdapter } from "../src/lib/telephony/mock";
import { telnyxAdapter } from "../src/lib/telephony/telnyx";
import { TelephonyRequestTimeout } from "../src/lib/telephony/types";
import type { SessionUser } from "../src/lib/auth";

async function main() {
  if (process.env.QA_LOCAL !== "1" || process.env.TELEPHONY_PROVIDER !== "mock") throw new Error("Local mock QA only");
  const b = await db.business.create({ data: { name: "Provider fault QA", slug: `fault-${crypto.randomUUID()}` } });
  const u = await db.user.create({ data: { businessId:b.id, fullName:"QA agent",email:"fault@qa.local",passwordHash:"unused",role:"agent",sipUsername:"qa-local" } });
  const user: SessionUser = u;
  await db.phoneNumber.create({data:{businessId:b.id,e164:"+97239998888",isDefault:true,provider:"mock"}});
  const rows: {id:string;name:string;status:string;detail?:string}[]=[];
  const originals={dialAgent:mockAdapter.dialAgent, dialLead:mockAdapter.dialLead,updateMany:db.user.updateMany};
  const dial=()=>startCall(user,{mode:"manual",phone:"0529990088",idempotencyKey:crypto.randomUUID()});
  async function test(id:string,name:string,fn:()=>Promise<void>) {
    await db.call.updateMany({where:{businessId:b.id},data:{status:"ended",endedAt:new Date(),activeForUser:null,outcomeSavedAt:new Date()}});
    try { await fn(); rows.push({id,name,status:"עבר"}); console.log("PASS",id,name); }
    catch(e){ rows.push({id,name,status:"נכשל",detail:(e as Error).message});console.log("FAIL",id,name,(e as Error).message); }
    finally{ mockAdapter.dialAgent=originals.dialAgent;mockAdapter.dialLead=originals.dialLead;db.user.updateMany=originals.updateMany;process.env.TELEPHONY_PROVIDER="mock"; }
  }
  await test("F1","Immediate hangup before agent answers reaches terminal state",async()=>{
    const c=await dial(); await hangupCall(user,c.id); const after=await reconcileCall(c.id);assert.ok(after?.endedAt);assert.equal(after.activeForUser,null);
  });
  await test("F2","Early agent webhook cannot be overwritten by dial response",async()=>{
    mockAdapter.dialAgent=async input=>{
      await processProviderEvent({provider:"mock",eventId:crypto.randomUUID(),type:"leg.answered",callId:input.callId,leg:"agent",legId:`mock-agent-${input.callId}`,raw:{test:true}});
      return originals.dialAgent(input);
    };
    const c=await dial(); const fresh=await db.call.findUniqueOrThrow({where:{id:c.id}});assert.ok(fresh.agentAnsweredAt);assert.ok(fresh.leadLegId);assert.equal(fresh.status,"dialing_lead");
  });
  await test("F3","A failed finalization side effect is retried on event redelivery",async()=>{
    const c=await dial();const ev={provider:"mock" as const,eventId:crypto.randomUUID(),type:"leg.hangup" as const,callId:c.id,leg:"lead" as const,legId:`mock-lead-${c.id}`,hangupCause:"user_busy",raw:{test:true}};
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION dialer.qa_fail_presence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected finalization failure'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER qa_fail_presence BEFORE UPDATE ON dialer.users FOR EACH ROW WHEN (NEW.id = '${u.id.replaceAll("'", "''")}' AND NEW.presence = 'wrap_up') EXECUTE FUNCTION dialer.qa_fail_presence()`);
    try { await assert.rejects(processProviderEvent(ev),/injected/); }
    finally { await db.$executeRawUnsafe(`DROP TRIGGER qa_fail_presence ON dialer.users`);await db.$executeRawUnsafe(`DROP FUNCTION dialer.qa_fail_presence()`); }
    await processProviderEvent(ev);
    assert.equal((await db.user.findUniqueOrThrow({where:{id:u.id}})).presence,"wrap_up");
    assert.ok((await db.telephonyEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"mock",providerEventId:ev.eventId}}})).processedAt);
  });
  await test("F4","Unknown dial timeout never redials beyond provider deduplication window",async()=>{
    mockAdapter.dialAgent=async()=>{throw new TelephonyRequestTimeout();};
    const c=await dial();await db.call.update({where:{id:c.id},data:{createdAt:new Date(Date.now()-120000),dialPendingSince:new Date(Date.now()-90000)}});
    // Substitute the provider transport, so this fault injection cannot contact Telnyx.
    const orig=telnyxAdapter.dialAgent;let dials=0;
    telnyxAdapter.dialAgent=async()=>{dials++;throw new TelephonyRequestTimeout();};
    const env={...process.env};
    for(const key of ["TELNYX_API_KEY","TELNYX_PUBLIC_KEY","TELNYX_CALL_CONTROL_APP_ID","TELNYX_CREDENTIAL_CONNECTION_ID"])process.env[key]="test-only-no-network";
    process.env.TELEPHONY_PROVIDER="telnyx";
    try { await reconcileCall(c.id);assert.equal(dials,0);assert.ok((await db.call.findUniqueOrThrow({where:{id:c.id}})).activeForUser); }
    finally { telnyxAdapter.dialAgent=orig; for(const key of ["TELEPHONY_PROVIDER","TELNYX_API_KEY","TELNYX_PUBLIC_KEY","TELNYX_CALL_CONTROL_APP_ID","TELNYX_CREDENTIAL_CONNECTION_ID"])process.env[key]=env[key]; }
  });
  await test("F5","Business day boundaries are independent of server timezone and DST",async()=>{
    assert.equal(businessDayStart("Asia/Jerusalem",new Date("2026-09-23T22:30:00Z")).toISOString(),"2026-09-23T21:00:00.000Z");
    assert.equal(businessDayStart("Asia/Jerusalem",new Date("2026-01-23T22:30:00Z")).toISOString(),"2026-01-23T22:00:00.000Z");
    assert.equal(businessDayStart("Asia/Jerusalem",new Date("2026-10-25T12:00:00Z")).toISOString(),"2026-10-24T21:00:00.000Z");
    assert.equal(businessDayStart("UTC",new Date("2026-09-23T22:30:00Z")).toISOString(),"2026-09-23T00:00:00.000Z");
  });
  await test("F6","Failed supervisor hangup does not report a successful disconnect",async()=>{
    const c=await dial();
    const manager=await db.user.create({data:{businessId:b.id,fullName:"QA manager",email:"monitor@qa.local",passwordHash:"unused",role:"admin"}});
    const m=await db.callMonitor.create({data:{businessId:b.id,callId:c.id,managerId:manager.id,activeForManager:manager.id,mode:"listen",status:"listening",legId:"test-supervisor-leg"}});
    const hangup=mockAdapter.hangupLeg;
    mockAdapter.hangupLeg=async()=>{throw new Error("injected hangup failure");};
    try { await assert.rejects(stopMonitor(manager,m.id));assert.equal((await db.callMonitor.findUniqueOrThrow({where:{id:m.id}})).endedAt,null); }
    finally {mockAdapter.hangupLeg=hangup;}
    await stopMonitor(manager,m.id);
    assert.ok((await db.callMonitor.findUniqueOrThrow({where:{id:m.id}})).endedAt);
    assert.equal((await db.call.findUniqueOrThrow({where:{id:c.id}})).endedAt,null);
  });
  async function monitorFixture() {
    const c=await dial();
    await db.call.update({where:{id:c.id},data:{answeredAt:new Date(),status:"answered"}});
    const manager=await db.user.create({data:{businessId:b.id,fullName:"QA supervisor race",email:`${crypto.randomUUID()}@qa.local`,passwordHash:"unused",role:"admin"}});
    return {c,manager};
  }
  await test("F7","Stopping while supervisor dial is pending disconnects the late leg",async()=>{
    const {c,manager}=await monitorFixture();
    const originalDial=mockAdapter.dialSupervisor, originalHangup=mockAdapter.hangupLeg;
    const hung:string[]=[];
    mockAdapter.hangupLeg=async id=>{hung.push(id);};
    mockAdapter.dialSupervisor=async input=>{
      await stopMonitor(manager,input.monitorId);
      return {legId:"late-supervisor-leg"};
    };
    try {const m=await startMonitor(manager,c.id);assert.ok(m.endedAt);assert.ok(hung.includes("late-supervisor-leg"));}
    finally {mockAdapter.dialSupervisor=originalDial;mockAdapter.hangupLeg=originalHangup;}
  });
  await test("F8","Delayed whisper response cannot overwrite an ended monitor",async()=>{
    const {c,manager}=await monitorFixture();
    const m=await db.callMonitor.create({data:{businessId:b.id,callId:c.id,managerId:manager.id,activeForManager:manager.id,mode:"listen",status:"listening",legId:"race-supervisor-leg"}});
    const original=mockAdapter.switchSupervisorRole;
    mockAdapter.switchSupervisorRole=async()=>{await markMonitorEnded(m.id,"provider_left");};
    try {await assert.rejects(switchMode(manager,m.id,"whisper"));assert.equal((await db.callMonitor.findUniqueOrThrow({where:{id:m.id}})).status,"ended");}
    finally {mockAdapter.switchSupervisorRole=original;}
  });
  await test("F9","Late supervisor join learns its leg and disconnects after cancellation",async()=>{
    const {c,manager}=await monitorFixture();
    const m=await db.callMonitor.create({data:{businessId:b.id,callId:c.id,managerId:manager.id,mode:"listen",status:"ended",endedAt:new Date()}});
    const original=mockAdapter.hangupLeg;const hung:string[]=[];
    const event={provider:"mock" as const,eventId:crypto.randomUUID(),type:"conference.joined" as const,callId:c.id,monitorId:m.id,leg:"supervisor" as const,legId:"late-webhook-leg",raw:{test:true}};
    mockAdapter.hangupLeg=async()=>{throw new Error("injected late leg cleanup failure");};
    try {
      await assert.rejects(processProviderEvent(event),/cleanup failure/);
      assert.equal((await db.telephonyEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"mock",providerEventId:event.eventId}}})).processedAt,null);
      mockAdapter.hangupLeg=async id=>{hung.push(id);};
      await processProviderEvent(event);
      assert.ok(hung.includes("late-webhook-leg"));
      assert.equal((await db.callMonitor.findUniqueOrThrow({where:{id:m.id}})).legId,"late-webhook-leg");
      assert.equal((await db.call.findUniqueOrThrow({where:{id:c.id}})).endedAt,null);
    } finally {mockAdapter.hangupLeg=original;}
  });
  await db.call.updateMany({where:{businessId:b.id},data:{endedAt:new Date(),activeForUser:null,outcomeSavedAt:new Date()}});
  fs.writeFileSync(process.env.QA_RESULT??".qa-local/provider.json",JSON.stringify({at:new Date().toISOString(),mode:"injected provider transport; zero external calls",rows},null,2));
  await db.$disconnect();process.exitCode=rows.some(r=>r.status==="נכשל")?1:0;
}
main().catch(async e=>{console.error(e);await db.$disconnect();process.exitCode=1;});
