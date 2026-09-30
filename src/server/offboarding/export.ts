/**
 * Business data export (owner only, audited): a ZIP of UTF-8 CSV files + a manifest. Recordings and attached files
 * are NOT copied into the file: the manifest lists them with links inside UltraCRM that require signing in and the
 * matching permission (never a public link); recordings live at the telephony provider.
 */
import { zipSync, strToU8 } from "fflate";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { appBase } from "@/lib/store-urls";

const LIMIT = 200_000;
const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`; };
function csv(rows: Array<Record<string, unknown>>) { if (!rows.length) return "﻿"; const head = Object.keys(rows[0]); return "﻿" + [head.map(cell).join(","), ...rows.map((r) => head.map((h) => cell(r[h])).join(","))].join("\r\n"); }

export async function exportBusiness(user: SessionUser) {
  if (user.role !== "owner" || user.supportSessionId) throw new ApiError("ייצוא נתוני העסק – לבעל העסק בלבד", 403, "forbidden");
  const b = user.businessId; const take = LIMIT;
  const [biz, contacts, phones, leads, deals, tasks, notes, calls, conversations, messages, touchpoints, users, usage, documents, attachments] = await Promise.all([
    db.business.findUniqueOrThrow({ where: { id: b }, select: { id: true, name: true, timezone: true, createdAt: true } }),
    db.contact.findMany({ where: { businessId: b }, take, select: { id: true, fullName: true, phoneE164: true, email: true, company: true, city: true, source: true, notes: true, consentStatus: true, isBlocked: true, customFields: true, ownerUserId: true, createdAt: true } }),
    db.contactPhone.findMany({ where: { businessId: b }, take, select: { contactId: true, e164: true, label: true } }),
    db.lead.findMany({ where: { businessId: b }, take, select: { id: true, contactId: true, title: true, status: true, source: true, ownerUserId: true, notes: true, sourceAttribution: true, createdAt: true, closedAt: true } }),
    db.deal.findMany({ where: { businessId: b }, take, select: { id: true, contactId: true, leadId: true, title: true, amount: true, currency: true, stage: true, status: true, ownerUserId: true, closedAt: true, createdAt: true } }),
    db.task.findMany({ where: { businessId: b }, take, select: { id: true, contactId: true, leadId: true, userId: true, type: true, title: true, note: true, dueAt: true, status: true, createdAt: true } }),
    db.note.findMany({ where: { businessId: b }, take, select: { id: true, contactId: true, body: true, createdAt: true } }),
    db.call.findMany({ where: { businessId: b }, take, select: { id: true, contactId: true, userId: true, direction: true, mode: true, toE164: true, fromE164: true, createdAt: true, answeredAt: true, endedAt: true, talkSeconds: true, telephonyResult: true, outcome: true, outcomeNote: true, recordingStatus: true } }),
    db.conversation.findMany({ where: { businessId: b }, take, select: { id: true, contactId: true, channel: true, status: true, createdAt: true } }),
    db.message.findMany({ where: { businessId: b }, take, select: { id: true, conversationId: true, channel: true, direction: true, type: true, body: true, status: true, createdAt: true } }),
    db.leadTouchpoint.findMany({ where: { businessId: b }, take, select: { contactId: true, leadId: true, channel: true, source: true, adId: true, adsetId: true, campaignId: true, basis: true, occurredAt: true } }),
    db.user.findMany({ where: { businessId: b, isSupport: false }, select: { id: true, fullName: true, email: true, role: true, isActive: true, createdAt: true } }),
    db.usageEvent.findMany({ where: { businessId: b }, take, select: { occurredAt: true, module: true, service: true, kind: true, status: true, unit: true, quantity: true, billedQuantity: true, priceMinor: true, currency: true, priceBookVersion: true } }),
    db.billingDocument.findMany({ where: { businessId: b }, select: { number: true, kind: true, periodStart: true, periodEnd: true, subtotalMinor: true, taxMinor: true, totalMinor: true, currency: true, status: true, issuedAt: true, paidAt: true } }),
    db.messageAttachment.findMany({ where: { message: { businessId: b } }, take, select: { id: true, messageId: true, fileName: true, mimeType: true } }).catch(() => [] as Array<{ id: string; messageId: string; fileName: string | null; mimeType: string | null }>),
  ]);
  const base = appBase();
  const recordings = calls.filter((c) => c.recordingStatus === "saved").map((c) => ({ callId: c.id, url: `${base}/api/recordings/${c.id}`, access: "דורש התחברות והרשאת הקלטות" }));
  const files = attachments.map((a) => ({ attachmentId: a.id, messageId: a.messageId, fileName: a.fileName, mimeType: a.mimeType, url: `${base}/api/attachments/${a.id}`, access: "דורש התחברות לעסק" }));
  const counts = { contacts: contacts.length, leads: leads.length, deals: deals.length, tasks: tasks.length, notes: notes.length, calls: calls.length, messages: messages.length, recordings: recordings.length, files: files.length, usage_events: usage.length, billing_documents: documents.length };
  const manifest = { business: biz, exportedAt: new Date().toISOString(), exportedBy: user.email, format: "CSV (UTF-8 BOM) per table", counts, truncatedAt: LIMIT, truncated: Object.values(counts).some((n) => n >= LIMIT),
    notes: ["הקלטות וקבצים אינם בתוך הקובץ – ברשימות recordings.csv / files.csv יש קישורים שדורשים התחברות והרשאה.", "הקלטות נשמרות אצל ספק הטלפוניה; הזמינות שלהן תלויה בו.", "סכומים ב-billing ו-usage ביחידות אגורות (minor)."] };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), "contacts.csv": strToU8(csv(contacts)), "contact_phones.csv": strToU8(csv(phones)), "leads.csv": strToU8(csv(leads)), "deals.csv": strToU8(csv(deals.map((d) => ({ ...d, amount: d.amount.toString() })))),
    "tasks.csv": strToU8(csv(tasks)), "notes.csv": strToU8(csv(notes)), "calls.csv": strToU8(csv(calls)), "conversations.csv": strToU8(csv(conversations)), "messages.csv": strToU8(csv(messages)), "lead_sources.csv": strToU8(csv(touchpoints)),
    "users.csv": strToU8(csv(users)), "usage.csv": strToU8(csv(usage.map((u) => ({ ...u, quantity: u.quantity.toString(), billedQuantity: u.billedQuantity?.toString() ?? "" })))), "billing_documents.csv": strToU8(csv(documents)), "recordings.csv": strToU8(csv(recordings)), "files.csv": strToU8(csv(files)),
  }, { level: 6 });
  await audit(b, user.id, "business", b, "business.data_exported", { counts });
  return { zip, filename: `ultracrm-export-${biz.name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.zip`, counts };
}
