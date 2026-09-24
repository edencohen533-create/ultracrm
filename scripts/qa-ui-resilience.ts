/* eslint-disable @typescript-eslint/no-explicit-any */
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import assert from "node:assert/strict";
import { prisma as db } from "../src/lib/db";

async function main(){
  if(process.env.QA_LOCAL!=="1"||process.env.TELEPHONY_PROVIDER!=="mock")throw new Error("Local mock QA only");
  const tag=crypto.randomUUID(),base=process.env.QA_BASE!,shots=process.env.QA_SHOTS!;fs.mkdirSync(shots,{recursive:true});
  const b=await db.business.create({data:{slug:`browser-${tag}`,name:"QA browser resilience"}});
  const hash=await bcrypt.hash("qa-browser-password",4);
  const manager=await db.user.create({data:{businessId:b.id,role:"manager",fullName:"QA מנהלת",email:`manager-${tag}@qa.local`,passwordHash:hash}});
  const team=await db.team.create({data:{businessId:b.id,name:"QA צוות",managerId:manager.id}});
  const agent=await db.user.create({data:{businessId:b.id,role:"agent",fullName:"QA נציגה",email:`agent-${tag}@qa.local`,passwordHash:hash,teamId:team.id}});
  await db.phoneNumber.create({data:{businessId:b.id,e164:"+97239996666",isDefault:true,provider:"mock"}});
  const browser=await chromium.launch({args:["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"]});
  const ac=await browser.newContext({permissions:["microphone"],locale:"he-IL",viewport:{width:1366,height:768}}),mc=await browser.newContext({permissions:["microphone"],locale:"he-IL",viewport:{width:1366,height:768}});
  const page=await ac.newPage(),mp=await mc.newPage();page.setDefaultTimeout(15000);mp.setDefaultTimeout(15000);
  const consoleErrors:string[]=[];for(const p of [page,mp])p.on("pageerror",e=>consoleErrors.push(e.message));
  const rows:any[]=[];
  async function test(id:string,name:string,fn:()=>Promise<any>){try{rows.push({id,name,status:"עבר",detail:await fn()});console.log("PASS",id,name);}catch(e){rows.push({id,name,status:"נכשל",detail:(e as Error).message});console.log("FAIL",id,name,(e as Error).message);await page.screenshot({path:`${shots}/${id}-error.png`});}}
  async function login(p:Page,email:string){await p.goto(base+"/login");await p.getByLabel("אימייל").fill(email);await p.getByLabel("סיסמה").fill("qa-browser-password");await p.getByRole("button",{name:"כניסה"}).click();await p.waitForURL(u=>!u.pathname.startsWith("/login"));}
  async function request(p:Page,path:string,method="GET",body?:any){return p.evaluate(async({path,method,body})=>{const r=await fetch(path,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,...await r.json()};},{path,method,body});}
  await login(page,agent.email);await login(mp,manager.email);await mp.goto(base+"/manager");
  await page.getByPlaceholder("050-1234567").fill("0529990077");await page.getByRole("button",{name:"חייג",exact:true}).click();
  await page.locator("aside").last().getByText("בשיחה",{exact:true}).waitFor({timeout:25000});
  const call=(await request(page,"/api/dialer/state")).data.activeCall;
  await test("B1","Reload during a call retains the same call and does not dial again",async()=>{
    const count=await db.call.count({where:{businessId:b.id}});await page.reload();await page.locator("aside").last().getByText("בשיחה",{exact:true}).waitFor();assert.equal((await request(page,"/api/dialer/state")).data.activeCall.id,call.id);assert.equal(await db.call.count({where:{businessId:b.id}}),count);await page.screenshot({path:`${shots}/B1-reload-call.png`});return {callCount:count};
  });
  await test("B2","Offline manager marks data stale; reconnect catches the ended call",async()=>{
    const row=mp.locator("tr",{hasText:agent.fullName});await row.getByText("בשיחה").first().waitFor();await mc.setOffline(true);
    await mp.getByText("הנתונים אינם עדכניים",{exact:true}).waitFor({timeout:18000});await mp.screenshot({path:`${shots}/B2-offline-manager.png`});
    await page.getByRole("button",{name:/^נתק/}).first().click();await page.getByText("תוצאת שיחה",{exact:true}).waitFor();
    const t=Date.now();await mc.setOffline(false);await row.getByText("בתיעוד",{exact:false}).first().waitFor({timeout:15000});const lagMs=Date.now()-t;
    await mp.screenshot({path:`${shots}/B2-reconnected-manager.png`});return {reconnectToCurrentStateMs:lagMs};
  });
  await mc.setOffline(false);
  await test("B6","Draft save failure is visible and local note survives reload",async()=>{
    const route="**/api/dialer/draft";
    await page.route(route,r=>r.request().method()==="PUT"?r.fulfill({status:500,contentType:"application/json",body:JSON.stringify({success:false,error:"QA draft unavailable"})}):r.continue());
    await page.locator("textarea").first().fill("QA טיוטה מקומית בלבד");
    await page.getByText("שמירת הטיוטה בשרת נכשלה; ההערה נשמרה בדפדפן הזה",{exact:true}).waitFor();
    await page.screenshot({path:`${shots}/B6-draft-failure.png`});await page.unroute(route);await page.reload();
    await page.getByText("תוצאת שיחה",{exact:true}).waitFor();assert.equal(await page.locator("textarea").first().inputValue(),"QA טיוטה מקומית בלבד");return {errorVisible:true,localDraftRetained:true};
  });
  await test("B3","Failed outcome save keeps note and wrap-up; retry persists exactly once",async()=>{
    const note=page.getByPlaceholder("הערות מהשיחה…");
    // The workspace uses an ordinary textarea for the call note.
    const input=await note.count()?note:page.locator("textarea").first();await input.fill("QA הערה לשימור אחרי שגיאה");
    const pattern="**/api/dialer/call/*/outcome";
    await page.route(pattern,r=>r.fulfill({status:500,contentType:"application/json",body:JSON.stringify({success:false,error:"QA כשל שמירה לבדיקה",code:"server_error"})}));
    await page.getByRole("button",{name:/ענה – לא מעוניין/}).click();await page.getByRole("button",{name:"שמור תוצאה והמשך"}).click();
    await page.getByText("QA כשל שמירה לבדיקה",{exact:true}).waitFor();assert.equal(await input.inputValue(),"QA הערה לשימור אחרי שגיאה");assert.equal((await db.call.findUniqueOrThrow({where:{id:call.id}})).outcomeSavedAt,null);
    assert.equal(await page.getByText("התוצאה נשמרה",{exact:true}).count(),0);await page.screenshot({path:`${shots}/B3-save-failure.png`});
    await page.unroute(pattern);await page.getByRole("button",{name:"שמור תוצאה והמשך"}).click();await page.getByText("התוצאה נשמרה",{exact:true}).waitFor();
    const saved=await db.call.findUniqueOrThrow({where:{id:call.id}});assert.equal(saved.outcomeNote,"QA הערה לשימור אחרי שגיאה");await page.reload();assert.ok(saved.outcomeSavedAt);return {persistedNote:true};
  });
  await test("B4","Desktop Hebrew layout fits 1366px and navigation does not multiply polling",async()=>{
    let polls=0;const listener=(r:any)=>{if(r.url().includes("/api/dialer/state"))polls++;};page.on("request",listener);
    for(let i=0;i<4;i++){await page.getByRole("link",{name:"אנשי קשר",exact:true}).click();await page.getByRole("link",{name:"מסך חיוג",exact:true}).click();}
    polls=0;await page.waitForTimeout(13000);page.off("request",listener);assert.ok(polls<=4,`idle polls in 13s: ${polls}`);
    const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,dir:document.documentElement.dir}));assert.equal(size.dir,"rtl");assert.ok(size.scroll<=size.width,JSON.stringify(size));await page.screenshot({path:`${shots}/B4-laptop-1366.png`});return {pollsIn13Seconds:polls,...size};
  });
  await test("B5","Browser without a session returns to login",async()=>{
    await ac.clearCookies();await page.reload();await page.waitForURL(u=>u.pathname.startsWith("/login"));return {redirected:true};
  });
  await browser.close();
  fs.writeFileSync(".qa-local/browser-resilience.json",JSON.stringify({at:new Date().toISOString(),mode:"real Chromium; local mock telephony; network failures injected",rows,consoleErrors},null,2));
  await db.$disconnect();process.exitCode=rows.some(r=>r.status==="נכשל")||consoleErrors.length?1:0;
}
main().catch(async e=>{console.error(e);await db.$disconnect();process.exitCode=1;});
