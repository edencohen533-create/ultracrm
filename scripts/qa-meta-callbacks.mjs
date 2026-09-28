// QA: Meta data-deletion / deauthorize callbacks and the WhatsApp webhook, signed with a test app secret.
// Usage: node scripts/qa-meta-callbacks.mjs <baseUrl> <appSecret> <verifyToken>  – run against a local server whose META_APP_SECRET is that secret.

import crypto from "node:crypto";
const [B = "http://localhost:3310", SECRET = "load-meta-secret", VERIFY = "load-verify"] = process.argv.slice(2);
const b64 = (b) => Buffer.from(b).toString("base64url");
const sign = (obj, secret = SECRET) => { const p = b64(JSON.stringify(obj)); return b64(crypto.createHmac("sha256", secret).update(p).digest()) + "." + p; };
const post = async (path, body, type) => { const r = await fetch(B + path, { method: "POST", body, headers: type ? { "content-type": type } : {} }); return [r.status, await r.text()]; };
const form = (sr) => new URLSearchParams({ signed_request: sr });
const now = Math.floor(Date.now() / 1000);
const out = [];
const t = async (name, fn) => { try { out.push([name, ...(await fn())]); } catch (e) { out.push([name, "ERR", e.message]); } };
await t("deletion valid (urlencoded)", () => post("/api/meta/data-deletion", form(sign({ algorithm: "HMAC-SHA256", issued_at: now, user_id: "1111222233334444" })), "application/x-www-form-urlencoded"));
const fd = new FormData(); fd.set("signed_request", sign({ algorithm: "HMAC-SHA256", issued_at: now, user_id: "555" }));
await t("deletion valid (multipart)", () => post("/api/meta/data-deletion", fd));
await t("deletion bad secret", () => post("/api/meta/data-deletion", form(sign({ algorithm: "HMAC-SHA256", user_id: "1" }, "wrong")), "application/x-www-form-urlencoded"));
await t("deletion garbage", () => post("/api/meta/data-deletion", form("abc.def"), "application/x-www-form-urlencoded"));
await t("deletion missing field", () => post("/api/meta/data-deletion", "", "application/x-www-form-urlencoded"));
await t("deauthorize valid", () => post("/api/meta/deauthorize", form(sign({ algorithm: "HMAC-SHA256", issued_at: now, user_id: "1111222233334444" })), "application/x-www-form-urlencoded"));
const first = JSON.parse(out[0][2] || "{}");
if (first.confirmation_code) {
  await t("status page by code", async () => { const r = await fetch(`${B}/data-deletion?code=${first.confirmation_code}`); const h = await r.text(); return [r.status, h.includes(first.confirmation_code) ? "shows code" : "code NOT shown"]; });
  await t("url field points to", async () => [200, first.url]);
}
// webhook
await t("webhook verify ok", async () => { const r = await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`); return [r.status, await r.text()]; });
await t("webhook verify wrong", async () => { const r = await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42`); return [r.status, await r.text()]; });
const whBody = (field, value, id = "WABA_UNKNOWN") => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id, changes: [{ field, value }] }] });
const whSig = (raw, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
const wh = async (raw, sig) => { const r = await fetch(`${B}/api/webhooks/whatsapp`, { method: "POST", body: raw, headers: { "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}) } }); return [r.status, (await r.text()).slice(0, 150)]; };
let raw = whBody("messages", { messaging_product: "whatsapp", metadata: { phone_number_id: "PN_UNKNOWN", display_phone_number: "972500000000" }, messages: [{ from: "972501111111", id: "wamid.TEST1", timestamp: String(now), type: "text", text: { body: "hi" } }] });
await t("webhook signed, unknown number", () => wh(raw, whSig(raw)));
await t("webhook unsigned", () => wh(raw));
await t("webhook bad signature", () => wh(raw, whSig(raw, "nope")));
raw = whBody("message_template_status_update", { event: "APPROVED", message_template_id: 1, message_template_name: "x", message_template_language: "en" });
await t("webhook template status (unknown waba)", () => wh(raw, whSig(raw)));
raw = whBody("some_future_field", { foo: 1 });
await t("webhook unknown field", () => wh(raw, whSig(raw)));
raw = whBody("phone_number_quality_update", { display_phone_number: "972500000000", event: "UPGRADE", current_limit: "TIER_1K" });
await t("webhook quality update", () => wh(raw, whSig(raw)));
for (const r of out) console.log(r.map((x) => String(x).slice(0, 200)).join("  |  "));
