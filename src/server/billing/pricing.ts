/**
 * Custom pricing per business (platform admin) – one fixed calculation order, used by the renewal document, the
 * quote and the preview:
 *
 *   1. license lines: unit price = the business's custom price for that license, else the price-book / purchased price
 *   2. licenses subtotal
 *   3. recurring discount (ONE per version – no silent stacking): fixed ₪ (capped at the subtotal) or % of the subtotal;
 *      only when active at the period start (startsAt ≤ start, and before endsAt)
 *   4. one-time credits, oldest first, up to what is left (never below 0; the rest stays for the next document)
 *   5. VAT on the net amount → total (never negative)
 *
 * Usage-rate changes apply only to usage recorded from the version's effectiveFrom (usage.ts). Versions are
 * append-only (DB trigger); issued documents and recorded usage are never rewritten. Every change is audited.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";

export const discountSchema = z.object({
  type: z.enum(["fixed", "percent"]),
  amountMinor: z.number().int().min(1).max(100_000_000).optional(),
  bps: z.number().int().min(1).max(10000).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  note: z.string().max(200).optional(),
}).refine((d) => (d.type === "fixed" ? d.amountMinor : d.bps) !== undefined, { message: "חסר סכום / אחוז הנחה" })
  .refine((d) => !d.endsAt || new Date(d.endsAt) > new Date(d.startsAt), { message: "תאריך הסיום חייב להיות אחרי ההתחלה" });
export const termsSchema = z.object({
  licensePrices: z.record(z.string().regex(/^[a-z_]{2,40}$/), z.number().int().min(0).max(100_000_000)).default({}),
  discount: discountSchema.nullable().default(null),
  usageRates: z.record(z.string().regex(/^[a-z_]{2,40}$/), z.number().int().min(0).max(10_000_000)).default({}),
});
export type Terms = z.infer<typeof termsSchema>;
export type Discount = z.infer<typeof discountSchema>;
export const EMPTY_TERMS: Terms = { licensePrices: {}, discount: null, usageRates: {} };
/** Invalid input → 400 with the first problem (not a server error). */
function parseOr400<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError(`נתונים לא תקינים: ${r.error.issues[0]?.message ?? ""}`, 400, "validation");
  return r.data;
}

export interface Line { code: string; name: string; quantity: number; unitPriceMinor: number; amountMinor: number; basePriceMinor?: number }
export interface Priced { lines: Line[]; licensesMinor: number; discountMinor: number; discountLabel: string | null; creditMinor: number; creditUse: Array<{ id: string; amountMinor: number }>; netMinor: number; taxMinor: number; totalMinor: number }

export function discountActive(d: Discount | null, at: Date) {
  return Boolean(d && new Date(d.startsAt) <= at && (!d.endsAt || at < new Date(d.endsAt)));
}
const ils = (m: number) => `₪${(m / 100).toLocaleString("he-IL", { minimumFractionDigits: m % 100 ? 2 : 0 })}`;

