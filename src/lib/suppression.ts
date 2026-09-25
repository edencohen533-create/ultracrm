/**
 * Global unsubscribe / do-not-contact (single source of truth).
 *
 *  • Any unsubscribe request (WhatsApp "הסר", SMS STOP, email link, agent action,
 *    import flag, "לא ליצור קשר" call outcome) blocks the contact from marketing
 *    on EVERY channel of the business. Scope `all` also blocks service messages
 *    and outbound calls (mirrored into the dialer's DNC list).
 *  • Applied to every phone and email linked to the contact.
 *  • Checked before each send (services) AND inside the worker right before the
 *    provider call (`assertSendAllowed`).
 *  • Queued-but-not-yet-sent campaign recipients / marketing automations are
 *    stopped; messages already handed to the provider are never re-labelled.
 *  • Re-import, list changes or a provider switch never revoke a suppression.
 *    Revocation requires documented re-consent (`revokeSuppressions`).
 */
import { prisma, type Db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/response";
import { emitEvent } from "@/lib/events";
import type { IdentifierType, SuppressionScope } from "@/generated/prisma/enums";

export interface SuppressInput {
  businessId: string;
  contactId?: string | null;
  /** E.164 phone or email – used when the request arrives for an identifier that is not (yet) a contact. */
  identifier?: string;
  scope?: SuppressionScope;
  /** whatsapp | sms | email | phone | manual | import | api */
  source: string;
  reason?: string;
  evidence?: string;
  actorId?: string | null;
  /** Unclear request: block marketing now, ask a manager to confirm/dismiss. */
  pendingReview?: boolean;
}

export interface ContactIdentifiers {
  phones: string[];
  emails: string[];
}

function normalizeEmail(email: string | null | undefined) {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

export function identifierType(identifier: string): IdentifierType {
  return identifier.includes("@") ? "email" : "phone";
}

/** Every phone + email linked to a contact (primary + additional). */
export async function contactIdentifiers(contactId: string, db: Db = prisma): Promise<ContactIdentifiers> {
  const c = await db.contact.findUnique({ where: { id: contactId }, select: { phoneE164: true, email: true, phones: { select: { e164: true } }, emails: { select: { email: true } } } });
  if (!c) return { phones: [], emails: [] };
  const phones = [...new Set([c.phoneE164, ...c.phones.map((p) => p.e164)].filter(Boolean))];
  const emails = [...new Set([normalizeEmail(c.email), ...c.emails.map((e) => normalizeEmail(e.email))].filter((e): e is string => Boolean(e)))];
  return { phones, emails };
}

/** Find the contact that owns an identifier (primary or additional phone / email). */
export async function contactForIdentifier(businessId: string, identifier: string, db: Db = prisma) {
  if (identifierType(identifier) === "phone") {
    const byPrimary = await db.contact.findFirst({ where: { businessId, phoneE164: identifier }, select: { id: true } });
    if (byPrimary) return byPrimary.id;
    const extra = await db.contactPhone.findFirst({ where: { businessId, e164: identifier }, select: { contactId: true } });
    return extra?.contactId ?? null;
  }
  const email = identifier.toLowerCase();
  const byPrimary = await db.contact.findFirst({ where: { businessId, email }, select: { id: true } });
  if (byPrimary) return byPrimary.id;
  const extra = await db.contactEmail.findFirst({ where: { businessId, email }, select: { contactId: true } });
  return extra?.contactId ?? null;
}

/** Active suppressions covering any of the identifiers. */
export async function activeSuppressions(businessId: string, identifiers: string[], db: Db = prisma) {
  if (!identifiers.length) return [];
  return db.suppression.findMany({ where: { businessId, identifier: { in: identifiers }, revokedAt: null }, select: { id: true, identifier: true, scope: true, source: true, reason: true, createdAt: true, contactId: true, pendingReview: true, messageId: true } });
}

/**
 * Is a contact allowed to receive a message of this category?
 * Returns a Hebrew reason when blocked, otherwise null. Marketing is blocked by
 * any active suppression; service messages only by scope `all` (or a hard block).
 */
export async function sendBlockReason(businessId: string, contactId: string, category: "service" | "marketing", db: Db = prisma): Promise<string | null> {
  const ids = await contactIdentifiers(contactId, db);
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { isBlocked: true, consentStatus: true } });
  if (!contact) return "איש הקשר לא נמצא";
  if (contact.isBlocked) return "איש הקשר חסום לכל שליחה";
  const active = await activeSuppressions(businessId, [...ids.phones, ...ids.emails], db);
  if (active.some((s) => s.scope === "all")) return "איש הקשר ביקש שלא ליצור עמו קשר";
  if (category === "marketing") {
    if (active.some((s) => s.pendingReview)) return "בקשת הסרה ממתינה לבדיקת מנהל – הדיוור מושהה";
    if (active.length) return "איש הקשר הוסר מכל הדיוור השיווקי";
    if (contact.consentStatus !== "OPTED_IN") return "איש הקשר אינו מאשר קבלת דיוור";
  }
  return null;
}

