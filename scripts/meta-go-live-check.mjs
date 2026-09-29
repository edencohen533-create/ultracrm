/**
 * Production readiness check for Meta App Review – run once META_APP_ID / META_APP_SECRET / META_ES_CONFIG_ID are set.
 *
 *   npx vercel env pull --environment=production /tmp/prod.env
 *   node scripts/meta-go-live-check.mjs /tmp/prod.env && rm /tmp/prod.env
 *
 * Reads secrets from the env file and never prints them. Sends only what Meta itself would send: a signed data-deletion
 * and deauthorize request for a made-up Meta user (recorded as "no data"), and webhook verification / unsigned posts.
 */
import crypto from "node:crypto";
import fs from "node:fs";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error("usage: node scripts/meta-go-live-check.mjs <env file from `vercel env pull`>"); process.exit(1); }
const env = Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/\\n$/, "").trim()]));
const B = (env.NEXT_PUBLIC_APP_URL || "https://ultracrm-eta.vercel.app").replace(/\/$/, "");
const results = [];
const check = async (name, fn) => { try { const [ok, info] = await fn(); results.push([ok ? "PASS" : "FAIL", name, info ?? ""]); } catch (e) { results.push(["FAIL", name, e.message]); } };

// 1. Configuration present
for (const k of ["META_APP_ID", "META_APP_SECRET", "META_ES_CONFIG_ID", "META_WEBHOOK_VERIFY_TOKEN", "PLATFORM_LEGAL_NAME", "PLATFORM_ADDRESS", "SUPPORT_EMAIL"]) {
  await check(`env ${k}`, async () => [Boolean(env[k]), env[k] ? "set" : "missing"]);
}

// 2. Public pages: reachable without login, English for Meta's crawler, operator named
for (const p of ["/", "/privacy", "/terms", "/data-deletion", "/support"]) {
  await check(`page ${p}`, async () => {
    const r = await fetch(B + p, { headers: { "user-agent": "facebookexternalhit/1.1" }, redirect: "manual" });
    const h = await r.text();
    const english = /lang="en"/.test(h);
    const named = !env.PLATFORM_LEGAL_NAME || h.includes(env.PLATFORM_LEGAL_NAME);
    return [r.status === 200 && english && named, `${r.status}${english ? "" : " not English"}${named ? "" : " operator name missing"}`];
  });
}

// 3. Webhook verification (what Meta calls when you save the callback URL)
await check("webhook verify (correct token)", async () => {
  const challenge = crypto.randomBytes(6).toString("hex");
  const r = await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.META_WEBHOOK_VERIFY_TOKEN ?? "")}&hub.challenge=${challenge}`);
  return [r.status === 200 && (await r.text()) === challenge, String(r.status)];
});
await check("webhook verify (wrong token) rejected", async () => { const r = await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`); return [r.status === 403, String(r.status)]; });
await check("webhook unsigned post rejected", async () => {
  const r = await fetch(`${B}/api/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "1" } } }] }] }) });
  return [r.status === 401, String(r.status)];
});

// 4. Data deletion + deauthorize callbacks, signed exactly like Meta signs them
const signed = (userId) => {
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: Math.floor(Date.now() / 1000), user_id: userId })).toString("base64url");
  return crypto.createHmac("sha256", env.META_APP_SECRET ?? "").update(payload).digest("base64url") + "." + payload;
};
const fakeUser = `golive-check-${Date.now()}`;
let code = null;
await check("data deletion callback", async () => {
  const r = await fetch(`${B}/api/meta/data-deletion`, { method: "POST", body: new URLSearchParams({ signed_request: signed(fakeUser) }) });
  const j = await r.json().catch(() => ({}));
  code = j.confirmation_code ?? null;
  return [r.status === 200 && typeof j.url === "string" && j.url.startsWith(B) && Boolean(code), `${r.status}${code ? " code issued" : ""}`];
});
await check("data deletion status page shows the code", async () => {
  if (!code) return [false, "no code"];
  const r = await fetch(`${B}/data-deletion?code=${code}`); return [r.status === 200 && (await r.text()).includes(code), String(r.status)];
});
await check("data deletion with a bad signature rejected", async () => {
  const r = await fetch(`${B}/api/meta/data-deletion`, { method: "POST", body: new URLSearchParams({ signed_request: "abc.def" }) }); return [r.status === 400, String(r.status)];
});
await check("deauthorize callback", async () => {
  const r = await fetch(`${B}/api/meta/deauthorize`, { method: "POST", body: new URLSearchParams({ signed_request: signed(fakeUser) }) }); return [r.status === 200, String(r.status)];
});

for (const [s, n, i] of results) console.log(`${s}  ${n}${i ? `  (${i})` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