/** Pure: the fixed order above. `base` = license lines at their base (purchased / price-book) unit price. */
export function price(base: Array<{ code: string; name: string; quantity: number; unitPriceMinor: number }>, terms: Terms, credits: Array<{ id: string; remainingMinor: number }>, taxRateBps: number, periodStart: Date): Priced {
  const lines: Line[] = base.filter((l) => l.quantity > 0).map((l) => {
    const custom = terms.licensePrices[l.code];
    const unit = custom ?? l.unitPriceMinor;
    return { code: l.code, name: l.name, quantity: l.quantity, unitPriceMinor: unit, amountMinor: unit * l.quantity, ...(custom !== undefined && custom !== l.unitPriceMinor ? { basePriceMinor: l.unitPriceMinor } : {}) };
  });
  const licensesMinor = lines.reduce((s, l) => s + l.amountMinor, 0);
  let discountMinor = 0; let discountLabel: string | null = null;
  if (terms.discount && discountActive(terms.discount, periodStart) && licensesMinor > 0) {
    const d = terms.discount;
    discountMinor = Math.min(licensesMinor, d.type === "fixed" ? d.amountMinor! : Math.round((licensesMinor * d.bps!) / 10000));
    discountLabel = d.type === "fixed" ? `הנחה חודשית קבועה ${ils(d.amountMinor!)}` : `הנחה חודשית ${d.bps! / 100}%`;
  }
  let left = licensesMinor - discountMinor;
  const creditUse: Priced["creditUse"] = [];
  for (const c of credits) { if (left <= 0) break; const use = Math.min(c.remainingMinor, left); if (use > 0) { creditUse.push({ id: c.id, amountMinor: use }); left -= use; } }
  const creditMinor = creditUse.reduce((s, c) => s + c.amountMinor, 0);
  const netMinor = Math.max(0, licensesMinor - discountMinor - creditMinor);
  const taxMinor = Math.round((netMinor * taxRateBps) / 10000);
  return { lines, licensesMinor, discountMinor, discountLabel, creditMinor, creditUse, netMinor, taxMinor, totalMinor: netMinor + taxMinor };
}

/** Document lines incl. the discount / credit rows (negative amounts) – their sum equals the net subtotal. */
export function documentLines(p: Priced) {
  return [
    ...p.lines.map((l) => ({ code: l.code, name: l.name, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, amountMinor: l.amountMinor, ...(l.basePriceMinor !== undefined ? { basePriceMinor: l.basePriceMinor } : {}) })),
    ...(p.discountMinor ? [{ code: "discount", name: p.discountLabel ?? "הנחה", quantity: 1, unitPriceMinor: -p.discountMinor, amountMinor: -p.discountMinor }] : []),
    ...(p.creditMinor ? [{ code: "credit", name: "זיכוי חד-פעמי", quantity: 1, unitPriceMinor: -p.creditMinor, amountMinor: -p.creditMinor }] : []),
  ];
}

/** The terms in force for a business at a moment (none → no custom pricing). */
export async function termsAt(businessId: string, at = new Date()) {
  const v = await withoutBusiness(() => db.businessPricing.findFirst({ where: { businessId, effectiveFrom: { lte: at } }, orderBy: { version: "desc" } }));
  if (!v) return { version: null as number | null, terms: EMPTY_TERMS };
  return { version: v.version, terms: termsSchema.parse({ licensePrices: v.licensePrices, discount: v.discount, usageRates: v.usageRates }) };
}

export async function openCredits(businessId: string) {
  return withoutBusiness(() => db.billingCredit.findMany({ where: { businessId, cancelledAt: null, remainingMinor: { gt: 0 } }, orderBy: { createdAt: "asc" }, select: { id: true, remainingMinor: true, amountMinor: true, reason: true, createdAt: true } }));
}

/**
 * What the business's next renewal would cost now and with the proposed terms / credit – for the preview before saving.
 * Without an active subscription: the monthly price per license (nothing is billed yet).
 */