/** Same check for an outbound call (scope `all` and the DNC list). */
export async function callBlockReason(businessId: string, phoneE164: string, db: Db = prisma): Promise<string | null> {
  const dnc = await db.dncEntry.findUnique({ where: { businessId_phoneE164: { businessId, phoneE164 } }, select: { id: true } });
  if (dnc) return "המספר חסום – לא ליצור קשר";
  const active = await db.suppression.findFirst({ where: { businessId, identifier: phoneE164, scope: "all", revokedAt: null }, select: { id: true } });
  return active ? "איש הקשר ביקש שלא ליצור עמו קשר" : null;
}

/** Throws right before the provider call. Used inside workers. */
export async function assertSendAllowed(businessId: string, contactId: string, category: "service" | "marketing", db: Db = prisma) {
  const reason = await sendBlockReason(businessId, contactId, category, db);
  if (reason) throw new ApiError(reason, 403, "suppressed");
}

/**
 * Record an unsubscribe / do-not-contact request. Idempotent: an existing active
 * suppression for the same identifier is widened (marketing → all) but never duplicated.
 */
export async function suppressContact(input: SuppressInput, db: Db = prisma) {
  const scope: SuppressionScope = input.scope ?? "marketing";
  const contactId = input.contactId ?? (input.identifier ? await contactForIdentifier(input.businessId, input.identifier, db) : null);
  const ids = contactId ? await contactIdentifiers(contactId, db) : { phones: [], emails: [] };
  const identifiers = new Set<string>([...ids.phones, ...ids.emails]);
  if (input.identifier) identifiers.add(identifierType(input.identifier) === "email" ? input.identifier.toLowerCase() : input.identifier);
  if (!identifiers.size) throw new ApiError("לא נמצא מזהה לחסימה", 400, "no_identifier");

  const created: string[] = [];
  for (const identifier of identifiers) {
    const existing = await db.suppression.findFirst({ where: { businessId: input.businessId, identifier, revokedAt: null } });
    if (existing) {
      if (existing.scope === "marketing" && scope === "all") await db.suppression.update({ where: { id: existing.id }, data: { scope: "all", reason: input.reason ?? existing.reason, evidence: input.evidence ?? existing.evidence, contactId: existing.contactId ?? contactId } });
      else if (!existing.contactId && contactId) await db.suppression.update({ where: { id: existing.id }, data: { contactId } });
      continue;
    }
    const row = await db.suppression.create({
      data: { businessId: input.businessId, contactId, identifier, identifierType: identifierType(identifier), scope, source: input.source, reason: input.reason ?? null, evidence: input.evidence ?? null, createdByUserId: input.actorId ?? null, pendingReview: Boolean(input.pendingReview) },
    });
    created.push(row.id);
  }

  if (contactId) {
    // A request held for review keeps the consent record untouched (only the block applies) until a manager confirms it.
    if (!input.pendingReview) await db.contact.update({
      where: { id: contactId },
      data: { consentStatus: "OPTED_OUT", consentAt: new Date(), consentSource: input.source, consentScope: scope, consentEvidence: input.evidence ?? input.reason ?? null, ...(scope === "all" ? { isBlocked: true } : {}) },
    });
    await stopPendingMarketing(input.businessId, contactId, scope, db);
    if (scope === "all") {
      const { addToDnc } = await import("@/lib/dialer/queue");
      for (const phone of ids.phones) await addToDnc(input.businessId, input.actorId ?? null, phone, `suppression:${input.source}`, db, { skipSuppression: true });
    }
  }

  await audit(input.businessId, input.actorId ?? null, "contact", contactId ?? input.identifier ?? "unknown", input.pendingReview ? "contact.suppression_review_requested" : "contact.suppressed", { scope, source: input.source, reason: input.reason, identifiers: [...identifiers], created: created.length }, db);
  await emitEvent(db, {
    businessId: input.businessId,
    type: "contact.suppressed",
    contactId,
    actorUserId: input.actorId ?? null,
    source: input.actorId ? "user" : "webhook",
    dedupeKey: `contact.suppressed:${contactId ?? input.identifier}:${scope}:${created[0] ?? "existing"}:${Date.now()}`,
    payload: { scope, source: input.source, reason: input.reason ?? null, identifiers: [...identifiers], pendingReview: Boolean(input.pendingReview) },
  });
  return { contactId, identifiers: [...identifiers], created: created.length };
}

