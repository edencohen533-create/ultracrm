import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
vi.mock("@/lib/db", () => ({ prisma: {}, db: {} }));
import { smsMetrics, smsEncodingOf } from "@/lib/sms";
import { renderMergeTags, validateMergeTags, mergeTagsOf } from "@/lib/merge-tags";
import { defaultEmailDesign, emailDesignSchema, renderEmailHtml, renderEmailText } from "@/lib/email/blocks";
import { signUnsubscribeToken, verifyUnsubscribeToken, maskIdentifier } from "@/lib/unsubscribe-token";
import { isAmbiguousUnsubscribe, isUnsubscribe } from "@/lib/message-policy";
import { TelnyxSmsProvider } from "@/server/channels/sms/telnyx-sms";
import { ResendEmailProvider } from "@/server/channels/email/resend-email";

describe("SMS segments", () => {
  it("counts GSM-7 and UCS-2 (Hebrew / emoji) correctly", () => {
    expect(smsMetrics("Hello world")).toMatchObject({ encoding: "GSM-7", length: 11, segments: 1, perSegment: 160 });
    expect(smsMetrics("a".repeat(160)).segments).toBe(1);
    expect(smsMetrics("a".repeat(161)).segments).toBe(2);
    expect(smsMetrics("a".repeat(306)).segments).toBe(2);
    expect(smsMetrics("a".repeat(307)).segments).toBe(3);
    expect(smsMetrics("€").length).toBe(2); // extension table char
    expect(smsEncodingOf("שלום")).toBe("UCS-2");
    expect(smsMetrics("ש".repeat(70))).toMatchObject({ segments: 1, perSegment: 70 });
    expect(smsMetrics("ש".repeat(71))).toMatchObject({ segments: 2, perSegment: 67 });
    expect(smsMetrics("😀").length).toBe(2); // surrogate pair
    expect(smsMetrics("").segments).toBe(0);
  });
});

describe("merge tags", () => {
  const contact = { fullName: "ישראל ישראלי", email: null, phoneE164: "+972500000000", company: null, city: "חיפה", customFields: { plan: "Pro" } };
  it("renders values, first name, defaults and custom fields", () => {
    const r = renderMergeTags("שלום {{first_name|לקוח}} מ-{{company|החברה}} ב{{city|}} – {{custom.plan|Free}} {{custom.missing|-}}", contact);
    expect(r.text).toBe("שלום ישראל מ-החברה בחיפה – Pro -");
    expect(r.defaulted.sort()).toEqual(["company", "custom.missing"]);
    expect(r.missing).toEqual([]);
  });
  it("reports tags without value and without default as missing", () => {
    const r = renderMergeTags("{{email}} {{unsubscribe_url}}", contact, { unsubscribe_url: "https://x" });
    expect(r.missing).toEqual(["email"]);
    expect(r.text).toBe(" https://x");
  });
  it("validation rejects unknown tags and requires defaults for optional fields", () => {
    expect(validateMergeTags("{{name}} {{company|}}")).toEqual([]);
    expect(validateMergeTags("{{company}}")[0]).toMatch(/ברירת מחדל/);
    expect(validateMergeTags("{{foo}}")[0]).toMatch(/לא מוכר/);
    expect(mergeTagsOf("{{a|1}} {{a|2}} {{b}}")).toEqual([{ tag: "a", fallback: "1" }, { tag: "b", fallback: null }]);
  });
});

describe("email renderer", () => {
  it("renders RTL HTML with an unsubscribe link and a text version", () => {
    const d = defaultEmailDesign();
    const html = renderEmailHtml(d, { preheader: "מבצע" });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("{{unsubscribe_url}}");
    expect(html).toContain("width=device-width");
    expect(html).toContain("מבצע");
    expect(renderEmailText(d)).toContain("{{unsubscribe_url}}");
  });
  it("always appends an unsubscribe footer and escapes HTML", () => {
    const d = emailDesignSchema.parse({ blocks: [{ type: "text", text: "<script>alert(1)</script>" }] });
    const html = renderEmailHtml(d);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("{{unsubscribe_url}}");
    expect(() => emailDesignSchema.parse({ blocks: [{ type: "button", text: "x", href: "javascript:alert(1)" }] })).toThrow();
  });
});