export async function previewPricing(businessId: string, proposed: Terms, extraCreditMinor = 0, now = new Date()) {
  const { publishedVersion, parseItems } = await import("./pricebook");
  const sub = await withoutBusiness(() => db.subscription.findUnique({ where: { businessId }, include: { items: true } }));
  const pb = await withoutBusiness(() => publishedVersion());
  const catalog = pb ? parseItems(pb.licenseItems) : [];
  const taxRateBps = pb?.taxRateBps ?? 1800;
  const active = sub && ["active", "past_due", "grace"].includes(sub.status);
  const nextStart = active && sub!.currentPeriodEnd ? sub!.currentPeriodEnd : now;
  const base = active
    ? sub!.items.map((it) => ({ code: it.code, name: catalog.find((c) => c.code === it.code)?.name ?? it.code, quantity: it.pendingQuantity ?? it.quantity, unitPriceMinor: it.unitPriceMinor }))
    : catalog.map((c) => ({ code: c.code, name: c.name, quantity: 1, unitPriceMinor: c.unitPriceMinor }));
  const credits = await openCredits(businessId);
  const current = await termsAt(businessId, nextStart);
  const before = price(base, current.terms, credits, taxRateBps, nextStart);
  const after = price(base, proposed, [...credits, ...(extraCreditMinor > 0 ? [{ id: "new", remainingMinor: extraCreditMinor }] : [])], taxRateBps, nextStart);
  const warnings: string[] = [];
  if (proposed.discount && credits.length + (extraCreditMinor > 0 ? 1 : 0) > 0) warnings.push("יש גם הנחה חוזרת וגם זיכוי פתוח – שניהם יחולו על החיוב הבא (ההנחה קודם, אחריה הזיכוי), עד 0 ולא מתחת.");
  if (proposed.discount && after.discountMinor === 0 && discountActive(proposed.discount, nextStart)) warnings.push("ההנחה לא משנה את החיוב הבא (אין רישיונות בתשלום).");
  if (proposed.discount && !discountActive(proposed.discount, nextStart)) warnings.push("ההנחה לא תחול על החיוב הבא – תאריך ההתחלה אחריו או שהיא מסתיימת לפניו.");
  if (proposed.discount?.type === "fixed" && after.licensesMinor > 0 && proposed.discount.amountMinor! > after.licensesMinor) warnings.push(`ההנחה גבוהה מסכום הרישיונות – תוגבל ל-${ils(after.licensesMinor)} (לא מתחת ל-0).`);
  return {
    subscription: active ? { status: sub!.status, nextRenewalAt: nextStart } : null,
    basis: active ? "החיוב החודשי הבא לפי הרישיונות שנרכשו" : "אין מנוי פעיל – מוצג מחיר חודשי לרישיון אחד מכל סוג (לא מתבצע חיוב)",
    currentVersion: current.version, before, after, deltaMinor: after.totalMinor - before.totalMinor, warnings,
  };
}

export const saveSchema = z.object({ terms: termsSchema, effectiveFrom: z.string().datetime(), note: z.string().max(300).optional(), expectedTotalMinor: z.number().int(), /** Only to reproduce the preview that was shown (a credit is added separately). */ creditMinor: z.number().int().min(0).default(0) });
/** Save a new pricing version (platform admin). The preview total must match what was shown (no silent change). */
export async function savePricing(actor: SessionUser, businessId: string, raw: unknown) {
  const b = parseOr400(saveSchema, raw);
  const { publishedVersion, parseItems, USAGE_SERVICES } = await import("./pricebook");
  const pb = await withoutBusiness(() => publishedVersion());
  const codes = new Set((pb ? parseItems(pb.licenseItems) : []).map((c) => c.code));
  for (const code of Object.keys(b.terms.licensePrices)) if (!codes.has(code)) throw new ApiError(`רישיון לא קיים במחירון: ${code}`, 400, "unknown_license");
  for (const svc of Object.keys(b.terms.usageRates)) if (!USAGE_SERVICES.some((s) => s.service === svc)) throw new ApiError(`שירות שימוש לא מוכר: ${svc}`, 400, "unknown_service");
  const effectiveFrom = new Date(b.effectiveFrom);
  if (effectiveFrom.getTime() < Date.now() - 5 * 60_000) throw new ApiError("אי אפשר לשנות מחיר רטרואקטיבית – מועד התחולה חייב להיות מעכשיו והלאה", 400, "retroactive");
  const preview = await previewPricing(businessId, b.terms, b.creditMinor);
  if (preview.after.totalMinor !== b.expectedTotalMinor) throw new ApiError("הסכום השתנה מאז התצוגה המקדימה – יש להציג שוב", 409, "preview_changed", { preview });
  return withoutBusiness(async () => db.$transaction(async (tx) => {
    const biz = await tx.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!biz) throw new ApiError("העסק לא נמצא", 404, "not_found");
    const last = await tx.businessPricing.findFirst({ where: { businessId }, orderBy: { version: "desc" }, select: { version: true, licensePrices: true, discount: true, usageRates: true } });
    const row = await tx.businessPricing.create({ data: { businessId, version: (last?.version ?? 0) + 1, effectiveFrom, licensePrices: b.terms.licensePrices, discount: b.terms.discount ?? undefined, usageRates: b.terms.usageRates, note: b.note ?? null, createdByAccountId: actor.accountId } });
    await tx.accessAuditLog.create({ data: { businessId, actorAccountId: actor.accountId, action: "pricing.version_created", before: (last ?? undefined) as object | undefined, after: { version: row.version, effectiveFrom, ...b.terms, note: b.note ?? null, nextBill: { before: preview.before.totalMinor, after: preview.after.totalMinor } } as object } });
    const { invalidateRates } = await import("./usage");
    invalidateRates(businessId);
    return { version: row.version, preview };
  }));
}