/**
 * Resolve a request that was held for review. `confirm` keeps the block and records the consent
 * change; `dismiss` lifts ONLY the pending-review rows (documented reason required) – a confirmed
 * or clear unsubscribe is never removed this way.
 */
export async function reviewSuppression(businessId: string, suppressionId: string, action: "confirm" | "dismiss", actorId: string, note: string, db: Db = prisma) {
  const row = await db.suppression.findFirst({ where: { id: suppressionId, businessId, pendingReview: true, revokedAt: null } });
  if (!row) throw new ApiError("הבקשה לא נמצאה או שכבר טופלה", 404, "not_found");
  if (action === "dismiss" && note.trim().length < 5) throw new ApiError("נדרש נימוק (לפחות 5 תווים) לביטול בקשה שממתינה לבדיקה", 400, "evidence_required");
  const siblings = await db.suppression.findMany({ where: { businessId, contactId: row.contactId ?? undefined, ...(row.contactId ? {} : { identifier: row.identifier }), pendingReview: true, revokedAt: null } });
  const ids = siblings.map((s) => s.id);
  if (action === "confirm") {
    await db.suppression.updateMany({ where: { id: { in: ids } }, data: { pendingReview: false, reviewedAt: new Date(), reviewedByUserId: actorId, reason: note.trim() ? `${row.reason ?? ""} · אושר: ${note.trim()}` : row.reason } });
    if (row.contactId) await db.contact.update({ where: { id: row.contactId }, data: { consentStatus: "OPTED_OUT", consentAt: new Date(), consentSource: row.source, consentScope: row.scope, consentEvidence: row.evidence ?? row.reason ?? null } });
  } else {
    await db.suppression.updateMany({ where: { id: { in: ids } }, data: { pendingReview: false, reviewedAt: new Date(), reviewedByUserId: actorId, revokedAt: new Date(), revokedByUserId: actorId, revokeEvidence: `לא בקשת הסרה: ${note.trim()}` } });
  }
  await audit(businessId, actorId, "contact", row.contactId ?? row.identifier, action === "confirm" ? "contact.suppression_review_confirmed" : "contact.suppression_review_dismissed", { suppressionIds: ids, note }, db);
  return { resolved: ids.length };
}

/**
 * Stop what has not reached the provider yet: queued campaign recipients and
 * pending marketing automation runs. Never touches PROCESSING/SENT rows.
 */
