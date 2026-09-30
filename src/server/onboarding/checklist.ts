/**
 * Onboarding checklist – computed from real data (never ticked by hand), so it is the shared progress for this wizard
 * and any future channel (e.g. a WhatsApp onboarding agent – none exists yet): business.settings.onboarding keeps only
 * the chosen path. Required vs optional depends on the path (our CRM, or an external CRM + dialer / WhatsApp only).
 * The wizard only links to the screens that do each step – it never starts dialing, sending or campaigns itself.
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { businessEntitlement } from "@/lib/access/engine";

export async function onboardingChecklist(user: SessionUser) {
  const b = user.businessId;
  const [biz, sub, paid, numbers, wa, agents, licensed, leads, crm, calls, documented, usage, stores, pay, meta] = await Promise.all([
    db.business.findUniqueOrThrow({ where: { id: b }, select: { name: true, timezone: true, accessStatus: true, settings: true } }),
    db.subscription.findUnique({ where: { businessId: b }, select: { status: true, items: { select: { code: true, quantity: true } } } }),
    db.billingDocument.count({ where: { businessId: b, status: "paid" } }),
    db.phoneNumber.count({ where: { businessId: b, isActive: true } }),
    db.providerCredential.count({ where: { businessId: b, channel: "whatsapp", isActive: true } }),
    db.user.count({ where: { businessId: b, isActive: true, isSupport: false, role: { not: "owner" } } }),
    db.user.count({ where: { businessId: b, isActive: true, isSupport: false, OR: [{ permissions: { path: ["ownerLicenses"], array_contains: ["telephony"] } }, { permissions: { path: ["modules", "telephony", "enabled"], equals: true } }, { permissions: { path: ["modules", "whatsapp", "enabled"], equals: true } }] } }),
    db.lead.count({ where: { businessId: b } }),
    db.crmConnection.count({ where: { businessId: b, status: "active" } }),
    db.call.count({ where: { businessId: b } }),
    db.call.count({ where: { businessId: b, outcomeSavedAt: { not: null } } }),
    db.usageEvent.count({ where: { businessId: b } }),
    db.storeConnection.count({ where: { businessId: b, isActive: true } }),
    db.paymentProviderConnection.count({ where: { businessId: b, isActive: true } }),
    db.metaAdConnection.count({ where: { businessId: b } }),
  ]);
  const ent = await businessEntitlement(b);
  const path = ((biz.settings as { onboarding?: { path?: string } } | null)?.onboarding?.path ?? "own_crm") as "own_crm" | "external_crm";
  const tel = ent.modules.telephony.included; const wap = ent.modules.whatsapp.included;
  const steps = [
    { key: "business", title: "פרטי העסק", required: true, done: Boolean(biz.name && biz.timezone), href: "/settings?tab=business" },
    { key: "plan", title: "בחירת מודולים ורישיונות", required: true, done: Boolean(sub && sub.items.some((i) => i.quantity > 0)), href: "/settings/billing" },
    { key: "payment", title: "תשלום מאומת מול ספק החיוב", required: true, done: paid > 0 && sub?.status === "active", href: "/settings/billing" },
    ...(tel ? [{ key: "telephony", title: "חיבור טלפוניה ומספר יוצא", required: true, done: numbers > 0, href: "/settings?tab=connections" }] : []),
    ...(wap ? [{ key: "whatsapp", title: "חיבור WhatsApp", required: true, done: wa > 0, href: "/settings/whatsapp" }] : []),
    { key: "external_crm", title: "חיבור ה-CRM החיצוני", required: path === "external_crm", done: crm > 0, href: "/settings/crm" },
    { key: "agent", title: "הוספת נציג והקצאת רישיון", required: true, done: agents > 0 && licensed > 0, href: "/settings?tab=users" },
    { key: "lead", title: path === "external_crm" ? "קליטת פנייה מה-CRM החיצוני" : "ייבוא או קליטת ליד", required: true, done: leads > 0, href: path === "external_crm" ? "/settings/crm" : "/leads" },
    ...(tel ? [{ key: "test_call", title: "שיחת בדיקה (למספר שלכם בלבד)", required: true, done: calls > 0, href: "/calling/ready" }, { key: "documented", title: "תיעוד תוצאת השיחה", required: true, done: documented > 0, href: "/calling/history" }] : []),
    { key: "usage", title: "השימוש מופיע בחשבון", required: true, done: usage > 0, href: "/settings/billing" },
    { key: "store", title: "חיבור חנות (WooCommerce)", required: false, done: stores > 0, href: "/settings?tab=connections" },
    { key: "payments", title: "סליקה ללקוחות שלכם", required: false, done: pay > 0, href: "/settings?tab=connections" },
    { key: "meta_ads", title: "חשבון פרסום Meta", required: false, done: meta > 0, href: "/settings?tab=connections" },
  ];
  const required = steps.filter((s) => s.required);
  return { path, steps, requiredDone: required.filter((s) => s.done).length, requiredTotal: required.length, ready: required.every((s) => s.done), note: "הרשימה מחושבת מהנתונים בפועל. האשף לא מחייג, לא שולח ולא מפעיל קמפיינים – רק מפנה למסך המתאים." };
}

export async function setOnboardingPath(user: SessionUser, path: "own_crm" | "external_crm") {
  const b = await db.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { settings: true } });
  const s = (b.settings ?? {}) as Record<string, unknown>;
  await db.business.update({ where: { id: user.businessId }, data: { settings: { ...s, onboarding: { ...((s.onboarding as object) ?? {}), path } } as Prisma.InputJsonValue } });
  return onboardingChecklist(user);
}
