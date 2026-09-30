/**
 * Call-center reliability under load (real Postgres, SIMULATED telephony – nobody is called):
 *  • N agents claiming "next lead" at the same moment, several rounds → no lead ever handed to two agents;
 *  • two agents dialing the same person at the same moment → exactly one call;
 *  • a dial whose provider result is unknown (timeout) blocks another dial to that person until it is settled;
 *  • an expired lock (browser closed / worker died) returns the lead to the queue – once.
 * Prints concurrency, latency (p50 / p95 / max) and failure counts (the numbers quoted in docs/SAAS_READINESS.md).
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { claimNextLead } from "@/lib/dialer/queue";
import { startCall } from "@/lib/dialer/calls";

const AGENTS = Number(process.env.LOAD_AGENTS ?? 25); const LEADS = Number(process.env.LOAD_LEADS ?? 120); const ROUNDS = 4;
let A: Awaited<ReturnType<typeof createBusiness>>; const agents: SessionUser[] = []; const accounts: string[] = []; let listId = "";
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

describe("call-center load (simulated providers)", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("load-cc", { modules: { crm: true, telephony: true } }); accounts.push(A.account.id);
    await db.phoneNumber.create({ data: { businessId: A.business.id, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "mock" } });
    listId = (await db.dialList.create({ data: { businessId: A.business.id, name: "load" } as never })).id;
    for (let i = 0; i < AGENTS; i++) {
      const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: `סוכן ${i}`, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
      const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: `סוכן ${i}`, role: "agent" } });
      agents.push({ id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: u.fullName, role: "agent", teamId: null });
    }
    // Unowned leads, no open CRM lead → any agent may take them (the queue decides who).
    const contacts = await Promise.all(Array.from({ length: LEADS }, (_, i) => db.contact.create({ data: { businessId: A.business.id, fullName: `ליד ${i}`, phoneE164: `+97253${String(1000000 + i)}`, phoneRaw: "x" } })));
    await db.listLead.createMany({ data: contacts.map((c) => ({ businessId: A.business.id, listId, contactId: c.id })) });
  }, 600_000);
  afterAll(async () => { if (A) { await db.call.deleteMany({ where: { businessId: A.business.id } }); await destroyBusiness(A.business.id).catch(() => undefined); } await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it(`${AGENTS} agents claim at the same moment, ${ROUNDS} rounds: never the same lead twice`, async () => {
    const latencies: number[] = []; let errors = 0; const claimed: string[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const res = await Promise.all(agents.map(async (a) => { const t0 = performance.now(); try { const l = await run(a, () => claimNextLead(A.business.id, a.id, listId)); latencies.push(performance.now() - t0); return l; } catch { errors++; return null; } }));
      for (const l of res) if (l) claimed.push(l.id);
      // Release (as "no answer" would) so the next round claims other leads.
      await db.listLead.updateMany({ where: { listId, status: "locked" }, data: { status: "completed", lockedByUserId: null } });
    }
    const unique = new Set(claimed).size;
    console.log(`[load] claims: agents=${AGENTS} rounds=${ROUNDS} attempts=${AGENTS * ROUNDS} claimed=${claimed.length} unique=${unique} errors=${errors} p50=${pct(latencies, 50).toFixed(0)}ms p95=${pct(latencies, 95).toFixed(0)}ms max=${Math.max(...latencies).toFixed(0)}ms`);
    expect(unique).toBe(claimed.length);
    expect(errors).toBe(0);
  });

  it("two agents dialing the same person at the same moment → exactly one call", async () => {
    const c = await db.contact.create({ data: { businessId: A.business.id, fullName: "מרוץ", phoneE164: "+972539999991", phoneRaw: "x" } });
    const t0 = performance.now();
    const res = await Promise.allSettled(agents.slice(0, 10).map((a) => run(a, () => startCall(a, { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: c.id }))));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    console.log(`[load] same-contact race: 10 agents → ${ok} call(s) in ${(performance.now() - t0).toFixed(0)}ms`);
    expect(ok).toBe(1);
    expect(await db.call.count({ where: { businessId: A.business.id, contactId: c.id } })).toBe(1);
  });

  it("unknown provider result blocks a new dial to that person until settled", async () => {
    const c = await db.contact.create({ data: { businessId: A.business.id, fullName: "לא ידוע", phoneE164: "+972539999992", phoneRaw: "x" } });
    // A dial whose request timed out: not ended, result unknown (dialPendingSince set).
    await db.call.create({ data: { businessId: A.business.id, userId: agents[11].id, contactId: c.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "+97230000000", status: "created", dialPendingSince: new Date() } as never });
    await expect(run(agents[12], () => startCall(agents[12], { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: c.id }))).rejects.toMatchObject({ status: 409 });
  });

  it("an expired lock (browser closed / worker died) returns the lead to the queue – to one agent", async () => {
    const l = await db.listLead.findFirstOrThrow({ where: { listId, status: "pending" } });
    await db.listLead.update({ where: { id: l.id }, data: { status: "locked", lockedByUserId: agents[0].id, lockExpiresAt: new Date(Date.now() - 1000), lockToken: "old" } as never });
    await db.listLead.updateMany({ where: { listId, status: "pending", NOT: { id: l.id } }, data: { status: "completed" } });
    const res = await Promise.all(agents.slice(1, 8).map((a) => run(a, () => claimNextLead(A.business.id, a.id, listId))));
    const got = res.filter((x) => x?.id === l.id);
    expect(got).toHaveLength(1);
  });
});
