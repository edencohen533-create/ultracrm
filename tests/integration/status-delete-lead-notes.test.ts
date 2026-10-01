/**
 * 1. Deleting statuses (real DB):
 *    • an empty custom status: deleted without a replacement, gone from the lists;
 *    • a status with leads: replacement required → leads move (history), nothing deleted;
 *    • a system status: only when another status of the same meaning exists – it becomes the meaning's main status,
 *      the leads show it, references by meaning (dialer / automations) resolve to it; otherwise refused with a reason;
 *    • automations (live + draft) and Meta conversion rules are re-pointed – no broken reference;
 *    • owner only, and per business.
 * 2. New lead from name + phone + notes: notes saved and returned; the duplicate protection stays (the same phone →
 *    the existing contact, no second contact; an open lead → no second lead); per business; validation.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { createStatus, deleteStatus, deletionImpact, listStatuses, resolveStatus } from "@/lib/crm/statuses";
import { updateLead } from "@/lib/crm/pipeline";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const statusRoute = await import("@/app/api/lead-statuses/[id]/route");
const leadsRoute = await import("@/app/api/leads/route");
const leadRoute = await import("@/app/api/leads/[id]/route");

type Biz = Awaited<ReturnType<typeof createBusiness>>;
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const req = async (who: SessionUser, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(who)}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const ctx = (id = "") => ({ params: Promise.resolve({ id }) });
let n = 0;
const phone = () => `+97254${String(1000000 + (Date.now() % 900000) + ++n * 13).slice(-7)}`;

describe("status deletion + new lead notes", { timeout: 300_000 }, () => {
  let A: Biz, B: Biz; let agent: SessionUser, manager: SessionUser;
  const accounts: string[] = [];
  beforeAll(async () => {
    A = await createBusiness("status-del", { modules: { crm: true, telephony: true } });
    B = await createBusiness("status-del-b", { modules: { crm: true, telephony: true } });
    const mk = async (role: "agent" | "manager") => {
      const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: role, passwordHash: "x" } }); accounts.push(acc.id);
      const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: role === "agent" ? "נציגה" : "מנהל", role } });
      return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: u.fullName, role, teamId: null } as SessionUser;
    };
    agent = await mk("agent"); manager = await mk("manager");
  });
  afterAll(async () => {
    for (const b of [A, B]) if (b) { await db.metaCapiRule.deleteMany({ where: { businessId: b.business.id } }); await db.lead.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id, [b.account.id]); }
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  });
  const lead = async (statusId?: string) => {
    const c = await db.contact.create({ data: { businessId: A.business.id, fullName: "ליד", phoneE164: phone(), phoneRaw: "x" } });
    const l = await db.lead.create({ data: { businessId: A.business.id, contactId: c.id, status: "new" } });
    if (statusId) await run(A.session, () => updateLead(A.session, l.id, { statusId }));
    return db.lead.findUniqueOrThrow({ where: { id: l.id } });
  };

  it("an empty custom status is deleted without a replacement and disappears from the lists", async () => {
    const s = await run(A.session, () => createStatus(A.session, { label: "ריק", kind: "contacted" }));
    const impact = await run(A.session, () => deletionImpact(A.business.id, s.id));
    expect(impact).toMatchObject({ leads: 0, needsReplacement: false, deletable: true });
    const res = await statusRoute.DELETE(await req(A.session, `/api/lead-statuses/${s.id}`, "DELETE", {}), ctx(s.id));
    expect(res.status).toBe(200);
    expect((await run(A.session, () => listStatuses(A.business.id))).some((x) => x.id === s.id)).toBe(false);
    await expect(run(A.session, () => resolveStatus(A.business.id, { statusId: s.id }))).rejects.toMatchObject({ code: "invalid_status" }); // can't be picked any more
  });

  it("a status with leads: replacement required; leads move with history; no lead deleted; Meta rules + drafts re-pointed", async () => {
    const hot = await run(A.session, () => createStatus(A.session, { label: "חם", kind: "qualified" }));
    const leads = [await lead(hot.id), await lead(hot.id)];
    const draftSeq = await db.marketingSequence.create({ data: { businessId: A.business.id, name: "טיוטה", trigger: "LEAD_STATUS_CHANGED", triggerConfig: {}, draft: { triggerConfig: { leadStatus: hot.id } }, isActive: false } as never });
    const rule = await db.metaCapiRule.create({ data: { businessId: A.business.id, name: "ליד חם", trigger: "lead_status", triggerConfig: { statusId: hot.id }, eventKind: "standard", eventName: "Lead", actionSource: "system_generated" } as never });
    const impact = await run(A.session, () => deletionImpact(A.business.id, hot.id));
    expect(impact).toMatchObject({ leads: 2, needsReplacement: true });
    expect(impact.capiRules.map((r) => r.id)).toEqual([rule.id]);
    expect(impact.automations.map((a) => a.id)).toEqual([draftSeq.id]);
    expect((await statusRoute.DELETE(await req(A.session, `/api/lead-statuses/${hot.id}`, "DELETE", {}), ctx(hot.id))).status).toBe(409);
    const sysQualified = impact.replacements.find((r) => r.isSystem)!;
    const res = await statusRoute.DELETE(await req(A.session, `/api/lead-statuses/${hot.id}`, "DELETE", { replacementId: sysQualified.id }), ctx(hot.id));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ leadsMoved: 2, automationsMoved: 1, capiRulesMoved: 1 });
    for (const l of leads) expect(await db.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: "qualified", statusDefId: null });
    expect(await db.auditLog.count({ where: { entityId: { in: leads.map((l) => l.id) }, action: "lead.status_replaced" } })).toBe(2);
    expect(((await db.metaCapiRule.findUniqueOrThrow({ where: { id: rule.id } })).triggerConfig as { statusId: string }).statusId).toBe(sysQualified.id);
    expect(((await db.marketingSequence.findUniqueOrThrow({ where: { id: draftSeq.id } })).draft as { triggerConfig: { leadStatus: string } }).triggerConfig.leadStatus).toBe("qualified");
  });

  it("a system status: refused while it's the only one of its meaning; with another one it hands over its meaning", async () => {
    const sysLost = (await run(A.session, () => listStatuses(A.business.id))).find((s) => s.isSystem && s.kind === "lost")!;
    const blocked = await run(A.session, () => deletionImpact(A.business.id, sysLost.id));
    expect(blocked).toMatchObject({ deletable: false, blockedReason: "only_of_kind" });
    expect((await statusRoute.DELETE(await req(A.session, `/api/lead-statuses/${sysLost.id}`, "DELETE", {}), ctx(sysLost.id))).status).toBe(409);
    // Leads in the system status and in a custom one of the same meaning; an automation by meaning.
    const custom = await run(A.session, () => createStatus(A.session, { label: "לא מעוניין", kind: "lost" }));
    const inSystem = await lead(sysLost.id); const inCustom = await lead(custom.id);
    expect(inSystem).toMatchObject({ status: "lost", statusDefId: null });
    const res = await statusRoute.DELETE(await req(A.session, `/api/lead-statuses/${sysLost.id}`, "DELETE", { replacementId: custom.id }), ctx(sysLost.id));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ leadsMoved: 1 });
    const after = await run(A.session, () => listStatuses(A.business.id));
    expect(after.some((s) => s.id === sysLost.id)).toBe(false);
    expect(after.filter((s) => s.kind === "lost")).toEqual([expect.objectContaining({ id: custom.id, isSystem: true })]);
    // Both leads are now in "לא מעוניין" (the meaning's main status), nothing deleted
    for (const l of [inSystem, inCustom]) expect(await db.lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: "lost", statusDefId: null });
    expect(await db.auditLog.count({ where: { entityId: inSystem.id, action: "lead.status_replaced" } })).toBe(1);
    // References by meaning (dialer wrap-up, automations) now resolve to it; still exactly 7 main statuses
    expect((await run(A.session, () => resolveStatus(A.business.id, { kind: "lost" }))).def.id).toBe(custom.id);
    expect(after.filter((s) => s.isSystem).length).toBe(7);
  });

  it("owner only; another business can't touch it", async () => {
    const s = await run(A.session, () => createStatus(A.session, { label: "זמני", kind: "contacted" }));
    expect((await statusRoute.DELETE(await req(manager, `/api/lead-statuses/${s.id}`, "DELETE", {}), ctx(s.id))).status).toBe(403);
    expect((await statusRoute.DELETE(await req(agent, `/api/lead-statuses/${s.id}`, "DELETE", {}), ctx(s.id))).status).toBe(403);
    expect((await statusRoute.DELETE(await req(B.session, `/api/lead-statuses/${s.id}`, "DELETE", {}), ctx(s.id))).status).toBe(404);
    expect((await run(A.session, () => listStatuses(A.business.id))).some((x) => x.id === s.id)).toBe(true);
    await run(A.session, () => deleteStatus(A.session, s.id, {}));
  });

  it("new lead: name + phone + notes → notes saved and shown on the lead; title not needed", async () => {
    const p = phone();
    const res = await leadsRoute.POST(await req(A.session, "/api/leads", "POST", { contact: { fullName: "דנה כהן", phone: p }, source: "טלפון", notes: "מעוניינת בחבילה הגדולה\nלחזור אחרי 18:00" }), ctx());
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(created).toMatchObject({ notes: "מעוניינת בחבילה הגדולה\nלחזור אחרי 18:00", title: null, contactReused: null });
    const reopened = (await (await leadRoute.GET(await req(A.session, `/api/leads/${created.id}`), ctx(created.id))).json()).data;
    expect(reopened.notes).toBe("מעוניינת בחבילה הגדולה\nלחזור אחרי 18:00");
    expect(await db.contact.count({ where: { businessId: A.business.id, phoneE164: p } })).toBe(1);
    // The same phone again: no second contact, no second open lead
    const again = await leadsRoute.POST(await req(A.session, "/api/leads", "POST", { contact: { fullName: "שם אחר", phone: p }, notes: "כפול" }), ctx());
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("open_lead_exists");
    expect(await db.contact.count({ where: { businessId: A.business.id, phoneE164: p } })).toBe(1);
    expect(await db.lead.count({ where: { businessId: A.business.id, contact: { phoneE164: p } } })).toBe(1);
  });

  it("an existing contact without an open lead: the lead opens on it (name not overwritten); other business separate", async () => {
    const p = phone();
    const existing = await db.contact.create({ data: { businessId: A.business.id, fullName: "קיים", phoneE164: p, phoneRaw: p } });
    const res = await leadsRoute.POST(await req(A.session, "/api/leads", "POST", { contact: { fullName: "שם חדש", phone: p } }), ctx());
    expect(res.status).toBe(201);
    const body = (await res.json()).data;
    expect(body.contactId).toBe(existing.id); expect(body.contactReused).toMatchObject({ id: existing.id, fullName: "קיים" });
    expect((await db.contact.findUniqueOrThrow({ where: { id: existing.id } })).fullName).toBe("קיים");
    // Business B: the same phone is its own new contact (no cross-business match)
    const rb = await leadsRoute.POST(await req(B.session, "/api/leads", "POST", { contact: { fullName: "ב", phone: p } }), ctx());
    expect(rb.status).toBe(201);
    expect((await rb.json()).data.contactReused).toBeNull();
    expect(await db.contact.count({ where: { phoneE164: p } })).toBe(2);
  });

  it("validation: name and phone required, bad phone refused; the old contactId flow still works; agent permissions kept", async () => {
    expect((await leadsRoute.POST(await req(A.session, "/api/leads", "POST", { contact: { fullName: "", phone: phone() } }), ctx())).status).toBe(400);
    expect((await leadsRoute.POST(await req(A.session, "/api/leads", "POST", { contact: { fullName: "x", phone: "12" } }), ctx())).status).toBe(400);
    expect((await leadsRoute.POST(await req(A.session, "/api/leads", "POST", { notes: "בלי איש קשר" }), ctx())).status).toBe(400);
    const c = await db.contact.create({ data: { businessId: A.business.id, fullName: "ישן", phoneE164: phone(), phoneRaw: "x" } });
    expect((await leadsRoute.POST(await req(A.session, "/api/leads", "POST", { contactId: c.id, notes: "מהזרימה הישנה" }), ctx())).status).toBe(201);
    // An agent can't open a lead on a contact owned by someone else through a known phone number
    const p = phone();
    await db.contact.create({ data: { businessId: A.business.id, fullName: "של מנהל", phoneE164: p, phoneRaw: p, ownerUserId: manager.id } });
    const ra = await leadsRoute.POST(await req(agent, "/api/leads", "POST", { contact: { fullName: "x", phone: p } }), ctx());
    expect([403, 409]).toContain(ra.status);
  });
});
