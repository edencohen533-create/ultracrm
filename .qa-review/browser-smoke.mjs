import {chromium} from 'playwright';
import fs from 'node:fs';
const base='http://127.0.0.1:3119';
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:900},locale:'he-IL'});
const page=await ctx.newPage();
const results=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.goto(base+'/login');
await page.fill('input[type=email]','owner@demo.local');
await page.fill('input[type=password]','Demo1234!');
await page.click('button[type=submit]');
await page.waitForURL('**/dashboard',{timeout:30000});
for(const route of ['/dashboard','/contacts','/leads','/deals','/tasks','/inbox','/campaigns','/templates','/automations','/automations/history','/dialer','/lists','/manager','/manager/calls','/numbers','/settings','/settings/sms','/settings/email','/settings/whatsapp','/analytics']){
 const start=errors.length,failures=[];
 const listener=r=>{if(r.status()>=400&&r.url().startsWith(base))failures.push({url:r.url().slice(base.length),status:r.status()});};
 page.on('response',listener);
 try{const res=await page.goto(base+route,{waitUntil:'networkidle',timeout:30000});await page.waitForTimeout(300);results.push({route,status:res.status(),url:page.url().slice(base.length),errors:errors.slice(start),failures});}catch(e){results.push({route,error:e.message,errors:errors.slice(start),failures});}
 page.off('response',listener);
}
await page.screenshot({path:'.qa-review/browser-smoke.png',fullPage:true});
fs.writeFileSync('.qa-review/browser-smoke.json',JSON.stringify({results,errors},null,2));
console.log(JSON.stringify({pages:results.length,problemPages:results.filter(x=>x.error||x.errors.length||x.failures.length||x.status>=400),errors},null,2));
await browser.close();
