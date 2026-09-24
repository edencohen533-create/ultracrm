/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { prisma as db } from "../src/lib/db";

async function main() {
  if (process.env.QA_LOCAL !== "1" || new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1" || process.env.TELEPHONY_PROVIDER !== "mock") throw new Error("Local mock QA only");
  const base=process.env.QA_BASE!, tag=crypto.randomUUID();
  const b=await db.business.create({data:{name:"Isolated load QA",slug:`load-${tag}`,settings:{maxDialsPerMinute:0,dialWindow:{start:"00:00",end:"23:59",days:[0,1,2,3,4,5,6],timezone:"Asia/Jerusalem"}}}});
  const list=await db.dialList.create({data:{businessId:b.id,name:"Load 10000"}});
  const hash=await bcrypt.hash("qa-load-password",4);
  await db.phoneNumber.create({data:{businessId:b.id,e164:"+97239997777",isDefault:true,provider:"mock"}});
  const users=[];
  for(let i=0;i<20;i++)users.push(await db.user.create({data:{businessId:b.id,email:`${tag}-${i}@load.local`,fullName:`QA load ${i}`,passwordHash:hash,role:"agent"}}));
  for(let batch=0;batch<10;batch++){
    const contacts=Array.from({length:1000},(_,i)=>{const n=batch*1000+i;return {id:`load-${tag}-${n}`,businessId:b.id,fullName:`QA ${n}`,phoneE164:`+97255${String(n).padStart(7,"0")}`,phoneRaw:`055${String(n).padStart(7,"0")}`};});
    await db.contact.createMany({data:contacts});await db.listLead.createMany({data:contacts.map(c=>({businessId:b.id,listId:list.id,contactId:c.id}))});
  }
  const clients=[];
  for(const u of users){const r=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:u.email,password:"qa-load-password"})});assert.equal(r.status,200);clients.push({id:u.id,cookie:r.headers.get("set-cookie")!.split(";")[0]});}
  const privateKey=crypto.createPrivateKey(JSON.parse(fs.readFileSync(process.env.QA_KEYS!,"utf8")).privatePem);
  const stages:any[]=[];
  for(const concurrency of [1,5,10,20]){
    const latency:number[]=[], errors:string[]=[], claimed:string[]=[], started=Date.now();let requestCount=0;
    const req=async(cookie:string,method:string,path:string,body?:any)=>{const t=Date.now();const r=await fetch(base+path,{method,headers:{cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();latency.push(Date.now()-t);requestCount++;if(!r.ok)throw new Error(`${method} ${path.replace(/c[a-z0-9]{20,}/g,"<id>")} ${r.status} ${j.code}`);return j.data;};
    const event=async(callId:string,legId:string,type:string,leg:string)=>{
      const payload=JSON.stringify({data:{id:crypto.randomUUID(),event_type:type,occurred_at:new Date().toISOString(),payload:{call_control_id:legId,client_state:Buffer.from(JSON.stringify({callId,leg})).toString("base64"),hangup_cause:"normal_clearing"}}});
      const timestamp=String(Math.floor(Date.now()/1000));const headers={"Content-Type":"application/json","telnyx-timestamp":timestamp,"telnyx-signature-ed25519":crypto.sign(null,Buffer.from(`${timestamp}|${payload}`),privateKey).toString("base64")};
      const rs=await Promise.all(Array.from({length:3},()=>fetch(base+"/api/webhooks/telnyx",{method:"POST",headers,body:payload})));assert.ok(rs.every(r=>r.ok));requestCount+=3;
    };
    await Promise.all(clients.slice(0,concurrency).map(async client=>{
      try{
        const tab=`load-tab-${client.id}`;const session=await req(client.cookie,"POST","/api/dialer/session",{mode:"preview",listId:list.id,browserSessionId:tab});
        for(let i=0;i<3;i++){
          const lead=await req(client.cookie,"POST","/api/dialer/next-lead",{sessionId:session.id,browserSessionId:tab});assert.ok(lead);claimed.push(lead.id);
          const call=await req(client.cookie,"POST","/api/dialer/call",{mode:"preview",sessionId:session.id,browserSessionId:tab,leadId:lead.id,lockToken:lead.lockToken,idempotencyKey:crypto.randomUUID()});
          await event(call.id,call.agentLegId,"call.answered","agent");
          const live=await db.call.findUniqueOrThrow({where:{id:call.id}});assert.ok(live.leadLegId);
          await event(call.id,live.leadLegId,"call.answered","lead");await event(call.id,live.leadLegId,"call.hangup","lead");
          await req(client.cookie,"POST",`/api/dialer/call/${call.id}/outcome`,{outcome:"answered_not_interested"});
          await req(client.cookie,"GET","/api/dialer/state");
        }
        await req(client.cookie,"DELETE","/api/dialer/session",{sessionId:session.id,browserSessionId:tab});
      }catch(e){errors.push((e as Error).message);}
    }));
    latency.sort((a,b)=>a-b);const seconds=(Date.now()-started)/1000;
    const result={concurrency,cyclesPerAgent:3,seconds,requestCount,requestsPerSecond:Math.round(requestCount/seconds*10)/10,apiLatencyMs:{p50:latency[Math.floor(latency.length*.5)],p95:latency[Math.floor(latency.length*.95)],max:latency.at(-1)},claimed:claimed.length,duplicateClaims:claimed.length-new Set(claimed).size,liveCalls:await db.call.count({where:{businessId:b.id,endedAt:null}}),errors};stages.push(result);console.log(JSON.stringify(result));
  }
  const plans=await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM dialer.list_leads WHERE list_id=$1 AND status='pending' ORDER BY priority DESC,created_at ASC LIMIT 1`,list.id);
  const result={at:new Date().toISOString(),environment:"Next dev, local PostgreSQL, mock adapter + signed synthetic webhooks; no external calls",databaseTimezone:(await db.$queryRawUnsafe<any[]>("SHOW timezone"))[0],stages,callCount:await db.call.count({where:{businessId:b.id}}),eventCount:await db.telephonyEvent.count({where:{businessId:b.id}}),plans};
  fs.writeFileSync(".qa-local/load.json",JSON.stringify(result,null,2));await db.$disconnect();process.exitCode=stages.some(s=>s.errors.length||s.duplicateClaims||s.liveCalls||s.claimed!==s.concurrency*3)?1:0;
}
main().catch(async e=>{console.error(e);await db.$disconnect();process.exitCode=1;});
