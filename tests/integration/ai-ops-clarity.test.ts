/**
 * "מנהל AI" page (real DB): the two switches save and survive a reload (settings read back), agents cannot change
 * them; "השפעה נמדדת" reports observed numbers for the allocated leads and a comparison with the same unit (the
 * agent's leads in the 14 days before), with small samples flagged; the removed diagnostics actions are gone.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { createBusiness, destroyBusiness } from "./helpers";
import { PATCH as settingsPATCH } from "@/app/api/ops/settings/route";
import { opsOverview } from "@/server/ops/overview";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz; let agent: SessionUser;
const accounts: string[] = [];
const req = async (u: SessionUser, body: unknown) => new NextRequest("http://localhost/api/ops/settings", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost", cookie: `ultracrm_session=${await signSession(u)}` } });
const patch = (u: SessionUser, body: unknown) => withBusiness(u.businessId, async () => settingsPATCH(await req(u, body), { params: Promise.resolve({}) }), u);

describe("AI Manager page", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("ai-ops", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(A.account.id);
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "נציגה", passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: "נציגה", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: "נציגה", role: "agent", teamId: null };
  }, 300_000);
  afterAll(async () => { await destroyBusiness(A.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("switches: one PATCH per change, saved, read back after a reload; agents are refused", async () => {
    for (const value of [true, false, true]) {
      const r = await patch(A.session, { enabled: value });
      expect(r.status).toBe(200);
      expect((await r.json()).data.enabled).toBe(value);
      expect((await getBusinessSettings(A.business.id)).aiOps.enabled).toBe(value);
    }
    const w = await patch(A.session, { notifyWhatsApp: true });
    expect((await w.json()).data).toMatchObject({ notifyWhatsApp: true, enabled: true }); // the other switch untouched
    expect((await getBusinessSettings(A.business.id)).aiOps.notifyWhatsApp).toBe(true);
    const denied = await patch(agent, { enabled: false });
    expect(denied.status).toBe(403);
    expect((await getBusinessSettings(A.business.id)).aiOps.enabled).toBe(true);
  });

  it("impact: observed numbers for allocated leads, comparison with the agent's leads of the 14 days before", async () => {
    const at = new Date(Date.now() - 3 * 86400_000);
    const mkContact = () => { const p = `+9725${String(Date.now() % 10000000).padStart(7, "0")}${Math.floor(Math.random() * 10)}`.slice(0, 13); return db.contact.create({ data: { businessId: A.business.id, fullName: "Imp", phoneE164: `${p}${crypto.randomInt(10, 99)}`.slice(0, 13), phoneRaw: "x", ownerUserId: agent.id } }); };
    // Before the allocation: 4 leads of the agent, 1 closed before it started.
    for (let i = 0; i < 4; i++) {
      const c = await mkContact();
      await db.lead.create({ data: { businessId: A.business.id, contactId: c.id, ownerUserId: agent.id, createdAt: new Date(at.getTime() - (i + 1) * 86400_000) } });
      if (i === 0) await db.deal.create({ data: { businessId: A.business.id, contactId: c.id, title: "d", status: "won", stage: "won", closedAt: new Date(at.getTime() - 3600_000), ownerUserId: agent.id } });
    }
    const rec = await db.opsRecommendation.create({ data: { businessId: A.business.id, kind: "momentum", status: "active", agentId: agent.id, code: "1234", title: "t", explanation: "e", evidence: {}, proposal: { mode: "extra", count: 3 }, dedupeKey: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400_000), managerApprovedCount: 3, createdAt: at } });
    // 3 leads allocated under it: 2 dialed, 1 closed.
    for (let i = 0; i < 3; i++) {
      const c = await mkContact();
      const l = await db.lead.create({ data: { businessId: A.business.id, contactId: c.id, ownerUserId: agent.id, createdAt: new Date(at.getTime() + 3600_000) } });
      await db.auditLog.create({ data: { businessId: A.business.id, action: "ai_ops.lead_allocated", entityType: "lead", entityId: l.id, payload: { recommendationId: rec.id } } });
      if (i < 2) await db.call.create({ data: { businessId: A.business.id, userId: agent.id, contactId: c.id, direction: "outbound", mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "+97230000000", status: "ended", leadDialedAt: new Date(), endedAt: new Date() } });
      if (i === 0) await db.deal.create({ data: { businessId: A.business.id, contactId: c.id, title: "d", status: "won", stage: "won", closedAt: new Date(), ownerUserId: agent.id } });
    }
    const o = await withBusiness(A.business.id, () => opsOverview(A.session), A.session);
    const row = o.impact.find((i) => i.id === rec.id)!;
    expect(row).toMatchObject({ allocated: 3, dialed: 2, won: 1, approved: 3, smallSample: true, compareSmall: true, until: null });
    expect(row.compare).toMatchObject({ leads: 4, won: 1 });
    expect(row.compare!.to.getTime()).toBe(at.getTime());
  });

  it("the removed diagnostics actions are not offered any more (UI panel, API route, AI tool)", async () => {
    const fs = await import("node:fs");
    expect(fs.existsSync("src/components/sales/SalesDiagnostics.tsx")).toBe(false);
    expect(fs.existsSync("src/app/api/sales/diagnostics/route.ts")).toBe(false);
    expect(fs.readFileSync("src/server/ai/tools.ts", "utf8")).not.toContain("sales_diagnostics");
    expect(fs.readFileSync("src/components/reports/AgentPerformance.tsx", "utf8")).not.toContain("SalesDiagnostics");
  });
});
