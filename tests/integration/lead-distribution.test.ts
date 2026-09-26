/**
 * Final-product items: editable lead statuses, round-robin distribution with a cap per agent,
 * and the dial-list view of the lead workspace (`/api/leads?listId=`).
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { createContact } from "@/lib/crm/contacts";
import { createLead, listLeads } from "@/lib/crm/pipeline";
import { processDomainEvents, waitForEvents } from "@/lib/events";
import { getBusinessSettings } from "@/lib/settings";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { GET: statusesGet, PATCH: statusesPatch } = await import("@/app/api/lead-statuses/route");

async function req(url: string, user: SessionUser, method: "GET" | "PATCH", body?: unknown) {
  const token = await signSession(user);
  return new NextRequest(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
}
const ctx = { params: Promise.resolve({}) };

describe("lead statuses, round robin, dial-list workspace", () => {
  let t: Awaited<ReturnType<typeof createBusiness>>;
  const agents: string[] = [];
  const accounts: string[] = [];
  beforeAll(async () => {
    t = await createBusiness("dist", { modules: { crm: true, telephony: true } });
    for (const n of [1, 2, 3]) {
      const acc = await db.account.create({ data: { email: `${t.business.slug}-a${n}@test.local`, fullName: `Agent ${n}`, passwordHash: "x" } });
      accounts.push(acc.id);
      const u = await db.user.create({ data: { businessId: t.business.id, accountId: acc.id, email: acc.email, fullName: acc.fullName, role: "agent" } });
      agents.push(u.id);
    }
  });
  afterAll(async () => { await destroyBusiness(t.business.id, [t.account.id, ...accounts]); });
  const run = <T,>(fn: () => Promise<T>) => withBusiness(t.business.id, fn, t.session);

  it("manager renames/hides a status; unknown keys are rejected; agents get 403; the hook endpoint returns the merged list", async () => {
    const agentSession: SessionUser = { ...t.session, id: agents[0], accountId: accounts[0], email: `${t.business.slug}-a1@test.local`, role: "agent" };
    expect((await statusesPatch(await req("/api/lead-statuses", agentSession, "PATCH", { leadStatuses: [{ key: "new", label: "x", hidden: false }] }), ctx)).status).toBe(403);
    const managerSession: SessionUser = { ...t.session, role: "manager" };
    const res = await statusesPatch(await req("/api/lead-statuses", managerSession, "PATCH", { leadStatuses: [{ key: "qualified", label: "חם 🔥", hidden: false }, { key: "unqualified", label: "לא רלוונטי", hidden: true }] }), ctx);
    expect(res.status).toBe(200);
    const s = await getBusinessSettings(t.business.id);
    expect(s.leadStatuses.find((x) => x.key === "qualified")?.label).toBe("חם 🔥");
    expect(s.leadStatuses.find((x) => x.key === "unqualified")?.hidden).toBe(true);
    expect(s.leadStatuses.map((x) => x.key).sort()).toEqual(["contacted", "converted", "lost", "new", "qualified", "unqualified"]); // keys never disappear
    expect(s.leadStatuses[0].key).toBe("qualified"); // saved order first, defaults appended
    const bad = await statusesPatch(await req("/api/lead-statuses", t.session, "PATCH", { leadStatuses: [{ key: "hot", label: "x", hidden: false }] }), ctx);
    expect(bad.status).toBe(400);
    const list = await statusesGet(await req("/api/lead-statuses", t.session, "GET"), ctx);
    expect((await list.json()).data.items.find((x: { key: string }) => x.key === "unqualified").hidden).toBe(true);
  });

  it("round robin rotates through the selected agents and skips agents at the cap", async () => {
    const [a1, a2, a3] = agents;
    await db.business.update({ where: { id: t.business.id }, data: { settings: { leadAssignment: { mode: "round_robin", maxOpenLeadsPerAgent: 2, agentIds: [a1, a2] } } } });
    const owners: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await run(() => createContact(t.session, { fullName: `RR ${i}`, phone: `0504440${100 + i}` }));
      const lead = await run(() => createLead(t.session, { contactId: c.id, title: `RR ${i}` }));
      await processDomainEvents({ businessId: t.business.id });
      await waitForEvents(t.business.id);
      owners.push((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerUserId ?? "none");
    }
    // a1, a2, a1, a2 → both at the cap (2 open leads each) → the 5th stays unassigned; a3 is never used (not in the pool).
    expect(owners).toEqual([a1, a2, a1, a2, "none"]);
    expect(owners).not.toContain(a3);
    expect((await getBusinessSettings(t.business.id)).leadAssignment.lastAssignedUserId).toBe(a2);
  });

  it("per-agent limits: each agent gets at most his own number of open leads", async () => {
    const [, a2, a3] = agents;
    await db.business.update({ where: { id: t.business.id }, data: { settings: { leadAssignment: { mode: "round_robin", maxOpenLeadsPerAgent: 0, agentIds: [a2, a3], perAgentMax: { [a2]: 3, [a3]: 1 }, lastAssignedUserId: a2 } } } });
    const owners: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await run(() => createContact(t.session, { fullName: `PA ${i}`, phone: `0504441${100 + i}` }));
      const lead = await run(() => createLead(t.session, { contactId: c.id, title: `PA ${i}` }));
      await processDomainEvents({ businessId: t.business.id }); await waitForEvents(t.business.id);
      owners.push((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerUserId ?? "none");
    }
    // a2 already holds 2 open leads (previous test); a3 has none. a3 → (a3 full at 1) a2 → (a2 full at 3) unassigned.
    expect(owners).toEqual([a3, a2, "none"]);
  });

  it("/api/leads?listId= shows exactly the dial list's contacts (the list page = lead workspace)", async () => {
    const list = await db.dialList.create({ data: { businessId: t.business.id, name: "Q" } });
    const inList = await run(() => createContact(t.session, { fullName: "In list", phone: "0504449001" }));
    const outside = await run(() => createContact(t.session, { fullName: "Outside", phone: "0504449002" }));
    await run(() => createLead(t.session, { contactId: inList.id, title: "in" }));
    await run(() => createLead(t.session, { contactId: outside.id, title: "out" }));
    await db.listLead.create({ data: { businessId: t.business.id, listId: list.id, contactId: inList.id } });
    const r = await run(() => listLeads(t.session, { listId: list.id, page: 1, limit: 30, sort: "createdAt", direction: "desc" } as Parameters<typeof listLeads>[1]));
    expect(r.items.map((l) => l.contact.fullName)).toEqual(["In list"]);
  });
});
