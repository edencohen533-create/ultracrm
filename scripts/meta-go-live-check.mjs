/**
 * Production readiness check.
 *  - Tech Provider mode (Embedded Signup for other businesses): META_APP_ID / META_APP_SECRET / META_ES_CONFIG_ID.
 *  - Direct mode (one business, its own number – WHATSAPP_DIRECT_* set or WHATSAPP_CONNECT_MODE=direct): Embedded
 *    Signup settings are not required; instead the System User token, the WABA, the number and the app's
 *    subscription are checked read-only against Meta.
 *
 *   npx vercel env pull --environment=production /tmp/prod.env
 *   node scripts/meta-go-live-check.mjs /tmp/prod.env && rm /tmp/prod.env
 *   # optional, sends ONE template message to a number you own (never customers):
 *   node scripts/meta-go-live-check.mjs /tmp/prod.env --send-test-to +9725XXXXXXXX [--template hello_world --lang en_US]
 *
 * Reads secrets from the env file and never prints them. Sends only what Meta itself would send: a signed data-deletion
 * and deauthorize request for a made-up Meta user (recorded as "no data"), and webhook verification / unsigned posts.
 */
import crypto from "node:crypto";
import fs from "node:fs";

const file = process.argv[2];
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (!file || !fs.existsSync(file)) { console.error("usage: node scripts/meta-go-live-check.mjs <env file from `vercel env pull`>"); process.exit(1); }
const env = Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/\\n$/, "").trim()]));
const B = (env.NEXT_PUBLIC_APP_URL || "https://ultracrm-eta.vercel.app").replace(/\/$/, "");
const DIRECT = env.WHATSAPP_CONNECT_MODE === "direct" || Boolean(env.WHATSAPP_DIRECT_BUSINESS_ID);
const GRAPH = `https://graph.facebook.com/${env.META_GRAPH_VERSION || "v25.0"}`;
const results = [];
const check = async (name, fn) => { try { const [ok, info] = await fn(); results.push([ok ? "PASS" : "FAIL", name, info ?? ""]); } catch (e) { results.push(["FAIL", name, e.message]); } };

console.log(`mode: ${DIRECT ? "direct (single business)" : "Tech Provider (Embedded Signup)"}\n`);
// 1. Configuration present (values are never printed)
const required = ["META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "ENCRYPTION_KEY", "NEXT_PUBLIC_APP_URL", "PLATFORM_LEGAL_NAME", "PLATFORM_ADDRESS", "SUPPORT_EMAIL",
  ...(DIRECT ? ["WHATSAPP_DIRECT_BUSINESS_ID", "WHATSAPP_DIRECT_WABA_ID", "WHATSAPP_DIRECT_PHONE_NUMBER_ID", "WHATSAPP_SYSTEM_USER_TOKEN"] : ["META_ES_CONFIG_ID"])];
for (const k of required) await check(`env ${k}`, async () => [Boolean(env[k]), env[k] ? "set" : "missing"]);
if (DIRECT) results.push(["SKIP", "env META_ES_CONFIG_ID", "Embedded Signup is paused in direct mode"]);

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

