/**
 * Card-payment providers. UltraCRM never receives, stores or logs card numbers / CVV: the customer (or the agent,
 * with the customer on the line) types them only into the provider's own hosted payment page – embedded in the
 * call screen or opened from a link sent to the customer. What comes back is ids, amounts and a status code.
 *
 *  • PayPlus (official docs, Sept 2026): PaymentPages/generateLink (headers api-key + secret-key) creates a page and
 *    returns page_request_uid + payment_page_link; refURL_callback receives the result, signed: header `hash` =
 *    base64(HMAC-SHA256(secret key, JSON body)) and `user-agent: PayPlus`. The status is then confirmed server-to-
 *    server with PaymentPages/ipn before anything is marked paid. Test environment: restapidev.payplus.co.il.
 *  • sandbox: a built-in simulated provider for tests / demos – its page has no card fields at all, only
 *    "approve / decline (test)" buttons, and it never moves money.
 */
import crypto from "node:crypto";
import { openSecret } from "@/lib/crypto";

export type ProviderStatus = { status: "succeeded" | "failed" | "pending"; transactionId?: string | null; approvalNumber?: string | null; amountAgorot?: number | null; receiptUrl?: string | null; reason?: string | null };
export interface CreatePageInput { amountAgorot: number; currency: string; description: string; reference: string; callbackUrl: string; customer: { name: string; email?: string | null; phone?: string | null } }
export interface PaymentProvider {
  readonly name: "payplus" | "sandbox";
  createPage(input: CreatePageInput): Promise<{ providerRequestId: string; paymentUrl: string }>;
  /** Is this notification really from the provider (signature over the raw body)? */
  verifyCallback(rawBody: string, headers: Headers): boolean;
  /** The provider's id of the payment page / request this notification is about, and a unique event key. */
  parseCallback(body: unknown): { providerRequestId: string | null; eventKey: string | null; summary: Record<string, unknown> };
  /** The authoritative status, asked from the provider (never taken from the browser). */
  fetchStatus(providerRequestId: string): Promise<ProviderStatus>;
}

export interface ConnectionConfig { apiKey?: string; secretKey?: string; paymentPageUid?: string }
export const configOf = (raw: unknown) => {
  const c = (raw ?? {}) as Record<string, string | undefined>;
  return { apiKey: openSecret(c.apiKey) ?? "", secretKey: openSecret(c.secretKey) ?? "", paymentPageUid: c.paymentPageUid ?? "" };
};

const safeEqual = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmac = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("base64");
const str = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/** Find a transaction-like object (with status_code) anywhere shallow in a PayPlus answer. */
function payplusTransaction(body: unknown): Record<string, unknown> | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = (b.data ?? b) as Record<string, unknown>;
  for (const c of [b.transaction, data.transaction, Array.isArray(data.transactions) ? data.transactions[0] : null, data]) {
    if (c && typeof c === "object" && "status_code" in (c as object)) return c as Record<string, unknown>;
  }
  return null;
}