describe("unsubscribe token", () => {
  process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
  it("round-trips and rejects tampering / other payloads", () => {
    const t = signUnsubscribeToken({ b: "biz", c: "contact", i: "a@b.co", m: "m1", ch: "email" });
    expect(verifyUnsubscribeToken(t)).toMatchObject({ b: "biz", c: "contact", i: "a@b.co", ch: "email" });
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), c: "other" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${s}`)).toBeNull();
    expect(verifyUnsubscribeToken("garbage")).toBeNull();
    expect(maskIdentifier("israel@example.com")).toBe("i***@example.com");
    expect(maskIdentifier("+972501234567")).toBe("+9725***67");
  });
});

describe("unsubscribe detection", () => {
  it("clear vs ambiguous", () => {
    expect(isUnsubscribe("הסר")).toBe(true);
    expect(isUnsubscribe("STOP")).toBe(true);
    expect(isAmbiguousUnsubscribe("תפסיקו לשלוח לי הודעות")).toBe(true);
    expect(isAmbiguousUnsubscribe("not interested, thanks")).toBe(true);
    expect(isAmbiguousUnsubscribe("הסר")).toBe(false);
    expect(isAmbiguousUnsubscribe("מעולה, אשמח לפרטים")).toBe(false);
  });
});

describe("Telnyx SMS provider (no network)", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const p = new TelnyxSmsProvider({ apiKey: "k", messagingProfileId: "mp", publicKey: pub });
  const sign = (body: string, ts = String(Math.floor(Date.now() / 1000))) => ({ sig: crypto.sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64"), ts });
  it("verifies Ed25519 signatures and rejects bad / stale ones", () => {
    const body = JSON.stringify({ data: { event_type: "message.sent", id: "e1", payload: { id: "m1" } } });
    const { sig, ts } = sign(body);
    expect(p.verifyWebhook(new Headers({ "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts }), body)).toBe(true);
    expect(p.verifyWebhook(new Headers({ "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts }), body + " ")).toBe(false);
    const stale = sign(body, String(Math.floor(Date.now() / 1000) - 3600));
    expect(p.verifyWebhook(new Headers({ "telnyx-signature-ed25519": stale.sig, "telnyx-timestamp": stale.ts }), body)).toBe(false);
    expect(p.verifyWebhook(new Headers(), body)).toBe(false);
  });
  it("parses finalized / received events", () => {
    const delivered = p.parseWebhook(JSON.stringify({ data: { id: "ev1", event_type: "message.finalized", occurred_at: "2026-09-24T10:00:00Z", payload: { id: "m1", parts: 2, cost: { amount: "0.01", currency: "USD" }, to: [{ phone_number: "+972500000000", status: "delivered" }] } } }));
    expect(delivered[0]).toMatchObject({ kind: "status", status: "DELIVERED", providerMessageId: "m1", segments: 2, cost: { amount: 0.01, currency: "USD" } });
    const failed = p.parseWebhook(JSON.stringify({ data: { id: "ev2", event_type: "message.finalized", payload: { id: "m1", to: [{ phone_number: "+9725", status: "delivery_failed" }], errors: [{ code: "40300", title: "Blocked" }] } } }));
    expect(failed[0]).toMatchObject({ kind: "status", status: "FAILED", permanent: true });
    const inbound = p.parseWebhook(JSON.stringify({ data: { id: "ev3", event_type: "message.received", payload: { id: "in1", from: { phone_number: "+972509990000" }, to: [{ phone_number: "+972501111111" }], text: "הסר" } } }));
    expect(inbound[0]).toMatchObject({ kind: "inbound", from: "+972509990000", body: "הסר" });
  });
});

describe("Resend provider (no network)", () => {
  const secret = "whsec_" + crypto.randomBytes(24).toString("base64");
  const p = new ResendEmailProvider({ apiKey: "re_x", webhookSecret: secret });
  it("verifies Svix signatures", () => {
    const body = JSON.stringify({ type: "email.delivered", created_at: "2026-09-24T10:00:00Z", data: { email_id: "e1" } });
    const id = "msg_1"; const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
    expect(p.verifyWebhook(new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }), body)).toBe(true);
    expect(p.verifyWebhook(new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }), body + "x")).toBe(false);
    expect(p.verifyWebhook(new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": "v1,AAAA" }), body)).toBe(false);
  });
  it("parses bounce / complaint / open / click", () => {
    expect(p.parseWebhook(JSON.stringify({ type: "email.bounced", data: { email_id: "e1", bounce: { type: "Permanent", subType: "General" } } }))[0]).toMatchObject({ status: "BOUNCED", bounceType: "hard", permanent: true });
    expect(p.parseWebhook(JSON.stringify({ type: "email.bounced", data: { email_id: "e1", bounce: { type: "Transient" } } }))[0]).toMatchObject({ status: "BOUNCED", bounceType: "soft" });
    expect(p.parseWebhook(JSON.stringify({ type: "email.complained", data: { email_id: "e1" } }))[0]).toMatchObject({ status: "COMPLAINED" });
    expect(p.parseWebhook(JSON.stringify({ type: "email.clicked", data: { email_id: "e1", click: { link: "https://x" } } }))[0]).toMatchObject({ status: "CLICKED", link: "https://x" });
    expect(p.parseWebhook(JSON.stringify({ type: "email.opened", data: { email_id: "e1" } }))[0]).toMatchObject({ status: "OPENED" });
  });
});
