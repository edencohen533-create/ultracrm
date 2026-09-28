import crypto from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { runOpsTick, opsWhatsAppReply, managerDecision } from "@/server/ops/engine";
import { answerFollowup, runFollowupCheckins, parseFollowupAnswer } from "@/server/ops/followup-checkin";
import { ensureDefaultRules, interpretRule, parseConfig } from "@/server/ops/rules";
import { chatTurn, buildCtx } from "@/server/ai/engine";
import { runAiTool } from "@/server/ai/tools";
const { delivery } = vi.hoisted(()=>({delivery:vi.fn(async(..._args: unknown[])=>({status:"sent" as string,detail:undefined as string|undefined}))}));
vi.mock("@/server/assistant/transport",()=>({sendToLink:delivery}));
let a: Awaited<ReturnType<typeof createBusiness>>, owner: SessionUser, agent: SessionUser, target: SessionUser;
let accounts: string[], taskId: string, leadId: string, ruleId: string;
const run = <T,>(fn:()=>Promise<T>)=>withBusiness(a.business.id,fn);
const as = <T,>(u:SessionUser,fn:()=>Promise<T>)=>withBusiness(u.businessId,fn,u);
const rec = ()=>db.opsRecommendation.findFirstOrThrow({where:{businessId:a.business.id,kind:"followup_checkin"}});
async function online(u:SessionUser){return db.dialerSession.create({data:{businessId:u.businessId,userId:u.id,mode:"power",browserSessionId:crypto.randomUUID()}});}
async function mkAgent(name:string){const acc=await db.account.create({data:{email:crypto.randomUUID()+"@test.local",fullName:name,passwordHash:"x"}});accounts.push(acc.id);const u=await db.user.create({data:{businessId:a.business.id,accountId:acc.id,email:acc.email,fullName:name,role:"agent"}});return {...u} as SessionUser;}
beforeEach(async()=>{
 delete process.env.ANTHROPIC_API_KEY;delivery.mockClear();delivery.mockResolvedValue({status:"sent",detail:undefined});
 a=await createBusiness("checkin",{modules:{crm:true,telephony:true,whatsapp:true}});accounts=[a.account.id];owner=a.session;agent=await mkAgent("נציג פולואפ");target=await mkAgent("נציג זמין");
 await db.business.update({where:{id:a.business.id},data:{settings:{timezone:"Asia/Jerusalem",aiOps:{enabled:true,notifyWhatsApp:true,maxAlertsPerDay:50},assistant:{enabled:true},leadAssignment:{mode:"round_robin",agentIds:[],maxOpenLeadsPerAgent:0,perAgentMax:{}}}}});
 for(const u of [owner,agent,target])await db.assistantLink.create({data:{businessId:a.business.id,userId:u.id,createdById:owner.id,phoneE164:"+97255"+String(1000000+accounts.indexOf(u.accountId)),status:"active",verifiedAt:new Date(),lastInboundAt:new Date()}});
 await run(()=>ensureDefaultRules(a.business.id));
 const rule=await db.opsRule.create({data:{businessId:a.business.id,kind:"followup_checkin",name:"פולואפ",config:parseConfig("followup_checkin",{}),autonomy:"auto",priority:1}});ruleId=rule.id;
 const c=await db.contact.create({data:{businessId:a.business.id,fullName:"לקוח לבדיקה",phoneE164:"+972550000009",phoneRaw:"QA",ownerUserId:agent.id}});
 const l=await db.lead.create({data:{businessId:a.business.id,contactId:c.id,ownerUserId:agent.id,status:"follow_up"}});leadId=l.id;
 const t=await db.task.create({data:{businessId:a.business.id,contactId:c.id,leadId:l.id,userId:agent.id,type:"callback",status:"open",dueAt:new Date(Date.now()-60000)}});taskId=t.id;
 await online(target);
});
afterEach(async()=>{vi.unstubAllGlobals();if(a)await destroyBusiness(a.business.id,accounts);});
it("due callback prompts its offline owner once across concurrent ticks; future callbacks do not prompt",async()=>{
 await db.task.update({where:{id:taskId},data:{dueAt:new Date(Date.now()+60000)}});await run(()=>runOpsTick(a.business.id));expect(delivery).not.toHaveBeenCalled();
 await db.task.update({where:{id:taskId},data:{dueAt:new Date(Date.now()-60000)}});
 await Promise.all([run(()=>runOpsTick(a.business.id)),run(()=>runOpsTick(a.business.id))]);
 expect(delivery).toHaveBeenCalledTimes(1);expect(delivery.mock.calls[0][1]).toContain("אתה עולה לחייגן");expect((await rec()).status).toBe("pending_agent");
});
it("connected owner is not prompted; connect answer waits for a real heartbeat",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();
 expect((await as(agent,()=>answerFollowup(agent,r.id,"אני מתחבר לחייגן","app"))).status).toBe("waiting_connection");
 await online(agent);await run(()=>runFollowupCheckins(a.business.id));
 expect((await rec()).status).toBe("completed");expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(agent.id);
 await run(()=>runOpsTick(a.business.id));expect(delivery).toHaveBeenCalledTimes(1);
});
it("no answer expires with manager alert but never transfers",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();await run(()=>runFollowupCheckins(a.business.id,new Date(r.expiresAt.getTime()+1)));
 expect((await rec()).status).toBe("expired");expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(agent.id);
 expect(delivery.mock.calls.some(c=>String(c[1]).includes("לא בוצעה העברה"))).toBe(true);
});
it("explicit transfer respects manager policy then moves lead and callback together",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();const old=await db.task.findUniqueOrThrow({where:{id:taskId}});
 expect((await as(agent,()=>answerFollowup(agent,r.id,"תעבירו את הליד לנציג אחר","whatsapp"))).status).toBe("pending_manager");
 expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(agent.id);
 await as(owner,()=>managerDecision(owner,r.id,{action:"approve",via:"app"}));
 expect((await rec()).status).toBe("completed");expect(await db.task.findUniqueOrThrow({where:{id:taskId}})).toMatchObject({userId:target.id,dueAt:old.dueAt});
 expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(target.id);
 await expect(as(agent,()=>answerFollowup(agent,r.id,"transfer","app"))).rejects.toMatchObject({code:"not_pending"});
});
it("automatic transfer needs an explicit agent reply and permissive ownership policy",async()=>{
 await db.opsRule.updateMany({where:{businessId:a.business.id,kind:"approval_policy"},data:{config:{actions:["assignment"]}}});
 await run(()=>runOpsTick(a.business.id));const r=await rec();
 expect((await as(agent,()=>answerFollowup(agent,r.id,"transfer","app"))).status).toBe("completed");
 expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(target.id);
});
it("ambiguous answer and conflicting instructions make no change",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();
 for(const text of ["כן","לא","אל תעבירו","מתחבר או תעבירו","תעבירו אבל לא עכשיו"]){expect((await as(agent,()=>answerFollowup(agent,r.id,text,"app"))).status).toBe("unclear");}
 expect((await rec()).status).toBe("pending_agent");
});
it("multiple WhatsApp requests require a matching code",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();
 await db.opsRecommendation.create({data:{businessId:a.business.id,kind:"momentum",agentId:agent.id,status:"pending_agent",code:r.code==="7777"?"8888":"7777",title:"extra",explanation:"extra",evidence:{},proposal:{},dedupeKey:"other",expiresAt:r.expiresAt}});
 expect(await as(agent,()=>opsWhatsAppReply(agent,"תעבירו"))).toContain("כמה בקשות");expect((await rec()).status).toBe("pending_agent");
 expect(await as(agent,()=>opsWhatsAppReply(agent,"מתחבר "+r.code))).toContain("נבדוק שהתחברת");expect((await rec()).status).toBe("waiting_connection");
});
it("rescheduling or pausing the rule invalidates outstanding requests",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();await db.task.update({where:{id:taskId},data:{dueAt:new Date(Date.now()+3600000)}});
 expect((await as(agent,()=>answerFollowup(agent,r.id,"transfer","app"))).status).toBe("cancelled");
 await db.task.update({where:{id:taskId},data:{dueAt:new Date(Date.now()-30000)}});await run(()=>runOpsTick(a.business.id));
 await db.opsRule.update({where:{id:ruleId},data:{status:"paused"}});await run(()=>runFollowupCheckins(a.business.id));
 expect(await db.opsRecommendation.count({where:{businessId:a.business.id,status:"pending_agent"}})).toBe(0);
});
it("no eligible recipient never transfers; failed WhatsApp stays visible in app",async()=>{
 delivery.mockResolvedValue({status:"failed",detail:"test provider unavailable"});await run(()=>runOpsTick(a.business.id));const r=await rec();expect(r.result).toMatchObject({agentRequest:{delivery:"failed"}});
 await as(agent,()=>answerFollowup(agent,r.id,"transfer","app"));await db.dialerSession.updateMany({where:{businessId:a.business.id},data:{status:"paused"}});
 expect((await as(owner,()=>managerDecision(owner,r.id,{action:"approve",via:"app"}))).status).toBe("needs_adjustment");
 expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(agent.id);
});
it("another agent cannot answer the owner's request",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();await expect(as(target,()=>answerFollowup(target,r.id,"transfer","app"))).rejects.toMatchObject({code:"not_found"});
});
it("natural-language rule supported; unavailable features explicitly require development and save nothing",async()=>{
 const supported=await interpretRule("כשמגיע זמן פולואפ והנציג לא מחובר לחייגן תשאל אותו בוואטסאפ אם הוא עולה או להעביר לנציג אחר");expect(supported.kind).toBe("followup_checkin");expect(supported.questions).toHaveLength(2);
 const unsupported=await interpretRule("אם לקוח מסכים תחייב אותו באשראי ותשלח חשבונית");expect(unsupported.kind).toBeNull();expect(unsupported.note).toContain("דורשת פיתוח");
 const result=await as(owner,()=>chatTurn(owner,{text:"תציג לי את המודעה מפייסבוק שהביאה את הליד"}));expect(result.message.text).toContain("דורשת פיתוח");expect(result.message.actions).toHaveLength(0);
 const {ctx}=await as(owner,()=>buildCtx(owner,"app",null));const tool=await as(owner,()=>runAiTool(ctx,"report_unsupported_request",{missingCapability:"חיבור למערכת שאינה נתמכת"}));expect(tool.result).toMatchObject({supported:false,executed:false});
});
it("negation is never parsed as consent",()=>{expect(parseFollowupAnswer("לא מתחבר אל תעבירו")).toBe("unclear");});
it("promise to connect is not a transfer approval when grace expires",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();await as(agent,()=>answerFollowup(agent,r.id,"connect","app"));const waiting=await rec();
 await run(()=>runFollowupCheckins(a.business.id,new Date(waiting.expiresAt.getTime()+1)));expect((await rec()).status).toBe("expired");expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(agent.id);
});
it("manager approval cannot execute a callback that was completed while waiting",async()=>{
 await run(()=>runOpsTick(a.business.id));const r=await rec();await as(agent,()=>answerFollowup(agent,r.id,"transfer","app"));await db.task.update({where:{id:taskId},data:{status:"done"}});
 expect((await as(owner,()=>managerDecision(owner,r.id,{action:"approve",via:"app"}))).status).toBe("cancelled");expect((await db.lead.findUniqueOrThrow({where:{id:leadId}})).ownerUserId).toBe(agent.id);
});
it("model unsupported tool produces an explicit response and cannot claim successful execution",async()=>{
 process.env.ANTHROPIC_API_KEY="test-only";
 const fetchMock=vi.fn(async()=>new Response(JSON.stringify({stop_reason:"tool_use",content:[{type:"tool_use",id:"unsupported",name:"report_unsupported_request",input:{missingCapability:"חיבור למערכת ניהול חיצונית"}}]}),{status:200}));vi.stubGlobal("fetch",fetchMock);
 const r=await as(owner,()=>chatTurn(owner,{text:"בצע פעולה במערכת ניהול חיצונית שאין חיבור אליה"}));expect(r.message.text).toContain("דורשת פיתוח");expect(r.message.actions).toHaveLength(0);expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("unsupported composite request refuses the entire tool batch before creating a task",async()=>{
 process.env.ANTHROPIC_API_KEY="test-only";
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({stop_reason:"tool_use",content:[
 {type:"tool_use",id:"task",name:"create_task",input:{leadId,title:"must not create",date:"2026-10-01",time:"12:00"}},
 {type:"tool_use",id:"gap",name:"report_unsupported_request",input:{missingCapability:"חיבור חסר"}}
 ]}),{status:200})));
 const before=await db.task.count({where:{businessId:a.business.id}});
 const r=await as(owner,()=>chatTurn(owner,{text:"צור משימה ובצע פעולה במערכת שאין חיבור אליה"}));
 expect(r.message.text).toContain("דורשת פיתוח");expect(r.message.actions).toHaveLength(0);
 expect(await db.task.count({where:{businessId:a.business.id}})).toBe(before);
});
it("an explicit model refusal is not replaced with a partial keyword rule",async()=>{
 process.env.ANTHROPIC_API_KEY="test-only";
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({content:[{type:"text",text:JSON.stringify({kind:null,note:"המשך הבקשה דורש יכולת שאינה נתמכת",questions:[]})}]}),{status:200})));
 const r=await interpretRule("אם יש פולואפ והנציג לא מחובר תשאל אותו ואז תבצע פעולה במערכת חיצונית");
 expect(r.kind).toBeNull();expect(r.summary).toBeNull();expect(r.note).toContain("אינה נתמכת");
});
