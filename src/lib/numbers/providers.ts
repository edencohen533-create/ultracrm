/**
 * Number providers (search / purchase / inventory / configure) behind one interface, so
 * Zadarma or another provider can be added without touching the service or UI.
 *
 * Telnyx – verified against the public API reference (api.telnyx.com/v2):
 *   GET  /available_phone_numbers?filter[country_code]&filter[phone_number_type]&filter[features]=voice
 *   POST /number_orders { phone_numbers:[{phone_number}], connection_id, customer_reference }
 *   GET  /number_orders?filter[customer_reference]      (reconciliation after timeouts)
 *   GET  /phone_numbers                                 (inventory: status, connection_id)
 *   PATCH /phone_numbers/{id} { connection_id }         (attach to the Call Control app)
 *   GET  /call_control_applications/{id}, GET /outbound_voice_profiles/{id}  (connection check)
 * Credentials are server environment secrets bound to ONE business (TELNYX_NUMBERS_BUSINESS_ID);
 * they are never returned to the browser. Saving keys is never "connected" – see checkNumberConnection.
 *
 * Simulation (NUMBER_PROVIDER=mock): in-memory inventory for QA/demo; never charges anything.
 * Truecaller: no authorised reputation API for this account → manual reports only (see service).
 * Zadarma: documented API (numbers search/order); adapter NOT implemented here.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "@/lib/response";

export interface NumberOffer {
  e164: string; country: string; type: string; upfront: string | null; monthly: string | null;
  currency: string | null; requirements: unknown; source: string;
}
export interface OwnedNumber { id: string; e164: string; status: string; connectionId: string | null }
export interface ProviderOrder { id: string; status: string; reference: string | null; numbers: string[] }
export interface NumberProvider {
  name: string;
  /** Proves the credentials work: app active, outbound profile enabled, inventory readable. */
  test(): Promise<{ channelLimit: number | null }>;
  search(country: string, type: string, e164?: string): Promise<NumberOffer[]>;
  inventory(): Promise<OwnedNumber[]>;
  purchase(e164: string, reference: string): Promise<ProviderOrder>;
  findOrders(reference: string): Promise<ProviderOrder[]>;
  configure(id: string): Promise<void>;
  /** The connection/app id owned numbers must be attached to. */
  connectionId: string;
  /** Where the customer buys/manages numbers manually. */
  portal: string;
}

export function isMockNumberProvider() {
  return process.env.NUMBER_PROVIDER === "mock";
}

export function numberConfig(businessId: string) {
  if (isMockNumberProvider()) return { provider: "mock" as const, configured: true, fingerprint: "mock", purchasesEnabled: true, simulated: true };
  // The voice adapter uses one server account. Explicit tenant binding prevents a second business
  // from seeing/purchasing through that account accidentally.
  const configured = Boolean(process.env.TELNYX_NUMBERS_BUSINESS_ID === businessId && process.env.TELNYX_API_KEY && process.env.TELNYX_CALL_CONTROL_APP_ID);
  return {
    provider: "telnyx" as const, configured,
    fingerprint: configured ? createHash("sha256").update(`${process.env.TELNYX_API_KEY}:${process.env.TELNYX_CALL_CONTROL_APP_ID}`).digest("hex") : null,
    purchasesEnabled: configured && process.env.NUMBER_PURCHASES_ENABLED === "true" && process.env.QA_LOCAL !== "1",
    simulated: false,
  };
}

const numberSchema = z.object({ id: z.string(), phone_number: z.string(), status: z.string(), connection_id: z.string().nullable().optional() });
const orderSchema = z.object({ id: z.string(), status: z.string(), customer_reference: z.string().nullable().optional(), phone_numbers: z.array(z.object({ phone_number: z.string() })) });
function parseOrder(raw: unknown): ProviderOrder { const o = orderSchema.parse(raw); return { id: o.id, status: o.status, reference: o.customer_reference ?? null, numbers: o.phone_numbers.map((n) => n.phone_number) }; }