// 5. Direct mode: the business's own assets at Meta (read-only, token never printed)
if (DIRECT && env.WHATSAPP_SYSTEM_USER_TOKEN) {
  const T = env.WHATSAPP_SYSTEM_USER_TOKEN, WABA = env.WHATSAPP_DIRECT_WABA_ID, PHONE = env.WHATSAPP_DIRECT_PHONE_NUMBER_ID;
  const g = async (path, init = {}) => { const r = await fetch(`${GRAPH}/${path}`, { ...init, headers: { Authorization: `Bearer ${T}`, ...(init.body ? { "Content-Type": "application/json" } : {}) } }); const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(`${j.error?.message ?? r.status} (code ${j.error?.code ?? "?"})`); return j; };
  await check("token: valid, this app, both WhatsApp permissions", async () => {
    const r = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(T)}&access_token=${encodeURIComponent(`${env.META_APP_ID}|${env.META_APP_SECRET}`)}`);
    const d = (await r.json()).data ?? {};
    const scopes = d.scopes ?? [];
    const missing = ["whatsapp_business_management", "whatsapp_business_messaging"].filter((s) => !scopes.includes(s));
    const ok = d.is_valid === true && d.app_id === env.META_APP_ID && missing.length === 0;
    const expiry = d.expires_at === 0 ? "never expires" : d.expires_at ? `expires ${new Date(d.expires_at * 1000).toISOString().slice(0, 10)}` : "expiry unknown";
    return [ok, `${d.is_valid ? "valid" : "INVALID"}, type ${d.type ?? "?"}, ${d.app_id === env.META_APP_ID ? "this app" : "OTHER APP"}, ${expiry}${missing.length ? `, missing ${missing.join(",")}` : ""}`];
  });
  await check("WABA readable", async () => { const w = await g(`${WABA}?fields=id,name`); return [w.id === WABA, w.name ?? ""]; });
  await check("number belongs to the WABA", async () => { const l = await g(`${WABA}/phone_numbers?fields=id&limit=100`); return [(l.data ?? []).some((p) => p.id === PHONE), `${(l.data ?? []).length} number(s) in WABA`]; });
  await check("number state (no change made)", async () => {
    const p = await g(`${PHONE}?fields=display_phone_number,verified_name,name_status,status,platform_type,quality_rating,code_verification_status,whatsapp_business_manager_messaging_limit`);
    const extra = await g(`${PHONE}?fields=is_on_biz_app,health_status`).catch(() => ({}));
    const ready = p.platform_type === "CLOUD_API" && p.status === "CONNECTED";
    const what = p.platform_type === "CLOUD_API" ? (extra.is_on_biz_app ? "Cloud API + WhatsApp Business app (coexistence)" : "Cloud API") : p.platform_type === "ON_PREMISE" ? "On-Premises API (another provider/server) – do NOT register, migrate first" : p.platform_type === "NOT_APPLICABLE" ? "not registered on any API – register explicitly in Settings" : `platform ${p.platform_type ?? "?"}`;
    return [ready, `${p.display_phone_number ?? "?"} "${p.verified_name ?? ""}" name ${p.name_status ?? "?"}, status ${p.status ?? "?"}, ${what}, quality ${p.quality_rating ?? "?"}, limit ${p.whatsapp_business_manager_messaging_limit ?? "?"}${extra.health_status?.can_send_message ? `, can_send ${extra.health_status.can_send_message}` : ""}`];
  });
  await check("app subscribed to the WABA's webhooks", async () => { const s = await g(`${WABA}/subscribed_apps`); const ok = (s.data ?? []).some((a) => a.whatsapp_business_api_data?.id === env.META_APP_ID); return [ok, ok ? "subscribed" : "not subscribed – press \"Connect the business number\" in Settings → WhatsApp"]; });
  await check("templates readable", async () => { const t = await g(`${WABA}/message_templates?fields=name,status,language&limit=100`); const approved = (t.data ?? []).filter((x) => x.status === "APPROVED"); return [true, `${approved.length} approved of ${(t.data ?? []).length}`]; });
  await check("webhook signed POST accepted (unknown number, nothing stored)", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "0", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "0", display_phone_number: "0" } } }] }] });
    const sig = "sha256=" + crypto.createHmac("sha256", env.META_APP_SECRET ?? "").update(body, "utf8").digest("hex");
    const r = await fetch(`${B}/api/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
    return [r.status === 200, String(r.status)];
  });
  const to = arg("--send-test-to");
  if (to) {
    // Explicit, single recipient given on the command line by the operator – never a customer list.
    await check(`test template to ${to.replace(/\d(?=\d{3})/g, "•")}`, async () => {
      const r = await g(`${PHONE}/messages`, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/\D/g, ""), type: "template", template: { name: arg("--template") ?? "hello_world", language: { code: arg("--lang") ?? "en_US" } } }) });
      return [Boolean(r.messages?.[0]?.id), r.messages?.[0]?.id ?? "no message id"];
    });
  }
}

for (const [s, n, i] of results) console.log(`${s}  ${n}${i ? `  (${i})` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
