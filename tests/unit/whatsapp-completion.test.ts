import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {}, db: {} }));
import { classifyMetaError, retryDelayMs, MAX_AUTO_ATTEMPTS } from "@/lib/meta/errors";
import { mapRemoteTemplate } from "@/server/services/template-sync-service";
import { magicBytesMatch } from "@/lib/media";
import { personalizeVariablesForContact } from "@/lib/campaigns";
import { signTrackedLink, verifyTrackedLink, rewriteTrackedLinks } from "@/lib/unsubscribe-token";
import { audienceSchema } from "@/lib/audiences";
import { audienceWhere } from "@/server/services/audience-service";

process.env.ENCRYPTION_KEY ||= "a".repeat(64);

describe("Meta error classification (6.07 / 6.09 / 1.09)", () => {
  it("rate limits and 5xx are retryable; recipient/template/auth errors are not; auth codes block the credential", () => {
    expect(classifyMetaError(130429, 400)).toMatchObject({ retryable: true, blocksCredential: false, code: "130429" });
    expect(classifyMetaError(undefined, 503)).toMatchObject({ retryable: true });
    expect(classifyMetaError(131026, 400)).toMatchObject({ retryable: false });
    expect(classifyMetaError(132000, 400)).toMatchObject({ retryable: false });
    expect(classifyMetaError(190, 401)).toMatchObject({ retryable: false, blocksCredential: true });
    expect(classifyMetaError(131047, 400).label).toMatch(/24/);
    expect(retryDelayMs(0)).toBe(60_000); expect(retryDelayMs(1)).toBe(300_000); expect(retryDelayMs(9)).toBe(900_000);
    expect(MAX_AUTO_ATTEMPTS).toBe(3);
  });
});

describe("template sync mapping (4.04 / 4.06 / 2.13)", () => {
  const base = { id: "t1", name: "promo", language: "he", category: "MARKETING" as const };
  it("maps media headers, buttons (static/dynamic URL, quick reply, phone) and Meta paused/disabled statuses", () => {
    const m = mapRemoteTemplate({ ...base, status: "APPROVED", components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "שלום {{1}}, מבצע {{2}}" },
      { type: "FOOTER", text: "להסרה השב הסר" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "מעוניין" }, { type: "URL", text: "לאתר", url: "https://example.com/{{1}}" }, { type: "PHONE_NUMBER", text: "חייג", phone_number: "+97230000000" }] },
    ] });
    expect(m.status).toBe("APPROVED"); expect(m.syncError).toBeNull(); expect(m.headerFormat).toBe("IMAGE");
    expect(m.buttons).toEqual([{ type: "QUICK_REPLY", text: "מעוניין", url: null, phone: null, dynamic: false }, { type: "URL", text: "לאתר", url: "https://example.com/{{1}}", phone: null, dynamic: true }, { type: "PHONE_NUMBER", text: "חייג", url: null, phone: "+97230000000", dynamic: false }]);
    expect(mapRemoteTemplate({ ...base, status: "PAUSED", components: [{ type: "BODY", text: "x" }] }).status).toBe("PAUSED");
    expect(mapRemoteTemplate({ ...base, status: "DISABLED", components: [{ type: "BODY", text: "x" }] }).status).toBe("DISABLED");
  });
  it("marks unsupported structures with a reason instead of sending them", () => {
    const m = mapRemoteTemplate({ ...base, status: "APPROVED", components: [{ type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "x {{2}}" }, { type: "BUTTONS", buttons: [{ type: "FLOW", text: "f" }] }] });
    expect(m.status).toBe("DRAFT"); expect(m.syncError).toMatch(/כותרת/); expect(m.syncError).toMatch(/כפתור/); expect(m.syncError).toMatch(/ממוספרים/);
  });
});

describe("media magic bytes (12.09)", () => {
  it("accepts matching signatures and rejects a mismatch", () => {
    expect(magicBytesMatch(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "image/jpeg")).toBe(true);
    expect(magicBytesMatch(Buffer.from("\x89PNG\r\n\x1a\n........", "latin1"), "image/png")).toBe(true);
    expect(magicBytesMatch(Buffer.from("%PDF-1.7 ....", "latin1"), "application/pdf")).toBe(true);
    expect(magicBytesMatch(Buffer.from("<script>alert(1)</script>"), "image/jpeg")).toBe(false);
    expect(magicBytesMatch(Buffer.from("%PDF-1.7"), "image/png")).toBe(false);
  });
});

describe("WhatsApp variable defaults (4.09 / 5.04 / 5.11)", () => {
  const contact = { fullName: "דנה כהן", email: null, phoneE164: "+972500000000", company: null, city: "חיפה", customFields: { plan: "Pro" } };
  it("renders {name}, named tags with defaults and custom fields; reports missing values", () => {
    expect(personalizeVariablesForContact({ "1": "{name}", "2": "{{first_name|לקוח}} מ{{city|}}", "3": "{{custom.plan|Free}}" }, contact)).toEqual({ "1": "דנה כהן", "2": "דנה מחיפה", "3": "Pro" });
    expect(() => personalizeVariablesForContact({ "1": "{{company}}" }, contact)).toThrow(/company/);
    expect(personalizeVariablesForContact({ "1": "{{company|החברה}}" }, contact)["1"]).toBe("החברה");
  });
});

describe("tracked links (11.09)", () => {
  it("round-trips and rejects tampering or non-http targets", () => {
    const t = signTrackedLink("m1", "https://example.com/x");
    expect(verifyTrackedLink(t)).toEqual({ m: "m1", u: "https://example.com/x" });
    const [tp, ts] = t.split(".");
    expect(verifyTrackedLink(`${tp}.${ts.slice(0, 5)}${ts[5] === "A" ? "B" : "A"}${ts.slice(6)}`)).toBeNull(); // flipped signature byte
    const bad = Buffer.from(JSON.stringify({ m: "m1", u: "javascript:alert(1)", exp: 9999999999 })).toString("base64url");
    expect(verifyTrackedLink(`${bad}.${t.split(".")[1]}`)).toBeNull();
  });
  it("rewrites marketing email hrefs to signed redirects but leaves unsubscribe links alone", () => {
    const html = `<a href="https://shop.example/x?a=1">קנה</a> <a href='http://localhost:3000/u/tok'>הסר</a> <a href="mailto:a@b.c">מייל</a>`;
    const out = rewriteTrackedLinks(html, "m9");
    expect(out).toMatch(/href="http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/);
    expect(out).toContain("href='http://localhost:3000/u/tok'");
    expect(out).toContain('href="mailto:a@b.c"');
    const token = out.match(/\/r\/([^"]+)"/)![1];
    expect(verifyTrackedLink(token)).toEqual({ m: "m9", u: "https://shop.example/x?a=1" });
  });
});

describe("audience delivery outcomes (3.06)", () => {
  it("delivered/read/not-delivered filters look at provider statuses", () => {
    expect(audienceSchema.safeParse({ field: "campaign", operator: "is", value: "c1", result: "DELIVERED" }).success).toBe(true);
    expect(audienceWhere({ field: "campaign", operator: "is", value: "c1", result: "DELIVERED" })).toEqual({ campaignRecipients: { some: { campaignId: "c1", message: { status: { in: ["DELIVERED", "READ"] } } } } });
    expect(audienceWhere({ field: "campaign", operator: "is", value: "c1", result: "READ" })).toEqual({ campaignRecipients: { some: { campaignId: "c1", message: { status: "READ" } } } });
  });
});
