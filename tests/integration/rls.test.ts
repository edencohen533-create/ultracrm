/**
 * Database-level row-level security + session invalidation (real isolated DB).
 * Proves that inside a business scope even the *unscoped* client (no Prisma filter) cannot read or write
 * another business's rows, that no-scope code paths keep owner access, and that a password change
 * invalidates previously issued sessions.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db, prisma } from "@/lib/db";
import { withBusiness, withoutBusiness } from "@/lib/tenant";
import { signSession, revalidateSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { POST: changePassword } = await import("@/app/api/auth/password/route");
const { createContact } = await import("@/lib/crm/contacts");

const run = <T,>(s: SessionUser, fn: () => Promise<T>) => withBusiness(s.businessId, fn, s);

describe("PostgreSQL row-level security (ultracrm_runtime)", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  let contactA: string; let contactB: string;

  beforeAll(async () => {
    for (const stale of await db.business.findMany({ where: { slug: { startsWith: "test-rls-" } }, select: { id: true } })) await destroyBusiness(stale.id);
    await db.account.deleteMany({ where: { email: { startsWith: "test-rls-" } } });
    a = await createBusiness("rls-a"); b = await createBusiness("rls-b");
    contactA = (await run(a.session, () => createContact(a.session, { fullName: "A לקוח", phone: "0501110001" }))).id;
    contactB = (await run(b.session, () => createContact(b.session, { fullName: "B לקוח", phone: "0501110002" }))).id;
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); await destroyBusiness(b.business.id, [b.account.id]); });

  it("policy is active on every business-owned table and the runtime role cannot bypass it", async () => {
    const rows = await db.$queryRaw<Array<{ tablename: string; rowsecurity: boolean }>>`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('contacts','messages','conversations','campaigns','users','audit_logs')`;
    expect(rows.length).toBe(6); expect(rows.every((r) => r.rowsecurity)).toBe(true);
    const role = await db.$queryRaw<Array<{ rolbypassrls: boolean; rolcanlogin: boolean }>>`SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'ultracrm_runtime'`;
    expect(role).toEqual([{ rolbypassrls: false, rolcanlogin: false }]);
  });

  it("every table with a business_id column has RLS enabled and the connection user can assume the runtime role", async () => {
    const missing = await db.$queryRaw<Array<{ table_name: string }>>`SELECT c.table_name FROM information_schema.columns c JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = 'public' WHERE c.table_schema = 'public' AND c.column_name = 'business_id' AND NOT t.rowsecurity`;
    expect(missing).toEqual([]);
    const child = await db.$queryRaw<Array<{ tablename: string; rowsecurity: boolean }>>`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('campaign_recipients','contact_tags','conversation_tags','dial_list_agents','distribution_list_members','message_attachments','sequence_steps','accounts','businesses')`;
    expect(child.length).toBe(9); expect(child.every((r) => r.rowsecurity)).toBe(true);
    const member = await db.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_has_role(current_user, 'ultracrm_runtime', 'MEMBER') AS ok`;
    expect(member).toEqual([{ ok: true }]);
  });

  it("identity tables: inside a scope the runtime role sees only its own account and the businesses it belongs to", async () => {
    await run(a.session, async () => {
      expect(await db.account.count({ where: { id: b.account.id } })).toBe(0);
      expect(await db.account.count({ where: { id: a.account.id } })).toBe(1);
      expect(await db.business.count({ where: { id: b.business.id } })).toBe(0);
      expect(await db.business.count({ where: { id: a.business.id } })).toBe(1);
      expect(await withoutBusiness(() => db.account.count({ where: { id: b.account.id } }))).toBe(1);
    });
  });

  it("inside business A the unscoped client sees only A's rows – reads, counts, unique lookups and raw SQL", async () => {
    await run(a.session, async () => {
      expect(await db.contact.count()).toBe(1);
      expect((await db.contact.findMany()).map((c) => c.id)).toEqual([contactA]);
      expect(await db.contact.findUnique({ where: { id: contactB } })).toBeNull();
      const raw = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM contacts`;
      expect(raw.map((r) => r.id)).toEqual([contactA]);
      // Explicit transactions get the same context.
      const inTx = await db.$transaction(async (tx) => tx.contact.count());
      expect(inTx).toBe(1);
    });
  });

  it("cross-tenant writes are rejected by the database even when the application filter is missing", async () => {
    await run(a.session, async () => {
      // Update of B's row: no row matches under the policy → Prisma reports "not found" instead of touching it.
      await expect(db.contact.update({ where: { id: contactB }, data: { fullName: "hacked" } })).rejects.toThrow();
      // Insert claiming to belong to B while scoped to A → WITH CHECK violation.
      await expect(db.contact.create({ data: { businessId: b.business.id, fullName: "smuggled", phoneE164: "+972501110009", phoneRaw: "0501110009" } })).rejects.toThrow(/row-level security|policy/i);
      await expect(db.$executeRaw`UPDATE contacts SET full_name = 'hacked' WHERE id = ${contactB}`).resolves.toBe(0);
    });
    expect((await db.contact.findUniqueOrThrow({ where: { id: contactB } })).fullName).toBe("B לקוח");
    expect(await db.contact.count({ where: { fullName: "smuggled" } })).toBe(0);
  });

  it("no-scope paths (login, cron enumeration) keep owner access; withoutBusiness escapes a scope for identity reads", async () => {
    expect(await db.contact.count({ where: { id: { in: [contactA, contactB] } } })).toBe(2);
    await run(a.session, async () => {
      expect(await db.user.count({ where: { accountId: b.account.id } })).toBe(0); // B's membership invisible to A
      expect(await withoutBusiness(() => db.user.count({ where: { accountId: b.account.id } }))).toBe(1);
      // The signed-in account can list its own memberships (business switcher) while scoped.
      expect(await db.user.count({ where: { accountId: a.account.id } })).toBe(1);
    });
    // The scoped client still adds the application filter on top (belt and braces).
    await run(b.session, async () => { expect(await prisma.contact.count()).toBe(1); });
  });
});

describe("session invalidation on password change", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  beforeAll(async () => { a = await createBusiness("rls-pw"); });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); });

  it("rejects the old token after a self-service change, keeps the re-issued one, and requires the current password", async () => {
    const old = { ...a.session, sessionVersion: 0 };
    await expect(revalidateSession(old)).resolves.toMatchObject({ id: a.user.id });
    const token = await signSession(old);
    const req = (body: unknown) => new NextRequest("http://localhost/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json", cookie: `ultracrm_session=${token}` }, body: JSON.stringify(body) });
    expect((await changePassword(req({ currentPassword: "wrong-pass-1", newPassword: "N3wPassword!" }))).status).toBe(403);
    const res = await changePassword(req({ currentPassword: "Test1234!", newPassword: "N3wPassword!" }));
    expect(res.status).toBe(200);
    await expect(revalidateSession(old)).rejects.toMatchObject({ status: 401 });
    const fresh = res.headers.get("set-cookie");
    expect(fresh).toMatch(/ultracrm_session=/);
    await expect(revalidateSession({ ...old, sessionVersion: 1 })).resolves.toMatchObject({ id: a.user.id });
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "account.password_changed" } })).toBe(1);
  });
});
