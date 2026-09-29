import crypto from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import { runLeadResponseSla } from "@/server/ops/lead-response-sla";
import { interpretRule } from "@/server/ops/rules";
import { myRequests } from "@/server/ops/overview";
const { send } = vi.hoisted(()=>({send:vi.fn(async()=>({status:"sent"}))}));
vi.mock("@/server/assistant/transport",()=>({sendToLink:send}));
let a: Awaited<ReturnType<typeof createBusiness>>, leadId:string, contactId:string, ruleId:string;
const now = new Date();
const run = (at=now)=>withBusiness(a.business.id,()=>runLeadResponseSla(a.business.id,at));
const record=()=>db.opsRecommendation.findFirstOrThrow({where:{businessId:a.business.id,kind:"lead_response_sla"}});
beforeEach(async()=>{
 delete process.env.ANTHROPIC_API_KEY;send.mockClear();a=await createBusiness("sla",{modules:{crm:true,telephony:true}});
 await db.business.update({where:{id:a.business.id},data:{settings:{aiOps:{enabled:true,notifyWhatsApp:true,maxAlertsPerDay:50},assistant:{enabled:true}}}});
 await db.assistantLink.create({data:{businessId:a.business.id,userId:a.user.id,createdById:a.user.id,phoneE164:"+972550000009",status:"active",verifiedAt:now,lastInboundAt:now}});
 ruleId=(await db.opsRule.create({data:{businessId:a.business.id,kind:"lead_response_sla",name:"first dial",config:{minutes:5},autonomy:"insight",updatedAt:new Date(now.getTime()-3600000),createdAt:new Date(now.getTime()-3600000)}})).id;
 contactId=(await db.contact.create({data:{businessId:a.business.id,fullName:"SLA customer",phoneE164:"+972550000008",phoneRaw:"qa",ownerUserId:a.user.id}})).id;
 leadId=(await db.lead.create({data:{businessId:a.business.id,contactId,ownerUserId:a.user.id,createdAt:new Date(now.getTime()-240000)}})).id;
});
afterEach(async()=>{await destroyBusiness(a.business.id,[a.account.id]);});
async function dial(at:Date, data:Record<string,unknown>={}){return db.call.create({data:{businessId:a.business.id,userId:a.user.id,contactId,mode:"power",provider:"mock",idempotencyKey:crypto.randomUUID(),toE164:"+972550000008",fromE164:"+972550000007",status:"ended",leadDialedAt:at,endedAt:at,...data}});}
it("tracks the deadline then alerts once even with concurrent ticks",async()=>{
 await run();expect((await record()).status).toBe("monitoring");expect(send).not.toHaveBeenCalled();
 const late=new Date(now.getTime()+120000);await Promise.all([run(late),run(late)]);expect((await record()).status).toBe("needs_attention");
 const count=send.mock.calls.length;expect(count).toBeGreaterThan(0);await run(late);expect(send.mock.calls.length).toBe(count);
 expect((await withBusiness(a.business.id,()=>myRequests(a.session))).some(r=>r.kind==="lead_response_sla")).toBe(true);
});
it("real outbound dial meets target, not a call that never dialed the lead",async()=>{
 await dial(now,{leadDialedAt:null});await run();expect((await record()).status).toBe("monitoring");
 await dial(now);await run();expect(await record()).toMatchObject({status:"completed",result:{met:true,responseSeconds:240}});
});
it("status edits do not meet SLA; a late dial resolves the alert as late",async()=>{
 await db.lead.update({where:{id:leadId},data:{status:"contacted"}});const late=new Date(now.getTime()+120000);await run(late);expect((await record()).status).toBe("needs_attention");
 await dial(late);await run(late);expect(await record()).toMatchObject({status:"completed",result:{met:false,responseSeconds:360}});
});
it("calls for another contact and inbound calls cannot meet the deadline",async()=>{
 const other=await db.contact.create({data:{businessId:a.business.id,fullName:"Other",phoneE164:"+972550000006",phoneRaw:"qa"}});await dial(now,{direction:"inbound"});await dial(now,{contactId:other.id});await run(new Date(now.getTime()+120000));expect((await record()).status).toBe("needs_attention");
});
it("pausing invalidates the active monitor, and old backlog is not added",async()=>{
 await db.lead.create({data:{businessId:a.business.id,contactId,createdAt:new Date(now.getTime()-7200000)}});await run();expect(await db.opsRecommendation.count({where:{businessId:a.business.id,kind:"lead_response_sla"}})).toBe(1);
 await db.opsRule.update({where:{id:ruleId},data:{status:"paused"}});await run();expect((await record()).status).toBe("cancelled");
});
it("unassigned leads alert managers; opted-out leads are excluded",async()=>{
 await db.lead.update({where:{id:leadId},data:{ownerUserId:null}});await run(new Date(now.getTime()+120000));expect(await record()).toMatchObject({agentId:null,status:"needs_attention"});expect(send).toHaveBeenCalled();
 await db.contact.update({where:{id:contactId},data:{consentStatus:"OPTED_OUT"}});await run(new Date(now.getTime()+120000));expect((await record()).status).toBe("cancelled");
});
it("plain-language rule distinguishes alert, transfer and working hours",async()=>{
 expect(await interpretRule("תתריע על ליד ללא חיוג ראשון אחרי 7 דקות")).toMatchObject({kind:"lead_response_sla",config:{minutes:7},autonomy:"insight",allowedAutonomy:["insight","auto"]});
 expect(await interpretRule("תעביר ליד ללא חיוג ראשון אחרי 7 דקות בשעות העבודה")).toMatchObject({kind:"lead_response_sla",config:{minutes:7,onBreach:"transfer_to_available",businessHoursOnly:true},autonomy:"auto"});
});
it("a call attributed to a newer CRM lead does not satisfy the older lead's SLA",async()=>{
 await db.lead.create({data:{businessId:a.business.id,contactId,ownerUserId:a.user.id,createdAt:new Date(now.getTime()-120000)}});
 await dial(now);await run(new Date(now.getTime()+120000));
 const rows=await db.opsRecommendation.findMany({where:{businessId:a.business.id,kind:"lead_response_sla"}});
 expect(rows.find(r=>(r.proposal as {leadId:string}).leadId===leadId)?.status).toBe("needs_attention");
 expect(rows.filter(r=>r.status==="completed")).toHaveLength(1);
});
it("automatic escalation requires ownership policy, a fresh available recipient and executes once",async()=>{
 const acc=await db.account.create({data:{email:crypto.randomUUID()+"@test.local",fullName:"SLA target",passwordHash:"x"}});
 try{
 const target=await db.user.create({data:{businessId:a.business.id,accountId:acc.id,email:acc.email,fullName:acc.fullName,role:"agent"}});
 await db.dialerSession.create({data:{businessId:a.business.id,userId:target.id,mode:"power",browserSessionId:crypto.randomUUID()}});
 await db.opsRule.update({where:{id:ruleId},data:{autonomy:"auto",config:{minutes:1,onBreach:"transfer_to_available"},updatedAt:new Date(now.getTime()-3600000)}});
 await db.opsRule.create({data:{businessId:a.business.id,kind:"approval_policy",name:"allowed",config:{actions:["assignment"]},autonomy:"auto"}});
 await Promise.all([run(),run()]);expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(target.id);
 expect(await record()).toMatchObject({status:"needs_attention",agentId:target.id,result:{transferred:true}});await run();expect(await db.auditLog.count({where:{businessId:a.business.id,action:"lead.transferred",entityId:leadId}})).toBe(1);
 }finally{await db.dialerSession.deleteMany({where:{user:{accountId:acc.id}}});await db.lead.updateMany({where:{id:leadId},data:{ownerUserId:a.user.id}});await db.user.deleteMany({where:{accountId:acc.id}});await db.account.delete({where:{id:acc.id}});}
});
it("ownership approval policy prevents automatic reassignment",async()=>{
 await db.opsRule.update({where:{id:ruleId},data:{autonomy:"auto",config:{minutes:1,onBreach:"transfer_to_available"},updatedAt:new Date(now.getTime()-3600000)}});await run();expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(a.user.id);expect(await record()).toMatchObject({status:"needs_attention"});
});

it("negative transfer instructions do not create an automatic reassignment rule",async()=>{
 expect(await interpretRule("תתריע על ליד ללא חיוג ראשון אחרי 7 דקות, אל תעביר אותו")).toMatchObject({config:{onBreach:"alert"},autonomy:"insight"});
 expect(await interpretRule("תעביר ליד ללא חיוג ראשון אחרי 7 דקות רק אם יש לו תקציב גבוה")).toMatchObject({kind:null});
});