export async function stopPendingMarketing(businessId: string, contactId: string, scope: SuppressionScope, db: Db = prisma) {
  const recipients = await db.campaignRecipient.updateMany({
    where: { contactId, status: "QUEUED", campaign: { businessId } },
    data: { status: "SKIPPED", error: "הנמען הוסר מהדיוור", completedAt: new Date() },
  });
  // Cross-channel sequences in flight for this contact stop at the next step.
  await db.sequenceRun.updateMany({ where: { businessId, contactId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "STOPPED", stopReason: "unsubscribe", completedAt: new Date() } });
  // Marketing messages persisted but not yet handed to a provider are cancelled (never re-labelled once accepted).
  await db.message.updateMany({ where: { businessId, category: "marketing", status: "QUEUED", direction: "OUTBOUND", conversation: { contactId } }, data: { status: "CANCELLED", errorReason: "הנמען הוסר מהדיוור", failedAt: new Date() } });
  const pending = await db.automationRun.findMany({
    where: { businessId, status: "PENDING", conversation: { contactId } },
    select: { id: true, triggerPayload: true },
  });
  let stopped = 0;
  for (const run of pending) {
    const payload = (run.triggerPayload ?? {}) as { actionType?: string; actionConfig?: { templateId?: string } };
    let marketing = scope === "all";
    if (!marketing && payload.actionType === "SEND_TEMPLATE" && payload.actionConfig?.templateId) {
      const t = await db.template.findUnique({ where: { id: payload.actionConfig.templateId }, select: { category: true } });
      marketing = t?.category === "MARKETING";
    }
    if (!marketing) continue;
    const r = await db.automationRun.updateMany({ where: { id: run.id, status: "PENDING" }, data: { status: "COMPLETED", result: { skipped: "contact suppressed" }, completedAt: new Date() } });
    stopped += r.count;
  }
  return { recipientsSkipped: recipients.count, automationsStopped: stopped };
}

/** Revoke every active suppression of a contact. Requires documented re-consent. */
export async function revokeSuppressions(businessId: string, contactId: string, actorId: string, evidence: string, db: Db = prisma) {
  if (!evidence || evidence.trim().length < 5) throw new ApiError("נדרש תיעוד הסכמה מחודשת (לפחות 5 תווים)", 400, "evidence_required");
  const ids = await contactIdentifiers(contactId, db);
  const identifiers = [...ids.phones, ...ids.emails];
  const active = await activeSuppressions(businessId, identifiers, db);
  const hadAll = active.some((s) => s.scope === "all");
  const r = await db.suppression.updateMany({ where: { businessId, identifier: { in: identifiers }, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: actorId, revokeEvidence: evidence.trim() } });
  await db.contact.update({ where: { id: contactId }, data: { consentStatus: "OPTED_IN", consentAt: new Date(), consentSource: "re-consent", consentScope: "marketing", consentEvidence: evidence.trim(), ...(hadAll ? { isBlocked: false } : {}) } });
  if (hadAll) {
    const { removeFromDnc } = await import("@/lib/dialer/queue");
    for (const phone of ids.phones) await removeFromDnc(businessId, actorId, phone, db);
  }
  await audit(businessId, actorId, "contact", contactId, "contact.resubscribed", { revoked: r.count, evidence: evidence.trim() }, db);
  await emitEvent(db, { businessId, type: "contact.resubscribed", contactId, actorUserId: actorId, source: "user", dedupeKey: `contact.resubscribed:${contactId}:${Date.now()}`, payload: { revoked: r.count } });
  return { revoked: r.count };
}

/** Removing a full block allows service/calls only; marketing opt-out remains active. */
export async function releaseFullBlock(businessId: string, contactId: string, actorId: string, evidence: string, db: Db = prisma) {
  if (evidence.trim().length < 5) throw new ApiError("נדרש תיעוד לביטול חסימה (לפחות 5 תווים)", 400, "evidence_required");
  const ids = await contactIdentifiers(contactId, db);
  await db.suppression.updateMany({ where: { businessId, identifier: { in: [...ids.phones, ...ids.emails] }, scope: "all", revokedAt: null }, data: { scope: "marketing" } });
  await db.contact.update({ where: { id: contactId }, data: { isBlocked: false } });
  const { removeFromDnc } = await import("@/lib/dialer/queue");
  for (const phone of ids.phones) await removeFromDnc(businessId, actorId, phone, db);
  await audit(businessId, actorId, "contact", contactId, "contact.full_block_removed", { evidence: evidence.trim(), marketingConsentUnchanged: true }, db);
}

/** Summary for a contact card. */
export async function suppressionSummary(businessId: string, contactId: string, db: Db = prisma) {
  const ids = await contactIdentifiers(contactId, db);
  const active = await activeSuppressions(businessId, [...ids.phones, ...ids.emails], db);
  const history = await db.suppression.findMany({ where: { businessId, contactId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, identifier: true, scope: true, source: true, reason: true, evidence: true, createdAt: true, revokedAt: true, revokeEvidence: true } });
  return {
    marketingBlocked: active.length > 0,
    fullyBlocked: active.some((s) => s.scope === "all"),
    active,
    history,
  };
}
