import { afterAll, beforeAll, expect, it } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { cookieName, revalidateSession, signSession } from "@/lib/auth";
import { startSupportSession } from "@/lib/platform/support";
import { POST as endSupport } from "@/app/api/platform/support/end/route";
import { acceptInvite, inviteUser } from "@/server/services/invite-service";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";

let home: Awaited<ReturnType<typeof createBusiness>>;
let customer: Awaited<ReturnType<typeof createBusiness>>;
const accounts: string[] = [];
beforeAll(async () => {
  home = await createBusiness("security-support-home");
  customer = await createBusiness("security-support-customer");
  await db.account.update({ where: { id: home.account.id }, data: { isPlatformAdmin: true } });
});
afterAll(async () => {
  if (customer) await destroyBusiness(customer.business.id, [customer.account.id, ...accounts]);
  if (home) await destroyBusiness(home.business.id, [home.account.id]);
});
async function start() {
  const account = await db.account.findUniqueOrThrow({ where: { id: home.account.id } });
  return startSupportSession({ ...home.session, sessionVersion: account.sessionVersion }, customer.business.id, { reason: "Security regression test", minutes: 15 });
}
async function request(session: Parameters<typeof signSession>[0], origin = "http://localhost") {
  return new NextRequest("http://localhost/api/platform/support/end", { method: "POST", headers: { origin, cookie: `${cookieName}=${await signSession(session)}` } });
}
it("support exit rejects cross-origin requests without consuming the session", async () => {
  const s = await start();
  expect((await endSupport(await request(s.sessionUser, "https://evil.example"))).status).toBe(403);
  expect((await db.supportSession.findUniqueOrThrow({ where: { id: s.session.id } })).endedAt).toBeNull();
});
it("an ended support cookie cannot mint another account session", async () => {
  const s = await start();
  const first = await endSupport(await request(s.sessionUser));
  expect(first.status).toBe(200);
  expect(first.headers.get("set-cookie")).toContain(cookieName);
  const replay = await endSupport(await request(s.sessionUser));
  expect(replay.status).toBe(401);
  expect(replay.headers.get("set-cookie")).toBeNull();
});
it("expired support cookies cannot mint account sessions", async () => {
  const s = await start();
  await db.supportSession.update({ where: { id: s.session.id }, data: { expiresAt: new Date(0) } });
  expect((await endSupport(await request(s.sessionUser))).status).toBe(401);
});
it("password/session revocation ends support reads and prevents returning with a fresh cookie", async () => {
  const s = await start();
  await db.account.update({ where: { id: home.account.id }, data: { sessionVersion: { increment: 1 } } });
  await expect(revalidateSession(s.sessionUser)).rejects.toMatchObject({ status: 401 });
  expect((await endSupport(await request(s.sessionUser))).status).toBe(401);
  const fresh = await start();
  await expect(revalidateSession(fresh.sessionUser)).resolves.toMatchObject({ supportSessionId: fresh.session.id });
});
it("a disabled customer business ends support reads", async () => {
  const s = await start();
  await db.business.update({ where: { id: customer.business.id }, data: { isActive: false } });
  try { await expect(revalidateSession(s.sessionUser)).rejects.toMatchObject({ status: 401 }); }
  finally { await db.business.update({ where: { id: customer.business.id }, data: { isActive: true } }); }
});
it("concurrent invitation claims cannot overwrite the winning password", async () => {
  const invite = await withBusiness(customer.business.id, () => inviteUser(customer.business.id, customer.user.id, { email: `race-${Date.now()}@test.local`, fullName: "Race", role: "agent" }));
  const member = await db.user.findUniqueOrThrow({ where: { id: invite.id } });
  accounts.push(member.accountId);
  const token = invite.inviteUrl.split("/invite/")[1];
  const passwords = ["First-Strong-123!", "Second-Strong-123!"];
  const attempts = await Promise.allSettled(passwords.map(password => acceptInvite(token, password)));
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const winner = attempts.findIndex(r => r.status === "fulfilled");
  const account = await db.account.findUniqueOrThrow({ where: { id: member.accountId } });
  expect(account.sessionVersion).toBe(1);
  expect(await bcrypt.compare(passwords[winner], account.passwordHash)).toBe(true);
  expect(await bcrypt.compare(passwords[1 - winner], account.passwordHash)).toBe(false);
});

it("only one simultaneous support exit issues a cookie", async () => {
  const s = await start();
  const responses = await Promise.all([endSupport(await request(s.sessionUser)), endSupport(await request(s.sessionUser))]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
  expect(responses.filter(r => r.headers.has("set-cookie"))).toHaveLength(1);
});

it("different invitations to the same identity cannot both set its initial password", async () => {
  const email = `two-invites-${Date.now()}@test.local`;
  const first = await withBusiness(customer.business.id, () => inviteUser(customer.business.id, customer.user.id, { email, fullName: "Shared race", role: "agent" }));
  const second = await withBusiness(home.business.id, () => inviteUser(home.business.id, home.user.id, { email, fullName: "Shared race", role: "agent" }));
  const member = await db.user.findUniqueOrThrow({ where: { id: first.id } });
  accounts.push(member.accountId);
  const attempts = await Promise.allSettled([acceptInvite(first.inviteUrl.split("/invite/")[1], "First-Strong-123!"), acceptInvite(second.inviteUrl.split("/invite/")[1], "Second-Strong-123!")]);
  expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect((await db.account.findUniqueOrThrow({ where: { id: member.accountId } })).sessionVersion).toBe(1);
  await db.user.delete({ where: { id: second.id } });
});

it("revoked logout cookies cannot take the current user offline", async () => {
  const { POST: logout } = await import("@/app/api/auth/logout/route");
  await db.user.update({ where: { id: home.user.id }, data: { presence: "available" } });
  await db.account.update({ where: { id: home.account.id }, data: { sessionVersion: { increment: 1 } } });
  const r = await logout(new NextRequest("http://localhost/api/auth/logout", { method: "POST", headers: { cookie: `${cookieName}=${await signSession(home.session)}` } }));
  expect(r.status).toBe(200);
  expect((await db.user.findUniqueOrThrow({ where: { id: home.user.id } })).presence).toBe("available");
});

it("simultaneous password changes cannot overwrite the winning change", async () => {
  const { POST: changePassword } = await import("@/app/api/auth/password/route");
  const t = await createBusiness("password-race");
  try {
    const cookie = `${cookieName}=${await signSession(t.session)}`;
    const passwords = ["First-Strong-123!", "Second-Strong-123!"];
    const responses = await Promise.all(passwords.map(newPassword => changePassword(new NextRequest("http://localhost/api/auth/password", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "Test1234!", newPassword }) }))));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    const winner = responses.findIndex(r => r.status === 200);
    expect(responses[1 - winner].status).toBe(409);
    const account = await db.account.findUniqueOrThrow({ where: { id: t.account.id } });
    expect(account.sessionVersion).toBe(1);
    expect(await bcrypt.compare(passwords[winner], account.passwordHash)).toBe(true);
  } finally { await destroyBusiness(t.business.id, [t.account.id]); }
});

it("support logout revokes the server-side grant", async () => {
  const { POST: logout } = await import("@/app/api/auth/logout/route");
  const s = await start();
  const r = await logout(new NextRequest("http://localhost/api/auth/logout", { method: "POST", headers: { cookie: `${cookieName}=${await signSession(s.sessionUser)}` } }));
  expect(r.status).toBe(200);
  await expect(revalidateSession(s.sessionUser)).rejects.toMatchObject({ status: 401 });
});
