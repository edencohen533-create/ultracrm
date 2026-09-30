/**
 * Platform billing provider (UltraCRM charging businesses for their subscription). SEPARATE from the payment
 * connections businesses use to charge THEIR customers (PaymentProviderConnection / PayPlus).
 *
 * No real provider is connected yet: the only implementation is a SANDBOX that moves no money. Its hosted "payment
 * page" has no card fields, its results arrive as signed webhooks, and a success is verified server-side before
 * anything is applied (never the browser's success page). In production the sandbox is off unless
 * PLATFORM_BILLING_SANDBOX=1 – purchases then answer "billing provider not connected".
 * Card numbers / CVV are never seen or stored; only the provider's token reference and a display label.
 */
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { appBase } from "@/lib/store-urls";

export interface ProviderEvent { eventId: string; type: "payment.succeeded" | "payment.failed" | "payment_method.updated"; occurredAt: Date; documentId: string | null; businessId: string | null; providerPaymentRef: string | null; paymentMethodRef?: string | null; paymentMethodLabel?: string | null; reason?: string | null }
export interface BillingProvider {
  key: string; name: string; live: boolean;
  /** Hosted, provider-secured payment page for a document (first purchase / no saved method). */
  checkoutUrl(documentId: string): string;
  /** Charge the saved payment method; the result arrives by webhook. */
  chargeSaved(input: { documentId: string; businessId: string; amountMinor: number; paymentMethodRef: string }): Promise<{ providerPaymentRef: string }>;
  paymentMethodUpdateUrl(businessId: string): string;
  verifyWebhook(headers: Headers, raw: string): boolean;
  parseWebhook(raw: string): ProviderEvent;
  /** Server-side confirmation with the provider – the only thing that activates / renews. */
  verifyPayment(providerPaymentRef: string): Promise<"succeeded" | "failed" | "pending">;
}

const secret = () => process.env.PLATFORM_BILLING_SANDBOX_SECRET?.trim() || process.env.JWT_SECRET?.trim() || "sandbox-dev-secret";
export const sandboxSign = (ts: string, body: string) => crypto.createHmac("sha256", secret()).update(`${ts}.${body}`).digest("hex");
export function sandboxToken(documentOrBusiness: string) { return crypto.createHmac("sha256", secret()).update(`page:${documentOrBusiness}`).digest("base64url").slice(0, 32); }

export const sandboxProvider: BillingProvider = {
  key: "sandbox", name: "סביבת בדיקה (ללא חיוב אמיתי)", live: false,
  checkoutUrl: (documentId) => `${appBase()}/billing/sandbox/${documentId}?t=${sandboxToken(documentId)}`,
  async chargeSaved({ documentId, paymentMethodRef }) {
    // A sandbox "card" whose reference says fail declines – lets tests exercise failures, retries and grace.
    const ref = `sbx_pay_${crypto.randomUUID()}`;
    const outcome = paymentMethodRef.includes("fail") ? "failed" : "succeeded";
    await deliverSandboxEvent({ type: outcome === "succeeded" ? "payment.succeeded" : "payment.failed", documentId, providerPaymentRef: ref, reason: outcome === "failed" ? "כרטיס בדיקה נדחה" : null });
    return { providerPaymentRef: ref };
  },
  paymentMethodUpdateUrl: (businessId) => `${appBase()}/billing/sandbox/method/${businessId}?t=${sandboxToken(businessId)}`,
  verifyWebhook(headers, raw) {
    const ts = headers.get("x-sandbox-timestamp") ?? ""; const sig = headers.get("x-sandbox-signature") ?? "";
    if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const exp = sandboxSign(ts, raw);
    return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
  },
  parseWebhook(raw) { const j = JSON.parse(raw) as ProviderEvent & { occurredAt: string }; return { ...j, occurredAt: new Date(j.occurredAt) }; },
  async verifyPayment(ref) {
    // The sandbox "provider API": its OWN ledger of payments it processed (written by the sandbox before it sends a
    // webhook – never by the webhook handler), so a webhook can't vouch for itself.
    const e = await db.billingEvent.findFirst({ where: { provider: "sandbox_ledger", eventId: `pay:${ref}` } });
    return e?.type === "payment.succeeded" ? "succeeded" : e?.type === "payment.failed" ? "failed" : "pending";
  },
};

/** The sandbox's webhook delivery (what a real provider does from its servers): signed, then handled like any webhook. */
async function deliverSandboxEventInner(input: { type: ProviderEvent["type"]; documentId?: string | null; businessId?: string | null; providerPaymentRef?: string | null; paymentMethodRef?: string | null; paymentMethodLabel?: string | null; reason?: string | null; occurredAt?: Date; eventId?: string }) {
  const ev = { eventId: input.eventId ?? `sbx_evt_${crypto.randomUUID()}`, type: input.type, occurredAt: (input.occurredAt ?? new Date()).toISOString(), documentId: input.documentId ?? null, businessId: input.businessId ?? null, providerPaymentRef: input.providerPaymentRef ?? null, paymentMethodRef: input.paymentMethodRef ?? null, paymentMethodLabel: input.paymentMethodLabel ?? null, reason: input.reason ?? null };
  // Provider side: record the payment outcome in the sandbox's own ledger (what verifyPayment asks later).
  if (ev.providerPaymentRef && (ev.type === "payment.succeeded" || ev.type === "payment.failed")) await db.billingEvent.createMany({ data: [{ provider: "sandbox_ledger", eventId: `pay:${ev.providerPaymentRef}`, type: ev.type, businessId: null, occurredAt: new Date(ev.occurredAt), payload: { providerPaymentRef: ev.providerPaymentRef, documentId: ev.documentId } }], skipDuplicates: true });
  const raw = JSON.stringify(ev); const ts = String(Math.floor(Date.now() / 1000));
  const { handleBillingWebhook } = await import("./subscriptions");
  return handleBillingWebhook("sandbox", new Headers({ "x-sandbox-timestamp": ts, "x-sandbox-signature": sandboxSign(ts, raw) }), raw);
}
/** The sandbox's webhook delivery (what a real provider does from its servers): outside any business scope. */
export async function deliverSandboxEvent(input: Parameters<typeof deliverSandboxEventInner>[0]) {
  const { withoutBusiness } = await import("@/lib/tenant");
  return withoutBusiness(() => deliverSandboxEventInner(input));
}

export function billingProvider(): BillingProvider | null {
  if (process.env.RESTORE_MODE === "1") return null; // a restored copy never charges
  if (process.env.NODE_ENV !== "production" || process.env.PLATFORM_BILLING_SANDBOX === "1") return sandboxProvider;
  return null; // a real provider is plugged in here once it is chosen and verified against its documentation
}
/** Webhooks / charges are handled only by the provider that is currently enabled (the sandbox is off in production). */
export function providerByKey(key: string): BillingProvider | null { const p = billingProvider(); return p && p.key === key ? p : null; }
