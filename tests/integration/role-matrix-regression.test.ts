/**
 * Cross-cutting permission regression after the recent change sets: owner / regular manager / agent / platform admin
 * against the server routes behind the newer screens (reports, journeys, sales coach, coach settings, contact
 * deletion, lead distribution, platform pricing). Owner-only data must not be reachable through the API either.
 * Nothing here sends, charges or deletes: owner calls that would act are made with invalid input on purpose.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const R = {
  reportsAgents: await import("@/app/api/reports/agents/route"),
  seqDraft: await import("@/app/api/sequences/draft/route"),
  coachRecordings: await import("@/app/api/coach/recordings/route"),
  coachInsights: await import("@/app/api/coach/insights/route"),
  settings: await import("@/app/api/settings/route"),
  distribution: await import("@/app/api/distribution/route"),
  bulkDelete: await import("@/app/api/contacts/bulk/delete/route"),
  statuses: await import("@/app/api/lead-statuses/route"),
  platformPlans: await import("@/app/api/platform/plans/route"),
  platformPricing: await import("@/app/api/platform/businesses/[id]/pricing/route"),
};

describe("role matrix (API)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let manager: SessionUser, agent: SessionUser, platform: SessionUser;
  const accounts: string[] = [];
  const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
  const req = async (user: SessionUser, url: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: `ultracrm_session=${await signSession(user)}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    a = await createBusiness("role-matrix", { modules: { crm: true, telephony: true, messaging: true } });
    const mk = async (role: "manager" | "agent", platformAdmin = false, template?: string) => {
      const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: role, passwordHash: "x", isPlatformAdmin: platformAdmin } }); accounts.push(acc.id);
      const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: role, role, ...(template ? { permissions: { template, scope: "team", modules: {} } } : {}) } });
      return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: role, role, teamId: null } as SessionUser;
    };
    manager = await mk("manager"); agent = await mk("agent"); platform = await mk("agent", true); // default permissions of each role
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); await db.account.deleteMany({ where: { id: { in: accounts } } }); });

  const status = async (fn: (r: NextRequest, c: ReturnType<typeof ctx>) => Promise<Response>, user: SessionUser, url: string, method = "GET", body?: unknown, p: Record<string, string> = {}) => (await fn(await req(user, url, method, body), ctx(p))).status;

  it("manager screens: owner + manager yes, agent no (reports, journeys, sales coach)", async () => {
    for (const u of [a.session, manager]) {
      expect(await status(R.reportsAgents.GET, u, "/api/reports/agents")).toBe(200);
      expect(await status(R.coachRecordings.GET, u, "/api/coach/recordings")).toBe(200);
      expect(await status(R.coachInsights.GET, u, "/api/coach/insights")).toBe(200);
      expect(await status(R.seqDraft.POST, u, "/api/sequences/draft", "POST", { name: "טיוטה", trigger: "CONTACT_CREATED", steps: [] })).toBe(200);
    }
    expect(await status(R.reportsAgents.GET, agent, "/api/reports/agents")).toBe(403);
    expect(await status(R.coachRecordings.GET, agent, "/api/coach/recordings")).toBe(403);
    expect(await status(R.coachInsights.GET, agent, "/api/coach/insights")).toBe(403);
    expect(await status(R.seqDraft.POST, agent, "/api/sequences/draft", "POST", { name: "x", trigger: "CONTACT_CREATED", steps: [] })).toBe(403);
  });

  it("owner-only: business settings (incl. the coach's auto-learning), lead distribution, statuses structure, contact deletion", async () => {
    for (const u of [manager, agent]) {
      expect(await status(R.settings.PATCH, u, "/api/settings", "PATCH", { settings: { coach: { learnFromRecordings: true } } })).toBe(403);
      expect(await status(R.distribution.GET, u, "/api/distribution")).toBe(403);
      expect(await status(R.statuses.POST, u, "/api/lead-statuses", "POST", { label: "חדש-בדיקה", kind: "contacted" })).toBe(403);
      expect(await status(R.bulkDelete.POST, u, "/api/contacts/bulk/delete", "POST", { selection: { ids: ["x"] }, confirm: "1" })).toBe(403);
    }
    expect((await db.business.findUniqueOrThrow({ where: { id: a.business.id } })).settings).not.toMatchObject({ coach: { learnFromRecordings: true } });
    expect(await status(R.distribution.GET, a.session, "/api/distribution")).toBe(200);
    // the owner passes the permission check; the wrong confirmation stops the action (nothing is deleted)
    expect(await status(R.bulkDelete.POST, a.session, "/api/contacts/bulk/delete", "POST", { selection: { ids: ["nope"] }, confirm: "999" })).not.toBe(403);
  });

  it("platform administration: only a platform admin – not the business owner", async () => {
    expect(await status(R.platformPlans.GET, a.session, "/api/platform/plans")).toBe(403);
    expect(await status(R.platformPricing.GET, a.session, `/api/platform/businesses/${a.business.id}/pricing`, "GET", undefined, { id: a.business.id })).toBe(403);
    expect(await status(R.platformPlans.GET, platform, "/api/platform/plans")).toBe(200);
    expect(await status(R.platformPricing.GET, platform, `/api/platform/businesses/${a.business.id}/pricing`, "GET", undefined, { id: a.business.id })).toBe(200);
  });
});
