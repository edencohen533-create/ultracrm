import { randomUUID, createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { reserveAuthAttempt, cleanAuthAttempts } from "@/lib/auth-rate-limit";
import { POST as signup } from "@/app/api/public/signup/route";
const keys: string[] = [];
function identity(scope: string) { const id = randomUUID(); keys.push(createHash("sha256").update(`${scope}:${id}`).digest("hex")); return id; }
afterAll(async () => { await db.authRateLimit.deleteMany({ where: { key: { in: keys } } }); });
it("atomically limits a burst before any expensive authentication work", async () => {
  const id = identity("test-burst");
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveAuthAttempt("test-burst", id, 5)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(5);
  for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 429 });
  expect((await db.authRateLimit.findUniqueOrThrow({ where: { key: keys[0] } })).attempts).toBe(5);
});
it("shares persisted limits, resets an expired window and cleans old keys", async () => {
  const id = identity("test-persisted"); const key = keys.at(-1)!;
  await db.authRateLimit.create({ data: { key, attempts: 5, expiresAt: new Date(Date.now() + 60000) } });
  await expect(reserveAuthAttempt("test-persisted", id, 5)).rejects.toMatchObject({ status: 429 });
  await db.authRateLimit.update({ where: { key }, data: { expiresAt: new Date(0) } });
  await reserveAuthAttempt("test-persisted", id, 5);
  expect((await db.authRateLimit.findUniqueOrThrow({ where: { key } })).attempts).toBe(1);
  await db.authRateLimit.update({ where: { key }, data: { expiresAt: new Date(0) } });
  await cleanAuthAttempts();
  expect(await db.authRateLimit.findUnique({ where: { key } })).toBeNull();
});
it("rejects cross-origin signup before creating an account or setting a cookie", async () => {
  const r = await signup(new Request("http://localhost/api/public/signup", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({}) }));
  expect(r.status).toBe(403); expect(r.headers.has("set-cookie")).toBe(false);
});
it("invalid same-origin signup returns a validation response rather than a server error", async () => {
  const r = await signup(new Request("http://localhost/api/public/signup", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({}) }));
  expect(r.status).toBe(400);
});
