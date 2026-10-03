// @vitest-environment node
/**
 * Direct (single-business) WhatsApp Cloud API connection: the token is read from the server environment only for the
 * exact business/WABA/number it was configured for, and the number state from Meta decides what may be done.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, db: {} }));

const ENV = { WHATSAPP_DIRECT_BUSINESS_ID: "biz_solina", WHATSAPP_DIRECT_WABA_ID: "111", WHATSAPP_DIRECT_PHONE_NUMBER_ID: "222", WHATSAPP_SYSTEM_USER_TOKEN: "EAAG-system-user-token", META_APP_ID: "1653153909742880", META_APP_SECRET: "app-secret", META_WEBHOOK_VERIFY_TOKEN: "verify" };
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } delete process.env.WHATSAPP_CONNECT_MODE; });

describe("directWhatsAppEnv", () => {
  it("is ready only when every server setting is present and reports missing names, never values", async () => {
    const { directWhatsAppEnv } = await import("@/lib/meta/graph");
    expect(directWhatsAppEnv()).toMatchObject({ ready: true, missing: [], mode: true });
    delete process.env.WHATSAPP_SYSTEM_USER_TOKEN; delete process.env.META_APP_SECRET;
    const d = directWhatsAppEnv();
    expect(d.ready).toBe(false);
    expect(d.missing).toEqual(["WHATSAPP_SYSTEM_USER_TOKEN", "META_APP_SECRET"]);
  });
  it("direct mode can be switched on before the IDs are set", async () => {
    const { directWhatsAppEnv } = await import("@/lib/meta/graph");
    delete process.env.WHATSAPP_DIRECT_BUSINESS_ID;
    expect(directWhatsAppEnv().mode).toBe(false);
    process.env.WHATSAPP_CONNECT_MODE = "direct";
    expect(directWhatsAppEnv().mode).toBe(true);
  });
});

describe("metaConfigOf with tokenSource env", () => {
  const row = { tokenSource: "env", businessId: "biz_solina", phoneNumberId: "222", businessAccountId: "111" };
  it("uses the environment token and the app-level secret/verify token for the configured number", async () => {
    const { metaConfigOf } = await import("@/lib/meta/graph");
    expect(metaConfigOf(row)).toMatchObject({ accessToken: "EAAG-system-user-token", phoneNumberId: "222", businessAccountId: "111", appSecret: "app-secret", webhookVerifyToken: "verify" });
  });
  it("never hands the token to another business, WABA or number", async () => {
    const { metaConfigOf } = await import("@/lib/meta/graph");
    expect(metaConfigOf({ ...row, businessId: "other" }).accessToken).toBe("");
    expect(metaConfigOf({ ...row, phoneNumberId: "999" }).accessToken).toBe("");
    expect(metaConfigOf({ ...row, businessAccountId: "999" }).accessToken).toBe("");
  });
});

describe("assessPhone", () => {
  it("CLOUD_API → already registered, never re-registered", async () => {
    const { assessPhone } = await import("@/server/services/whatsapp-direct-service");
    expect(assessPhone({ platform_type: "CLOUD_API", status: "CONNECTED" })).toMatchObject({ kind: "cloud_api", canRegister: false });
  });
  it("coexistence with the WhatsApp Business app is reported, and still not re-registered", async () => {
    const { assessPhone } = await import("@/server/services/whatsapp-direct-service");
    const a = assessPhone({ platform_type: "CLOUD_API", status: "CONNECTED", is_on_biz_app: true });
    expect(a.canRegister).toBe(false);
    expect(a.note).toContain("Coexistence");
  });
  it("ON_PREMISE (another provider/server) and unknown states block registration", async () => {
    const { assessPhone } = await import("@/server/services/whatsapp-direct-service");
    expect(assessPhone({ platform_type: "ON_PREMISE" })).toMatchObject({ kind: "on_premise", canRegister: false });
    expect(assessPhone({})).toMatchObject({ kind: "unknown", canRegister: false });
  });
  it("NOT_APPLICABLE (in the WABA, on no API) is the only state that allows explicit registration", async () => {
    const { assessPhone } = await import("@/server/services/whatsapp-direct-service");
    expect(assessPhone({ platform_type: "NOT_APPLICABLE" })).toMatchObject({ kind: "not_registered", canRegister: true });
  });
  it("a non-CONNECTED status or limited health is surfaced", async () => {
    const { assessPhone } = await import("@/server/services/whatsapp-direct-service");
    expect(assessPhone({ platform_type: "CLOUD_API", status: "FLAGGED", health_status: { can_send_message: "LIMITED" } }).note).toMatch(/FLAGGED[\s\S]*מוגבלת/);
  });
});
