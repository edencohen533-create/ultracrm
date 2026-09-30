/**
 * UltraCRM's own price book (what businesses pay UltraCRM). Versioned: a published version is never edited – a price
 * change is a new version, and subscriptions / documents keep the version they were priced with. Usage services
 * without a rate are NOT free: commercial use of them is blocked until the platform sets a rate (nothing is invented).
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { ModuleKey } from "@/lib/access/catalog";

export interface LicenseItem { code: string; modules: ModuleKey[]; name: string; kind: "per_license" | "per_business"; unitPriceMinor: number }
export interface UsageRate { service: string; unit: string; unitPriceMinor: number | null; billingIncrementSec?: number | null; note?: string | null }

/** Launch prices (monthly, before tax and usage) – created as a DRAFT; publishing is an explicit platform action. */
export const LAUNCH_ITEMS: LicenseItem[] = [
  { code: "crm", modules: ["crm"], name: "CRM", kind: "per_license", unitPriceMinor: 4900 },
  { code: "whatsapp", modules: ["whatsapp"], name: "WhatsApp", kind: "per_license", unitPriceMinor: 19900 },
  { code: "dialer_ai", modules: ["telephony"], name: "חייגן ויכולות AI", kind: "per_license", unitPriceMinor: 19900 },
  { code: "marketing", modules: ["sms", "email"], name: "אימייל ו-SMS מרקטינג", kind: "per_business", unitPriceMinor: 9900 },
];
/** Metered services – listed so their rate status is visible; none is priced until the platform decides. */
export const USAGE_SERVICES: Array<{ service: string; unit: string; label: string; module: ModuleKey }> = [
  { service: "call_minute", unit: "minute", label: "דקות שיחה יוצאת/נכנסת", module: "telephony" },
  { service: "phone_number_month", unit: "number_month", label: "מספר טלפון חודשי", module: "telephony" },
  { service: "recording_minute", unit: "minute", label: "הקלטה", module: "telephony" },
  { service: "transcription_minute", unit: "minute", label: "תמלול", module: "telephony" },
  { service: "ai_summary", unit: "summary", label: "סיכום AI לשיחה", module: "telephony" },
  { service: "ai_action", unit: "action", label: "פעולת עוזר AI", module: "crm" },
  { service: "whatsapp_message", unit: "message", label: "הודעת WhatsApp (לפי קטגוריה)", module: "whatsapp" },
  { service: "sms_segment", unit: "segment", label: "מקטע SMS", module: "sms" },
  { service: "email_send", unit: "email", label: "שליחת אימייל", module: "email" },
  { service: "storage_gb_month", unit: "gb_month", label: "אחסון מעבר למכסה", module: "crm" },
];

const itemSchema = z.object({ code: z.string().regex(/^[a-z_]{2,40}$/), modules: z.array(z.enum(["crm", "telephony", "whatsapp", "sms", "email"])).min(1), name: z.string().min(1).max(80), kind: z.enum(["per_license", "per_business"]), unitPriceMinor: z.number().int().min(0).max(10_000_000) });
const rateSchema = z.object({ service: z.string().regex(/^[a-z_]{2,40}$/), unit: z.string().max(30), unitPriceMinor: z.number().int().min(0).max(10_000_000).nullable(), billingIncrementSec: z.number().int().min(1).max(3600).nullable().optional(), note: z.string().max(200).nullable().optional() });
export const versionInputSchema = z.object({ licenseItems: z.array(itemSchema).min(1).max(20), usageRates: z.array(rateSchema).max(50).default([]), taxRateBps: z.number().int().min(0).max(5000).default(1800), note: z.string().max(300).optional() });

export const parseItems = (v: unknown) => z.array(itemSchema).parse(v) as LicenseItem[];
export const parseRates = (v: unknown) => z.array(rateSchema).parse(v) as UsageRate[];

/** Ensure the launch price book exists as a draft (idempotent). */
export async function ensureLaunchDraft() {
  const any = await db.priceBookVersion.findFirst({ select: { id: true } });
  if (any) return null;
  return db.priceBookVersion.create({ data: { version: 1, currency: "ILS", licenseItems: LAUNCH_ITEMS as unknown as Prisma.InputJsonValue, usageRates: [], taxRateBps: 1800, status: "draft", note: "מחירי פתיחה – טיוטה עד פרסום מפורש" } });
}

export async function createVersion(actorAccountId: string, input: unknown) {
  const b = versionInputSchema.parse(input);
  const last = await db.priceBookVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  return db.priceBookVersion.create({ data: { version: (last?.version ?? 0) + 1, licenseItems: b.licenseItems as unknown as Prisma.InputJsonValue, usageRates: b.usageRates as unknown as Prisma.InputJsonValue, taxRateBps: b.taxRateBps, note: b.note ?? null, createdById: actorAccountId } });
}

/** Publishing makes a version the one NEW purchases use. Existing subscriptions keep theirs until an explicit change. */
export async function publishVersion(id: string) {
  const v = await db.priceBookVersion.findUnique({ where: { id } });
  if (!v) throw new ApiError("הגרסה לא נמצאה", 404, "not_found");
  if (v.status === "published") return v;
  return db.$transaction(async (tx) => {
    await tx.priceBookVersion.updateMany({ where: { status: "published" }, data: { status: "superseded" } });
    return tx.priceBookVersion.update({ where: { id }, data: { status: "published", publishedAt: new Date() } });
  });
}

export async function publishedVersion() {
  return db.priceBookVersion.findFirst({ where: { status: "published" }, orderBy: { version: "desc" } });
}
export async function versionByNumber(version: number) { return db.priceBookVersion.findUnique({ where: { version } }); }
export async function versionById(id: string) { return db.priceBookVersion.findUnique({ where: { id } }); }

/** Rate of a metered service in a version – null means "no rate" (never treated as zero). */
export function rateOf(rates: UsageRate[], service: string): UsageRate | null {
  const r = rates.find((x) => x.service === service);
  return r && r.unitPriceMinor !== null ? r : null;
}
