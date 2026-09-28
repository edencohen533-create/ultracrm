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
it("plain-language rule exposes minutes and explicitly refuses unsupported auto-transfer",async()=>{
 expect(await interpretRule("תתריע על ליד ללא חיוג ראשון אחרי 7 דקות")).toMatchObject({kind:"lead_response_sla",config:{minutes:7},autonomy:"insight",allowedAutonomy:["insight"]});
 expect(await interpretRule("תעביר ליד ללא חיוג ראשון אחרי 7 דקות")).toMatchObject({kind:null});
});
it("a call attributed to a newer CRM lead does not satisfy the older lead's SLA",async()=>{
 await db.lead.create({data:{businessId:a.business.id,contactId,ownerUserId:a.user.id,createdAt:new Date(now.getTime()-120000)}});
 await dial(now);await run(new Date(now.getTime()+120000));
 const rows=await db.opsRecommendation.findMany({where:{businessId:a.business.id,kind:"lead_response_sla"}});
 expect(rows.find(r=>(r.proposal as {leadId:string}).leadId===leadId)?.status).toBe("needs_attention");
 expect(rows.filter(r=>r.status==="completed")).toHaveLength(1);
});
