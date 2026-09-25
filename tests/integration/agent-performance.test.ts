import { beforeAll, afterAll, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { signSession, type SessionUser } from '@/lib/auth';
import { createBusiness, destroyBusiness } from './helpers';
import { GET } from '@/app/api/reports/agents/route';
let a: Awaited<ReturnType<typeof createBusiness>>, agent: SessionUser, manager: SessionUser;
const accounts: string[]=[];
beforeAll(async()=>{
  a=await createBusiness('agent-performance');
  async function user(role:'agent'|'manager'){const account=await db.account.create({data:{email:`${role}-${a.business.id}@test.local`,fullName:role,passwordHash:'test'}});accounts.push(account.id);return db.user.create({data:{businessId:a.business.id,accountId:account.id,email:account.email,fullName:role,role}});}
  agent=await user('agent');manager=await user('manager');
  const c=await db.contact.create({data:{businessId:a.business.id,fullName:'Report QA',phoneE164:'+972501236001',phoneRaw:'0501236001'}});
  const start=new Date('2026-09-25T10:00:00Z');
  await db.call.create({data:{businessId:a.business.id,userId:agent.id,contactId:c.id,mode:'manual',provider:'mock',idempotencyKey:`perf-${a.business.id}`,agentLegId:'mock-leg',toE164:c.phoneE164,fromE164:'+97239000000',status:'ended',createdAt:start,answeredAt:new Date(start.getTime()+5000),endedAt:new Date(start.getTime()+65000),talkSeconds:60,outcome:'sale',outcomeSavedAt:new Date(start.getTime()+70000)}});
  await db.deal.create({data:{businessId:a.business.id,contactId:c.id,ownerUserId:agent.id,title:'Closed',stage:'won',status:'won',closedAt:start,amount:500}});
});
afterAll(async()=>{if(a)await destroyBusiness(a.business.id,[a.account.id,...accounts]);});
async function report(user:SessionUser, query=''){const token=await signSession(user);return GET(new NextRequest(`http://localhost/api/reports/agents?from=2026-09-25T00:00:00Z&to=2026-09-25T23:59:59Z${query}`,{headers:{cookie:`ultracrm_session=${token}`}}),{params:Promise.resolve({})});}
it('calculates outgoing, handled, manual, closed and durations from persisted events',async()=>{const r=await report(a.session);expect(r.status).toBe(200);const {data}=await r.json();expect(data.rows.find((x:{id:string})=>x.id===agent.id)).toMatchObject({outbound:1,answered:1,handled:1,manual:1,closed:1,dialSeconds:5,talkSeconds:60});expect(data.totals).toMatchObject({outbound:1,closed:1,talkSeconds:60});});
it('scopes both agent details and totals to the managers teams',async()=>{const {data}=await(await report(manager,`&userId=${agent.id}`)).json();expect(data.rows).toEqual([]);expect(data.totals.outbound).toBe(0);expect(data.agents.some((x:{id:string})=>x.id===agent.id)).toBe(false);});
it('rejects agents and malformed date ranges',async()=>{expect((await report(agent)).status).toBe(403);expect((await report(a.session,'&from=2026-09-26T00:00:00Z')).status).toBe(400);});
