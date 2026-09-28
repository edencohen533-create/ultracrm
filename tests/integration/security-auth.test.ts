import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createBusiness, destroyBusiness } from "./helpers";
import { signSession, cookieName } from "@/lib/auth";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as createContact } from "@/app/api/contacts/route";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
let tenant: Awaited<ReturnType<typeof createBusiness>>;
beforeAll(async () => { tenant = await createBusiness("security-auth"); });
afterAll(async () => { vi.unstubAllEnvs(); if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id]); });
const request = (path: string, data: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
it("never authenticates quick-login requests, even when legacy flags exist", async () => {
  vi.stubEnv("QUICK_LOGIN_EMAIL", tenant.account.email);
  vi.stubEnv("NEXT_PUBLIC_QUICK_LOGIN", "1");
  const response = await login(request("/api/auth/login", { quick: true }));
  expect(response.status).toBe(400);
  expect(response.headers.get("set-cookie")).toBeNull();
  const wrong = await login(request("/api/auth/login", { quick: true, email: tenant.account.email, password: "incorrect" }));
  expect(wrong.status).toBe(401);
});
it("rejects cross-origin login and logout", async () => {
  expect((await login(request("/api/auth/login", { email: tenant.account.email, password: "Test1234!" }, { origin: "https://evil.example" }))).status).toBe(403);
  expect((await logout(request("/api/auth/logout", {}, { origin: "https://evil.example" }))).status).toBe(403);
});
it("rejects authenticated cross-origin writes before altering tenant data", async () => {
  const cookie = `${cookieName}=${await signSession(tenant.session)}`;
  const response = await createContact(request("/api/contacts", { fullName: "Injected", phone: "0501231234" }, { cookie, origin: "https://evil.example" }), { params: Promise.resolve({}) });
  expect(response.status).toBe(403);
  expect(await db.contact.count({ where: { businessId: tenant.business.id } })).toBe(0);
});
it("normal same-origin password login still issues an HttpOnly session", async () => {
  const response = await login(request("/api/auth/login", { email: tenant.account.email, password: "Test1234!" }, { origin: "http://localhost" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
});
it("refuses the publicly documented seed password in production even if the account uses it", async () => {
  await db.account.update({ where: { id: tenant.account.id }, data: { passwordHash: await bcrypt.hash("Demo1234!", 4) } });
  vi.stubEnv("NODE_ENV", "production");
  try {
    const response = await login(request("/api/auth/login", { email: tenant.account.email, password: "Demo1234!" }, { origin: "http://localhost" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  } finally {
    vi.unstubAllEnvs();
    await db.account.update({ where: { id: tenant.account.id }, data: { passwordHash: tenant.account.passwordHash } });
  }
});