export function payplusProvider(cfg: ConnectionConfig & { environment: string }): PaymentProvider {
  const base = cfg.environment === "live" ? "https://restapi.payplus.co.il/api/v1.0" : "https://restapidev.payplus.co.il/api/v1.0";
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "api-key": cfg.apiKey ?? "", "secret-key": cfg.secretKey ?? "" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: "error" });
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok || !json) throw new Error(`PayPlus ${path}: HTTP ${res.status}`);
    const results = json.results as { status?: string; description?: string } | undefined;
    if (results?.status && results.status !== "success") throw new Error(`PayPlus ${path}: ${String(results.description ?? results.status).slice(0, 160)}`);
    return json;
  };
  return {
    name: "payplus",
    async createPage(i) {
      const j = await call("PaymentPages/generateLink", {
        payment_page_uid: cfg.paymentPageUid, amount: i.amountAgorot / 100, currency_code: i.currency, charge_method: 1,
        sendEmailApproval: false, sendEmailFailure: false, refURL_callback: i.callbackUrl, more_info: i.reference,
        customer: { customer_name: i.customer.name, ...(i.customer.email ? { email: i.customer.email } : {}), ...(i.customer.phone ? { phone: i.customer.phone } : {}) },
        items: [{ name: i.description.slice(0, 120), quantity: 1, price: i.amountAgorot / 100 }],
      });
      const d = (j.data ?? {}) as Record<string, unknown>;
      const id = str(d.page_request_uid), url = str(d.payment_page_link);
      if (!id || !url || !url.startsWith("https://")) throw new Error("PayPlus did not return a payment page");
      return { providerRequestId: id, paymentUrl: url };
    },
    verifyCallback(raw, headers) {
      if (!cfg.secretKey || headers.get("user-agent") !== "PayPlus") return false;
      const got = headers.get("hash") ?? "";
      if (!got) return false;
      let normalized = raw;
      try { normalized = JSON.stringify(JSON.parse(raw)); } catch { /* keep raw */ }
      return safeEqual(hmac(cfg.secretKey, raw), got) || safeEqual(hmac(cfg.secretKey, normalized), got);
    },
    parseCallback(body) {
      const t = payplusTransaction(body) ?? {};
      const b = (body ?? {}) as Record<string, unknown>;
      const prid = str(t.payment_page_request_uid) ?? str(t.page_request_uid) ?? str(b.page_request_uid) ?? str((b.data as Record<string, unknown> | undefined)?.page_request_uid);
      const uid = str(t.uid) ?? str(t.transaction_uid);
      return { providerRequestId: prid, eventKey: uid ? `tx:${uid}:${str(t.status_code) ?? ""}` : prid ? `page:${prid}:${str(t.status_code) ?? ""}` : null, summary: { statusCode: str(t.status_code), amount: t.amount ?? null, transactionUid: uid } };
    },
    async fetchStatus(prid) {
      const j = await call("PaymentPages/ipn", { payment_request_uid: prid });
      const t = payplusTransaction(j);
      if (!t) return { status: "pending" };
      const code = str(t.status_code);
      const amount = typeof t.amount === "number" ? Math.round(t.amount * 100) : typeof t.amount === "string" ? Math.round(Number(t.amount) * 100) : null;
      const receipt = str((t as Record<string, unknown>).invoice_original_url) ?? str((t as Record<string, unknown>).invoice_url);
      if (code === "000") return { status: "succeeded", transactionId: str(t.uid) ?? str(t.transaction_uid), approvalNumber: str(t.approval_number), amountAgorot: amount, receiptUrl: receipt && receipt.startsWith("https://") ? receipt : null };
      return { status: "failed", transactionId: str(t.uid), reason: str(t.status_description) ?? str(t.status) ?? `קוד ${code ?? "לא ידוע"}` };
    },
  };
}

/**
 * Sandbox: the "provider side" lives in PaymentEvent rows of kind sandbox_result (what the tester chose on the test
 * page); callbacks are signed with the connection's secret exactly like a real provider.
 */
export function sandboxProvider(cfg: ConnectionConfig, deps: { appBase: string; lookupResult: (prid: string) => Promise<"approved" | "declined" | null> }): PaymentProvider {
  const secret = cfg.secretKey || "sandbox";
  return {
    name: "sandbox",
    async createPage() {
      const prid = `sbx_${crypto.randomBytes(12).toString("hex")}`;
      return { providerRequestId: prid, paymentUrl: `${deps.appBase}/pay/sandbox/${prid}` };
    },
    verifyCallback(raw, headers) { const got = headers.get("hash") ?? ""; return Boolean(got) && headers.get("user-agent") === "UltraCRM-Sandbox" && safeEqual(hmac(secret, raw), got); },
    parseCallback(body) { const b = (body ?? {}) as Record<string, unknown>; const prid = str(b.page_request_uid); return { providerRequestId: prid, eventKey: str(b.event_id), summary: { result: str(b.result) } }; },
    async fetchStatus(prid) {
      const r = await deps.lookupResult(prid);
      return r === "approved" ? { status: "succeeded", transactionId: `sbx-tx-${prid.slice(4, 14)}`, approvalNumber: "000000" } : r === "declined" ? { status: "failed", reason: "נדחה בסביבת הבדיקה" } : { status: "pending" };
    },
  };
}
export const signSandbox = (secret: string, raw: string) => hmac(secret || "sandbox", raw);