export const creditSchema = z.object({ amountMinor: z.number().int().min(1).max(100_000_000), reason: z.string().trim().min(2).max(200) });
export async function addCredit(actor: SessionUser, businessId: string, raw: unknown) {
  const b = parseOr400(creditSchema, raw);
  return withoutBusiness(async () => {
    const c = await db.billingCredit.create({ data: { businessId, amountMinor: b.amountMinor, remainingMinor: b.amountMinor, reason: b.reason, createdByAccountId: actor.accountId } });
    await db.accessAuditLog.create({ data: { businessId, actorAccountId: actor.accountId, action: "pricing.credit_added", after: { creditId: c.id, amountMinor: b.amountMinor, reason: b.reason } } });
    return c;
  });
}
export async function cancelCredit(actor: SessionUser, businessId: string, creditId: string) {
  return withoutBusiness(async () => {
    const r = await db.billingCredit.updateMany({ where: { id: creditId, businessId, cancelledAt: null, applied: { equals: [] } }, data: { cancelledAt: new Date() } });
    if (!r.count) throw new ApiError("אפשר לבטל רק זיכוי שעוד לא נוצל", 409, "credit_used");
    await db.accessAuditLog.create({ data: { businessId, actorAccountId: actor.accountId, action: "pricing.credit_cancelled", after: { creditId } } });
    return { cancelled: creditId };
  });
}

/** Mark credits used by a document (inside the document's transaction). */
export async function consumeCredits(tx: Pick<typeof db, "billingCredit">, documentId: string, use: Priced["creditUse"]) {
  for (const u of use) {
    const c = await tx.billingCredit.findUniqueOrThrow({ where: { id: u.id } });
    const applied = [...((c.applied as Array<unknown>) ?? []), { documentId, amountMinor: u.amountMinor, at: new Date().toISOString() }];
    const r = await tx.billingCredit.updateMany({ where: { id: u.id, remainingMinor: { gte: u.amountMinor }, cancelledAt: null }, data: { remainingMinor: { decrement: u.amountMinor }, applied: applied as object } });
    if (!r.count) throw new Error(`credit ${u.id} changed while issuing ${documentId}`);
  }
}

/** Everything the platform admin's pricing card shows. */
export async function pricingOverview(businessId: string) {
  const { publishedVersion, parseItems, parseRates, USAGE_SERVICES } = await import("./pricebook");
  const pb = await withoutBusiness(() => publishedVersion());
  const [versions, credits, log] = await withoutBusiness(() => Promise.all([
    db.businessPricing.findMany({ where: { businessId }, orderBy: { version: "desc" }, take: 30 }),
    db.billingCredit.findMany({ where: { businessId }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.accessAuditLog.findMany({ where: { businessId, action: { startsWith: "pricing." } }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]));
  const now = await termsAt(businessId);
  return {
    priceBook: pb ? { version: pb.version, taxRateBps: pb.taxRateBps, items: parseItems(pb.licenseItems), rates: parseRates(pb.usageRates) } : null,
    services: USAGE_SERVICES, current: now, versions, credits, log,
  };
}