export function telnyxNumberProvider(businessId: string, transport: typeof fetch = fetch): NumberProvider {
  if (!numberConfig(businessId).configured) throw new ApiError("חיבור Telnyx לניהול מספרים לא הוגדר עבור העסק בשרת", 409, "number_provider_unconfigured");
  const connectionId = process.env.TELNYX_CALL_CONTROL_APP_ID!;
  async function request(path: string, method = "GET", body?: unknown): Promise<{ data: unknown; meta?: { total_pages?: number } }> {
    let response: Response;
    try { response = await transport(`https://api.telnyx.com/v2${path}`, { method, headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000), cache: "no-store" }); }
    catch { throw new ApiError("לא התקבלה תשובה ודאית מספק המספרים", 502, "provider_unknown"); }
    if (!response.ok) throw new ApiError(response.status === 429 ? "ספק המספרים מגביל את קצב הבקשות; נסה מאוחר יותר" : `הבקשה לספק המספרים נכשלה (HTTP ${response.status})`, response.status === 429 ? 429 : 502, `provider_http_${response.status}`);
    try { const value = await response.json(); if (!value || !("data" in value)) throw new Error(); return value; }
    catch { throw new ApiError("תשובת ספק לא תקינה; נדרש בירור מצב", 502, "provider_unknown"); }
  }
  async function pages(path: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const r = await request(`${path}${path.includes("?") ? "&" : "?"}page[size]=100&page[number]=${page}`);
      if (!Array.isArray(r.data)) throw new ApiError("תשובת ספק לא תקינה", 502, "provider_unknown");
      result.push(...r.data);
      if (r.data.length < 100 || (r.meta?.total_pages !== undefined && page >= r.meta.total_pages)) return result;
    }
    throw new ApiError("מלאי גדול מדי לסנכרון אחד; יש לפנות למנהל", 409, "inventory_incomplete");
  }
  return {
    name: "telnyx", connectionId, portal: "https://portal.telnyx.com/#/voice/my-numbers",
    async test() {
      const r = await request(`/call_control_applications/${encodeURIComponent(connectionId)}`);
      const app = z.object({ active: z.boolean(), outbound: z.object({ outbound_voice_profile_id: z.string().min(1), channel_limit: z.number().nullable().optional() }) }).parse(r.data);
      if (!app.active) throw new ApiError("אפליקציית הטלפוניה אינה פעילה אצל הספק", 409, "provider_not_ready");
      const rawProfile = await request(`/outbound_voice_profiles/${encodeURIComponent(app.outbound.outbound_voice_profile_id)}`);
      const profile = z.object({ enabled: z.boolean(), concurrent_call_limit: z.number().nullable().optional() }).parse(rawProfile.data);
      if (!profile.enabled) throw new ApiError("פרופיל החיוג היוצא מושבת אצל הספק", 409, "provider_not_ready");
      // Also prove account inventory access. Saving a key is never a successful check.
      await request("/phone_numbers?page[size]=1");
      const limits = [app.outbound.channel_limit, profile.concurrent_call_limit].filter((n): n is number => typeof n === "number" && n > 0);
      return { channelLimit: limits.length ? Math.min(...limits) : null };
    },
    async search(country, type, e164) {
      const query = new URLSearchParams({ "filter[country_code]": country, "filter[phone_number_type]": type, "filter[features]": "voice", "filter[limit]": "20", "filter[best_effort]": "false" });
      if (e164) query.set("filter[phone_number][contains]", e164.replace(/^\+/, ""));
      const r = await request(`/available_phone_numbers?${query}`);
      const offers = z.array(z.object({ phone_number: z.string(), cost_information: z.object({ upfront_cost: z.string().optional(), monthly_cost: z.string().optional(), currency: z.string().optional() }).optional(), regulatory_requirements: z.unknown().optional() })).parse(r.data);
      return offers.filter((n) => !e164 || n.phone_number === e164).map((n) => ({ e164: n.phone_number, country, type, upfront: n.cost_information?.upfront_cost ?? null, monthly: n.cost_information?.monthly_cost ?? null, currency: n.cost_information?.currency ?? null, requirements: n.regulatory_requirements ?? null, source: "Telnyx available_phone_numbers" }));
    },
    async inventory() { return (await pages("/phone_numbers")).map((raw) => { const n = numberSchema.parse(raw); return { id: n.id, e164: n.phone_number, status: n.status, connectionId: n.connection_id ?? null }; }); },
    async purchase(e164, reference) { return parseOrder((await request("/number_orders", "POST", { phone_numbers: [{ phone_number: e164 }], connection_id: connectionId, customer_reference: reference })).data); },
    async findOrders(reference) { return (await pages(`/number_orders?${new URLSearchParams({ "filter[customer_reference]": reference })}`)).map(parseOrder).filter((o) => o.reference === reference); },
    async configure(id) { await request(`/phone_numbers/${encodeURIComponent(id)}`, "PATCH", { connection_id: connectionId }); },
  };
}

/** In-memory simulation provider (QA / demo). State is process-local and clearly labelled. */
export interface MockState { inventory: OwnedNumber[]; orders: ProviderOrder[]; offers: NumberOffer[]; failNextPurchase?: "timeout" | "error" | null; testFails?: boolean }
const mockStates = new Map<string, MockState>();
export function mockNumberState(businessId: string): MockState {
  let st = mockStates.get(businessId);
  if (!st) {
    st = { inventory: [], orders: [], offers: ["+972733001001", "+972733001002", "+972733001003"].map((e164, i) => ({ e164, country: "IL", type: "local", upfront: "1.00", monthly: (2 + i).toFixed(2), currency: "USD", requirements: null, source: "simulation" })) };
    mockStates.set(businessId, st);
  }
  return st;
}
export function mockNumberProvider(businessId: string, state: MockState = mockNumberState(businessId)): NumberProvider {
  const connectionId = "mock-app";
  return {
    name: "mock", connectionId, portal: "https://portal.telnyx.com/#/voice/my-numbers",
    async test() { if (state.testFails) throw new ApiError("הדמיה: בדיקת חיבור נכשלה", 502, "provider_not_ready"); return { channelLimit: 10 }; },
    async search(country, type, e164) { return state.offers.filter((o) => o.country === country && o.type === type && (!e164 || o.e164 === e164) && !state.inventory.some((n) => n.e164 === o.e164)); },
    async inventory() { return state.inventory.map((n) => ({ ...n })); },
    async purchase(e164, reference) {
      const fail = state.failNextPurchase; state.failNextPurchase = null;
      const order: ProviderOrder = { id: `mock-order-${state.orders.length + 1}`, status: "success", reference, numbers: [e164] };
      if (fail === "error") throw new ApiError("הדמיה: הספק החזיר שגיאה", 502, "provider_unknown");
      state.orders.push(order);
      if (!state.inventory.some((n) => n.e164 === e164)) state.inventory.push({ id: `mock-${e164}`, e164, status: "active", connectionId: null });
      if (fail === "timeout") throw new ApiError("הדמיה: timeout אחרי שההזמנה התקבלה", 502, "provider_unknown");
      return order;
    },
    async findOrders(reference) { return state.orders.filter((o) => o.reference === reference); },
    async configure(id) { const n = state.inventory.find((x) => x.id === id); if (n) n.connectionId = connectionId; },
  };
}

export function numberProviderFor(businessId: string): NumberProvider {
  return isMockNumberProvider() ? mockNumberProvider(businessId) : telnyxNumberProvider(businessId);
}
