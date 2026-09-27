/**
 * Packages & permissions on the real DB: business entitlement ∩ user permission, enforced in the API, the AI
 * assistant and background work. Covers: other business's data; module not purchased (API + AI); action denied
 * inside an accessible module; revocation for an already logged-in user and for scheduled work; seats under
 * concurrent assignment; data kept after a downgrade and no automatic re-grant; no self-escalation; platform-only
 * operations; the safe migration of existing users (role-derived, not "everything").
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { effectiveAccess, invalidateEntitlement, businessEntitlement } = await import("@/lib/access/engine");
const { setUserPermissions, computeImpact, applyEntitlementChange } = await import("@/lib/access/manage");
const { toolsFor, runAiTool } = await import("@/server/ai/tools");
const { buildCtx } = await import("@/server/ai/engine");
const { processDueCampaigns } = await import("@/jobs/campaign-runner");
const { GET: leadsGET, POST: leadsPOST } = await import("@/app/api/leads/route");
const { GET: exportGET } = await import("@/app/api/contacts/export/route");
const { GET: convGET } = await import("@/app/api/conversations/route");
const { GET: plansGET } = await import("@/app/api/platform/plans/route");
const { PUT: accessPUT } = await import("@/app/api/access/users/[id]/route");
const { GET: planGET } = await import("@/app/api/settings/plan/route");

let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser, manager: SessionUser, agent1: SessionUser, agent2: SessionUser, agent3: SessionUser, ownerB: SessionUser, platform: SessionUser;
const accounts: string[] = []; let planId = ""; let vFull = ""; let vCrmOnly = ""; let vTwoSeats = "";
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const req = async (u: SessionUser, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(u)}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const code = async (r: Response) => ({ status: r.status, code: ((await r.json().catch(() => ({}))) as { code?: string }).code });
const all = { enabled: true };
const perms = (mods: Record<string, string[]>, scope = "own") => ({ template: "custom", scope, modules: Object.fromEntries(Object.entries(mods).map(([m, actions]) => [m, { ...all, actions }])) });
const pin = async (versionId: string) => { await db.business.update({ where: { id: a.business.id }, data: { planVersionId: versionId, planId } }); invalidateEntitlement(a.business.id); };

describe("packages & permissions", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    a = await createBusiness("acc-a", { modules: { crm: true, telephony: true, messaging: true } });
    b = await createBusiness("acc-b", { modules: { crm: true } });
    accounts.push(a.account.id, b.account.id); owner = a.session; ownerB = b.session;
    const mk = async (name: string, role: "agent" | "manager") => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser; };
    manager = await mk("מנהלת", "manager"); agent1 = await mk("נציג 1", "agent"); agent2 = await mk("נציג 2", "agent"); agent3 = await mk("נציג 3", "agent");
    // platform admin = a separate account (member of business B only)
    const pa = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "פלטפורמה", passwordHash: "x", isPlatformAdmin: true } }); accounts.push(pa.id);
    const pu = await db.user.create({ data: { businessId: b.business.id, accountId: pa.id, email: pa.email, fullName: "פלטפורמה", role: "manager" } });
    platform = { id: pu.id, accountId: pa.id, businessId: b.business.id, email: pa.email, fullName: "פלטפורמה", role: "manager", teamId: null };
    const plan = await db.plan.create({ data: { key: `test_${crypto.randomUUID().slice(0, 8)}`, name: "חבילת בדיקה", currentVersion: 3 } }); planId = plan.id;
    const v = (version: number, modules: Record<string, { included: boolean; seats: number | null }>) => db.planVersion.create({ data: { planId, version, name: "חבילת בדיקה", modules, quotas: {} } });
    vFull = (await v(1, { crm: { included: true, seats: null }, telephony: { included: true, seats: null }, whatsapp: { included: true, seats: null }, sms: { included: true, seats: null }, email: { included: true, seats: null } })).id;
    vCrmOnly = (await v(2, { crm: { included: true, seats: null } })).id;
    vTwoSeats = (await v(3, { crm: { included: true, seats: 3 }, sms: { included: true, seats: null } })).id;
    await pin(vFull);
  }, 900_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); if (planId) await db.plan.delete({ where: { id: planId } }).catch(() => undefined); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("migration: users without explicit permissions keep what they had by role – agents get no campaign modules; the owner always has everything in the package", async () => {
    const ag = await effectiveAccess(a.business.id, agent1.id);
    expect(ag).toMatchObject({ derived: true, scope: "own" });
    expect(ag.modules.crm).toMatchObject({ state: "active" }); expect(ag.modules.crm.actions).not.toContain("export");
    expect(ag.modules.sms.state).toBe("not_assigned"); expect(ag.modules.email.state).toBe("not_assigned");
    const mg = await effectiveAccess(a.business.id, manager.id);
    expect(mg.modules.sms.actions).toContain("send"); expect(mg.scope).toBe("business");
    expect((await effectiveAccess(a.business.id, owner.id)).modules.email.actions).toEqual(expect.arrayContaining(["view", "draft", "send"]));
  });

  it("another business's data and platform operations are refused; a business cannot change its own package", async () => {
    await db.lead.create({ data: { businessId: a.business.id, contactId: (await db.contact.create({ data: { businessId: a.business.id, fullName: "ליד א", phoneE164: "+972501110001", phoneRaw: "x" } })).id } });
    const bLeads = (await (await leadsGET(await req(ownerB, "/api/leads?period=all"), ctx())).json()).data.items;
    expect(bLeads.some((l: { contact: { fullName: string } }) => l.contact.fullName === "ליד א")).toBe(false);
    expect((await plansGET(await req(owner, "/api/platform/plans"), ctx() as never)).status).toBe(403);
    expect((await plansGET(await req(platform, "/api/platform/plans"), ctx() as never)).status).toBe(200);
    const planRoute = await import("@/app/api/settings/plan/route");
    expect("PATCH" in planRoute).toBe(false);
    expect((await planGET(await req(owner, "/api/settings/plan"), ctx() as never)).status).toBe(200);
  });

  it("a module not in the package is refused in the API and in the AI assistant", async () => {
    await pin(vCrmOnly);
    expect(await code(await convGET(await req(owner, "/api/conversations")))).toMatchObject({ status: 403, code: "module_not_purchased" });
    expect((await leadsGET(await req(owner, "/api/leads?period=all"), ctx())).status).toBe(200);
    const aiCtx = (await run(owner, () => buildCtx(owner, "app", null))).ctx;
    const names = toolsFor(aiCtx).map((t) => t.name);
    expect(names).toContain("find_lead"); expect(names).not.toContain("diagnose_messaging"); expect(names).not.toContain("list_automations"); expect(names).not.toContain("calls_summary");
    expect(await run(owner, () => runAiTool(aiCtx, "diagnose_messaging", { leadId: "x" }))).toMatchObject({ ok: false, code: "forbidden" });
    await pin(vFull);
  });

  it("an action that is not allowed is refused inside an accessible module; the change applies to an already logged-in user", async () => {
    await run(owner, () => setUserPermissions(owner, agent1.id, perms({ crm: ["view"] })));
    const cookieReq = (url: string, method = "GET", body?: unknown) => req(agent1, url, method, body); // same session all along
    expect((await leadsGET(await cookieReq("/api/leads?period=all"), ctx())).status).toBe(200);
    expect(await code(await leadsPOST(await cookieReq("/api/leads", "POST", { contactId: "x" }), ctx()))).toMatchObject({ status: 403, code: "action_denied" });
    expect(await code(await exportGET(await cookieReq("/api/contacts/export"), ctx()))).toMatchObject({ status: 403, code: "action_denied" });
    expect(await code(await convGET(await cookieReq("/api/conversations")))).toMatchObject({ status: 403, code: "module_not_assigned" });
    await run(owner, () => setUserPermissions(owner, agent1.id, perms({ crm: [] }, "own")));
    await run(owner, () => setUserPermissions(owner, agent1.id, { template: "custom", scope: "own", modules: { crm: { enabled: false, actions: ["view"] } } }));
    expect(await code(await leadsGET(await cookieReq("/api/leads?period=all"), ctx()))).toMatchObject({ status: 403, code: "module_not_assigned" });
  });

  it("no self-escalation: nobody edits themselves; a manager cannot grant actions / scope they lack or edit managers; agents cannot manage permissions", async () => {
    await expect(run(manager, () => setUserPermissions(manager, manager.id, perms({ crm: ["view"] })))).rejects.toMatchObject({ code: "self_escalation" });
    await expect(run(owner, () => setUserPermissions(owner, owner.id, perms({ crm: ["view"] })))).rejects.toMatchObject({ code: "self_escalation" });
    // The manager leads a team that includes agent 2 (a team-scoped manager may only edit agents of their team).
    const team = await db.team.create({ data: { businessId: a.business.id, name: "צוות בדיקה", managerId: manager.id } });
    await db.user.update({ where: { id: agent2.id }, data: { teamId: team.id } });
    await run(owner, () => setUserPermissions(owner, manager.id, perms({ crm: ["view", "edit"] }, "team")));
    await expect(run(manager, () => setUserPermissions(manager, agent3.id, perms({ crm: ["view"] })))).rejects.toMatchObject({ code: "forbidden" }); // not in the team
    await expect(run(manager, () => setUserPermissions(manager, agent2.id, perms({ crm: ["view", "export"] })))).rejects.toMatchObject({ code: "self_escalation" });
    await expect(run(manager, () => setUserPermissions(manager, agent2.id, perms({ crm: ["view"] }, "business")))).rejects.toMatchObject({ code: "self_escalation" });
    expect((await accessPUT(await req(agent2, `/api/access/users/${agent3.id}`, "PUT", perms({ crm: ["view"] })), ctx({ id: agent3.id }))).status).toBe(403);
    await expect(run(owner, () => setUserPermissions(owner, agent2.id, perms({ crm: ["view", "delete"] })))).rejects.toMatchObject({ code: "unknown_action" });
    await run(owner, () => setUserPermissions(owner, manager.id, perms({ crm: ["view", "create", "edit", "export", "transfer"], telephony: ["use", "personal_settings", "team_settings", "recordings"], whatsapp: ["view", "reply", "assign", "automations", "campaign_draft", "campaign_send"], sms: ["view", "draft", "send"], email: ["view", "draft", "send"] }, "business")));
  });

  it("seats: parallel assignments never exceed the package; a module outside the package cannot be assigned", async () => {
    await pin(vTwoSeats); // crm: 3 seats – the owner holds one
    for (const u of [manager, agent1, agent2, agent3]) await db.user.update({ where: { id: u.id }, data: { permissions: { template: "custom", scope: "own", modules: {} } } });
    const results = await Promise.allSettled([agent1, agent2, agent3].map((u) => run(owner, () => setUserPermissions(owner, u.id, perms({ crm: ["view"] })))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["no_seats"]);
    await expect(run(owner, () => setUserPermissions(owner, agent3.id, perms({ telephony: ["use"] })))).rejects.toMatchObject({ code: "module_not_purchased" });
  });

  it("downgrade: impact preview, explicit choice on seat overflow, data kept, running campaigns paused, no automatic re-grant", async () => {
    await pin(vFull);
    for (const u of [agent1, agent2, agent3]) await run(owner, () => setUserPermissions(owner, u.id, perms({ crm: ["view"], sms: ["view", "draft", "send"] })));
    const leadsBefore = await db.lead.count({ where: { businessId: a.business.id } });
    const list = await db.distributionList.create({ data: { businessId: a.business.id, name: "קהל בדיקה" } as never });
    const tpl = await db.template.create({ data: { businessId: a.business.id, channel: "sms", name: `sms_${crypto.randomUUID().slice(0, 6)}`, body: "שלום", status: "APPROVED" } });
    // Scheduled for later: shown in the impact (the shared DB's production workers never touch a future schedule).
    const campaign = await db.campaign.create({ data: { businessId: a.business.id, name: "SMS מתוזמן", channel: "sms", status: "SCHEDULED", scheduledAt: new Date(Date.now() + 7 * 86400_000), createdById: owner.id, listId: (list as { id: string }).id, templateId: tpl.id } });
    // v2 = CRM only: sms / whatsapp / email / telephony removed
    const { impact } = await computeImpact(a.business.id, { planVersionId: vCrmOnly });
    expect(impact.modulesRemoved).toEqual(expect.arrayContaining(["sms", "telephony", "whatsapp", "email"]));
    expect(impact.usersLosing.sms.map((u) => u.id)).toEqual(expect.arrayContaining([agent1.id, agent2.id, agent3.id]));
    expect(impact.campaigns.map((c) => c.id)).toContain(campaign.id);
    await expect(applyEntitlementChange(owner, a.business.id, { planVersionId: vCrmOnly })).rejects.toMatchObject({ status: 403 }); // not a platform admin
    await applyEntitlementChange(platform, a.business.id, { planVersionId: vCrmOnly });
    expect(await db.lead.count({ where: { businessId: a.business.id } })).toBe(leadsBefore);
    // A running campaign on a channel that left the package is paused by the worker (checked right before sending).
    const running = await db.campaign.create({ data: { businessId: a.business.id, name: "SMS רץ", channel: "sms", status: "RUNNING", createdById: owner.id, listId: (list as { id: string }).id, templateId: tpl.id } });
    await run(owner, () => processDueCampaigns(Date.now() + 5_000));
    expect(await db.campaign.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ status: "PAUSED", statusReason: "הערוץ אינו כלול כעת בחבילה של העסק" });
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: "SCHEDULED" }); // kept, not deleted
    // buying SMS again does not re-open it for users by itself
    await applyEntitlementChange(platform, a.business.id, { addGrant: { module: "sms", kind: "addon", seats: null, expiresAt: null } });
    expect((await effectiveAccess(a.business.id, agent1.id)).modules.sms.state).toBe("not_assigned");
    // seat overflow requires an explicit choice of who keeps the module
    await pin(vFull);
    const overflow = await computeImpact(a.business.id, { planVersionId: vTwoSeats });
    expect(overflow.impact.seatOverflow.crm.holders.length).toBeGreaterThan(3);
    await expect(applyEntitlementChange(platform, a.business.id, { planVersionId: vTwoSeats })).rejects.toMatchObject({ code: "seat_choice_required" });
    await applyEntitlementChange(platform, a.business.id, { planVersionId: vTwoSeats }, { crm: [owner.id, agent1.id] });
    expect((await effectiveAccess(a.business.id, agent1.id)).modules.crm.state).toBe("active");
    expect((await effectiveAccess(a.business.id, agent2.id)).modules.crm.state).toBe("not_assigned");
  });

  it("trial expiry and suspension block access without deleting anything", async () => {
    await db.business.update({ where: { id: a.business.id }, data: { accessStatus: "trial", accessUntil: new Date(Date.now() - 60_000) } }); invalidateEntitlement(a.business.id);
    expect((await businessEntitlement(a.business.id)).suspended).toBe(true);
    expect(await code(await leadsGET(await req(owner, "/api/leads?period=all"), ctx()))).toMatchObject({ status: 403, code: "business_suspended" });
    await db.business.update({ where: { id: a.business.id }, data: { accessStatus: "active", accessUntil: null } }); invalidateEntitlement(a.business.id);
    expect((await leadsGET(await req(owner, "/api/leads?period=all"), ctx())).status).toBe(200);
  });
});
