import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import assert from "node:assert/strict";
import { prisma as db } from "../src/lib/db";

async function main() {
  if(process.env.QA_LOCAL!=="1"||process.env.TELEPHONY_PROVIDER!=="mock")throw new Error("Local mock QA only");
  const base="http://127.0.0.1:3117";
  const log=fs.openSync(".qa-local/restart-server.log","w");let server:ChildProcess|undefined;
  const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  async function start(){
    server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port","3117"],{env:{...process.env,NODE_ENV:"production"},stdio:["ignore",log,log]});
    for(let i=0;i<60;i++){if(server.exitCode!==null)throw new Error("QA production server exited; see restart-server.log");try{if((await fetch(base+"/login")).ok)return;}catch{}await sleep(250);}
    throw new Error("QA production server startup timeout");
  }
  async function stop(){if(server&&server.exitCode===null){const exit=once(server,"exit");server.kill("SIGTERM");await exit;}}
  try{
    const tag=crypto.randomUUID();const b=await db.business.create({data:{slug:`restart-${tag}`,name:"QA restart"}});
    const user=await db.user.create({data:{businessId:b.id,email:`${tag}@qa.local`,fullName:"QA restart",role:"agent",passwordHash:await bcrypt.hash("qa-restart-password",4)}});
    await db.phoneNumber.create({data:{businessId:b.id,e164:"+97239995555",provider:"mock",isDefault:true}});
    await start();
    const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:user.email,password:"qa-restart-password"})});assert.equal(login.status,200);const cookie=login.headers.get("set-cookie")!.split(";")[0];
    const req=async(path:string,body?:unknown)=>{const r=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j.data;};
    const payload={mode:"manual",phone:"0529990055",idempotencyKey:crypto.randomUUID()};const call=await req("/api/dialer/call",payload);
    let answered=false;for(let i=0;i<50;i++){const s=await req("/api/dialer/state");if(s.activeCall?.answeredAt){answered=true;break;}await sleep(250);}assert.ok(answered);
    await stop();const t=Date.now();await start();const state=await req("/api/dialer/state");assert.equal(state.activeCall?.id,call.id);assert.ok(state.activeCall?.answeredAt);
    assert.equal((await req("/api/dialer/call",payload)).id,call.id);assert.equal(await db.call.count({where:{businessId:b.id}}),1);
    await req(`/api/dialer/call/${call.id}/hangup`,{});await req(`/api/dialer/call/${call.id}/outcome`,{outcome:"answered_not_interested"});
    assert.equal(await db.call.count({where:{businessId:b.id,endedAt:null}}),0);
    const result={at:new Date().toISOString(),mode:"local production build with mock provider",status:"עבר",sameCallAfterProcessRestart:true,callCount:1,idempotentRetry:true,noLiveCallsAfterCleanup:true,restartAndRecoveryMs:Date.now()-t};fs.writeFileSync(".qa-local/restart.json",JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await stop();fs.closeSync(log);await db.$disconnect();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
