/**
 * CRM contacts – single source of truth for people. Messaging and telephony
 * reference `contactId`; this module owns identity (phones / emails), tags,
 * consent and duplicate detection.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma, type Db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { normalizePhone, phoneDigits } from "@/lib/phone";
import { audit } from "@/lib/audit";
import { consumeQuota } from "@/lib/modules";
import { assertTenantReferences } from "@/lib/tenant-references";
import { revokeSuppressions, releaseFullBlock, suppressContact, suppressionSummary, contactForIdentifier } from "@/lib/suppression";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ownerScope } from "./access";

export const contactFilterSchema = z.object({
  q: z.string().max(100).optional(),
  source: z.string().max(100).optional(),
  city: z.string().max(80).optional(),
  ownerUserId: z.string().optional(),
  tagId: z.string().optional(),
  consent: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  neverCalled: z.enum(["true", "false"]).optional(),
  notInListId: z.string().optional(),
  hasOpenLead: z.enum(["true", "false"]).optional(),
  /** Contacts that have an open lead owned by this user (personal dial queue). */
  leadOwnerUserId: z.string().optional(),
});
export type ContactFilter = z.infer<typeof contactFilterSchema>;

export function contactWhere(businessId: string, f: ContactFilter): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { businessId };
  if (f.q) {
    const digits = phoneDigits(f.q);
    where.OR = [
      { fullName: { contains: f.q, mode: "insensitive" } },
      { company: { contains: f.q, mode: "insensitive" } },
      { email: { contains: f.q, mode: "insensitive" } },
      { emails: { some: { email: { contains: f.q, mode: "insensitive" } } } },
      ...(digits.length >= 3 ? [{ phoneE164: { contains: digits.replace(/^0/, "") } }, { phoneRaw: { contains: digits } }, { phones: { some: { e164: { contains: digits.replace(/^0/, "") } } } }] : []),
    ];
  }
  if (f.source) where.source = f.source;
  if (f.city) where.city = { contains: f.city, mode: "insensitive" };
  if (f.ownerUserId) where.ownerUserId = f.ownerUserId;
  if (f.tagId) where.tags = { some: { tagId: f.tagId } };
  if (f.consent) where.consentStatus = f.consent;
  if (f.createdAfter || f.createdBefore) {
    where.createdAt = { ...(f.createdAfter ? { gte: new Date(f.createdAfter) } : {}), ...(f.createdBefore ? { lte: new Date(f.createdBefore) } : {}) };
  }
  if (f.neverCalled === "true") where.calls = { none: {} };
  if (f.notInListId) where.queueLeads = { none: { listId: f.notInListId } };
  if (f.hasOpenLead === "true") where.leads = { some: { status: { in: ["new", "contacted", "qualified"] } } };
  if (f.leadOwnerUserId) where.leads = { some: { status: { in: ["new", "contacted", "qualified"] }, ownerUserId: f.leadOwnerUserId } };
  return where;
}

const emailField = z.string().trim().toLowerCase().email().or(z.literal("")).optional();

export const contactInputSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().min(3).max(30),
  email: emailField,
  company: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  source: z.string().max(100).optional(),
  notes: z.string().max(4000).optional(),
  ownerUserId: z.string().nullable().optional(),
  customFields: z.record(z.string().max(100), z.unknown()).optional(),
  tagIds: z.array(z.string()).max(50).optional(),
  tagNames: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  consentStatus: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]).optional(),
  consentSource: z.string().max(200).optional(),
  consentEvidence: z.string().max(1000).optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

export const contactPatchSchema = contactInputSchema.partial().extend({
  isBlocked: z.boolean().optional(),
});

/**
 * Find the contact owning `e164` (primary or additional phone) or create a card.
 * Safe under concurrent inbound events: a unique-constraint race is resolved by re-reading.
 */
export async function findOrCreateContactByPhone(businessId: string, e164: string, create: { fullName: string; phoneRaw: string; source: string; ownerUserId?: string | null }, db: Db = prisma) {
  const existingId = await contactForIdentifier(businessId, e164, db);
  if (existingId) return db.contact.findUniqueOrThrow({ where: { id: existingId } });
  try {
    const created = await db.contact.create({ data: { businessId, fullName: create.fullName, phoneE164: e164, phoneRaw: create.phoneRaw, source: create.source, ownerUserId: create.ownerUserId ?? null } });
    // New lead from an inbound channel → sequences with a CONTACT_CREATED trigger (optionally filtered by source). CSV imports never emit this.
    const { emitEvent } = await import("@/lib/events");
    await emitEvent(db, { businessId, type: "contact.created", contactId: created.id, source: "system", dedupeKey: `contact.created:${created.id}`, payload: { source: create.source } }).catch(() => undefined);
    return created;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const again = await contactForIdentifier(businessId, e164, db);
      if (again) return db.contact.findUniqueOrThrow({ where: { id: again } });
    }
    throw err;
  }
}

/** Which contact already owns this phone (primary or additional)? */
export async function findDuplicateByPhone(businessId: string, e164: string, exceptId?: string, db: Db = prisma) {
  const id = await contactForIdentifier(businessId, e164, db);
  return id && id !== exceptId ? id : null;
}

export async function findDuplicateByEmail(businessId: string, email: string, exceptId?: string, db: Db = prisma) {
  const id = await contactForIdentifier(businessId, email.toLowerCase(), db);
  return id && id !== exceptId ? id : null;
}

async function syncTags(db: Db, businessId: string, contactId: string, tagIds?: string[], tagNames?: string[]) {
  if (tagIds === undefined && tagNames === undefined) return;
  const ids = new Set<string>(tagIds ?? []);
  if (ids.size) {
    const count = await db.tag.count({ where: { businessId, id: { in: [...ids] } } });
    if (count !== ids.size) throw new ApiError("תגית לא תקינה", 400, "invalid_tag");
  }
  for (const name of tagNames ?? []) {
    const tag = await db.tag.upsert({ where: { businessId_name: { businessId, name } }, update: {}, create: { businessId, name } });
    ids.add(tag.id);
  }
  const before = new Set((await db.contactTag.findMany({ where: { contactId }, select: { tagId: true } })).map((t) => t.tagId));
  await db.contactTag.deleteMany({ where: { contactId, tagId: { notIn: [...ids] } } });
  if (ids.size) await db.contactTag.createMany({ data: [...ids].map((tagId) => ({ contactId, tagId })), skipDuplicates: true });
  const added = [...ids].filter((id) => !before.has(id));
  if (added.length) {
    const { emitEvent } = await import("@/lib/events");
    const tags = await db.tag.findMany({ where: { id: { in: added } }, select: { id: true, name: true } });
    for (const tag of tags) await emitEvent(db, { businessId, type: "contact.tag_added", contactId, source: "user", dedupeKey: `contact.tag_added:${contactId}:${tag.id}:${Date.now()}`, payload: { tagId: tag.id, tagName: tag.name } });
  }
}

export const CONTACT_CARD_INCLUDE = {
  owner: { select: { id: true, fullName: true } },
  phones: { orderBy: { createdAt: "asc" } },
  emails: { orderBy: { createdAt: "asc" } },
  tags: { include: { tag: true } },
  leads: { orderBy: { createdAt: "desc" }, include: { owner: { select: { id: true, fullName: true } } } },
  deals: { orderBy: { createdAt: "desc" }, include: { owner: { select: { id: true, fullName: true } } } },
  queueLeads: { include: { list: { select: { id: true, name: true } } } },
} satisfies Prisma.ContactInclude;

/** Apply the same lead/deal visibility used by their list and detail APIs. */
export async function contactCardInclude(user: SessionUser) {
  const scope = ownerScope(await visibleUserIds(user));
  return { ...CONTACT_CARD_INCLUDE,
    leads: { ...CONTACT_CARD_INCLUDE.leads, where: scope },
    deals: { ...CONTACT_CARD_INCLUDE.deals, where: scope },
  } satisfies Prisma.ContactInclude;
}

export async function createContact(user: SessionUser, input: ContactInput) {
  const businessId = user.businessId;
  const e164 = normalizePhone(input.phone);
  if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  const dupPhone = await findDuplicateByPhone(businessId, e164);
  if (dupPhone) throw new ApiError("איש קשר עם מספר זה כבר קיים", 409, "duplicate_phone", { contactId: dupPhone });
  const email = input.email ? input.email.toLowerCase() : null;
  if (email) {
    const dupEmail = await findDuplicateByEmail(businessId, email);
    if (dupEmail) throw new ApiError("איש קשר עם אימייל זה כבר קיים", 409, "duplicate_email", { contactId: dupEmail });
  }
  if (input.ownerUserId) await assertTenantReferences(businessId, { userIds: [input.ownerUserId] });
  await consumeQuota(businessId, "contacts");
  const contact = await prisma.$transaction(async (tx) => {
    const c = await tx.contact.create({
      data: {
        businessId,
        fullName: input.fullName,
        phoneE164: e164,
        phoneRaw: input.phone,
        email,
        company: input.company || null,
        city: input.city || null,
        source: input.source || "manual",
        notes: input.notes || null,
        ownerUserId: input.ownerUserId === undefined ? user.id : input.ownerUserId,
        customFields: (input.customFields as Prisma.InputJsonValue | undefined) ?? undefined,
        consentStatus: input.consentStatus ?? "UNKNOWN",
        consentAt: input.consentStatus && input.consentStatus !== "UNKNOWN" ? new Date() : null,
        consentSource: input.consentStatus ? input.consentSource || "manual" : null,
        consentScope: input.consentStatus ? "marketing" : null,
        consentEvidence: input.consentEvidence || null,
      },
    });
    await syncTags(tx, businessId, c.id, input.tagIds, input.tagNames);
    await audit(businessId, user.id, "contact", c.id, "contact.created", { fullName: c.fullName }, tx);
    const { emitEvent } = await import("@/lib/events");
    await emitEvent(tx, { businessId, type: "contact.created", contactId: c.id, actorUserId: user.id, source: "user", dedupeKey: `contact.created:${c.id}`, payload: { source: c.source ?? null } });
    return c;
  });
  if (input.consentStatus === "OPTED_OUT") await suppressContact({ businessId, contactId: contact.id, scope: "marketing", source: "manual", reason: input.consentEvidence ?? "created as opted out", actorId: user.id });
  return prisma.contact.findUniqueOrThrow({ where: { id: contact.id }, include: await contactCardInclude(user) });
}

/** Agents may edit contacts they own, hold in a dial list or have called; managers/owners edit all. */
export async function assertCanEditContact(user: SessionUser, contact: { id: string; ownerUserId: string | null }) {
  if (user.role !== "agent" || contact.ownerUserId === user.id) return;
  const held = await prisma.listLead.findFirst({ where: { contactId: contact.id, lockedByUserId: user.id }, select: { id: true } });
  const called = held ? null : await prisma.call.findFirst({ where: { contactId: contact.id, userId: user.id }, select: { id: true } });
  const chatted = held || called ? null : await prisma.conversation.findFirst({ where: { contactId: contact.id, assignedAgentId: user.id }, select: { id: true } });
  if (!held && !called && !chatted) throw new ApiError("אין הרשאה לערוך איש קשר זה", 403, "forbidden");
}

export async function updateContact(user: SessionUser, id: string, input: z.infer<typeof contactPatchSchema>) {
  const businessId = user.businessId;
  const c = await prisma.contact.findFirst({ where: { id, businessId } });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  await assertCanEditContact(user, c);
  if (user.role !== "agent" && input.ownerUserId) await assertTenantReferences(businessId, { userIds: [input.ownerUserId] });

  const data: Prisma.ContactUncheckedUpdateInput = {};
  if (input.fullName !== undefined) data.fullName = input.fullName;
  if (input.company !== undefined) data.company = input.company || null;
  if (input.city !== undefined) data.city = input.city || null;
  if (input.source !== undefined) data.source = input.source || null;
  if (input.notes !== undefined) data.notes = input.notes || null;
  if (input.customFields !== undefined) data.customFields = input.customFields as Prisma.InputJsonValue;
  if (input.ownerUserId !== undefined && user.role !== "agent") data.ownerUserId = input.ownerUserId;
  if (input.email !== undefined) {
    const email = input.email ? input.email.toLowerCase() : null;
    if (email) {
      const dup = await findDuplicateByEmail(businessId, email, c.id);
      if (dup) throw new ApiError("אימייל זה שייך לאיש קשר אחר", 409, "duplicate_email", { contactId: dup });
    }
    data.email = email;
    // A new address starts with a clean deliverability record (a previous hard bounce belonged to the old one).
    if (email !== c.email) { data.emailStatus = null; data.emailBouncedAt = null; }
  }
  if (input.phone !== undefined) {
    const e164 = normalizePhone(input.phone);
    if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
    const dup = await findDuplicateByPhone(businessId, e164, c.id);
    if (dup) throw new ApiError("מספר זה שייך לאיש קשר אחר", 409, "duplicate_phone", { contactId: dup });
    data.phoneE164 = e164;
    data.phoneRaw = input.phone;
  }

  if (input.isBlocked === true && input.consentStatus === "OPTED_IN") throw new ApiError("לא ניתן לחסום ולהסכים לדיוור באותה פעולה", 400, "conflicting_consent");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "contacts" WHERE id = ${c.id} FOR UPDATE`;
    await tx.contact.update({ where: { id: c.id }, data });
    await syncTags(tx, businessId, c.id, input.tagIds, input.tagNames);
    await audit(businessId, user.id, "contact", c.id, "contact.updated", { fields: Object.keys(input) }, tx);
    let summary = await suppressionSummary(businessId, c.id, tx);
    if (input.isBlocked === false && (summary.fullyBlocked || c.isBlocked)) {
      await releaseFullBlock(businessId, c.id, user.id, input.consentEvidence ?? "", tx);
      summary = await suppressionSummary(businessId, c.id, tx);
    }
    if (input.isBlocked === true) {
      await suppressContact({ businessId, contactId: c.id, scope: "all", source: "manual", reason: input.consentEvidence || "חסימה מלאה על ידי נציג", actorId: user.id }, tx);
    } else if (input.consentStatus === "OPTED_OUT") {
      await suppressContact({ businessId, contactId: c.id, scope: "marketing", source: "manual", reason: input.consentEvidence || "הסרה על ידי נציג", actorId: user.id }, tx);
    } else if (input.consentStatus === "OPTED_IN") {
      if (summary.fullyBlocked) throw new ApiError("יש להסיר חסימה מלאה במפורש לפני הסכמה לדיוור", 400, "fully_blocked");
      if (summary.marketingBlocked) await revokeSuppressions(businessId, c.id, user.id, input.consentEvidence ?? "", tx);
      else await tx.contact.update({ where: { id: c.id }, data: { consentStatus: "OPTED_IN", consentAt: new Date(), consentSource: input.consentSource || "manual", consentScope: "marketing", consentEvidence: input.consentEvidence || null } });
    } else if (input.consentStatus === "UNKNOWN" && !summary.marketingBlocked) {
      await tx.contact.update({ where: { id: c.id }, data: { consentStatus: "UNKNOWN" } });
    }
    return tx.contact.findUniqueOrThrow({ where: { id: c.id } });
  });
}

export async function addContactPhone(user: SessionUser, contactId: string, phone: string, label?: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, businessId: user.businessId } });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  await assertCanEditContact(user, c);
  const e164 = normalizePhone(phone);
  if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  const dup = await findDuplicateByPhone(user.businessId, e164, c.id);
  if (dup) throw new ApiError("מספר זה שייך לאיש קשר אחר", 409, "duplicate_phone", { contactId: dup });
  if (c.phoneE164 === e164) throw new ApiError("זהו הטלפון הראשי של איש הקשר", 400, "same_phone");
  const row = await prisma.contactPhone.create({ data: { businessId: user.businessId, contactId: c.id, e164, label: label || null } });
  // An existing suppression on the contact covers the new number too.
  const active = await prisma.suppression.findFirst({ where: { businessId: user.businessId, contactId: c.id, revokedAt: null }, orderBy: { scope: "desc" } });
  if (active) await suppressContact({ businessId: user.businessId, contactId: c.id, scope: active.scope, source: active.source, reason: active.reason ?? undefined, actorId: user.id });
  await audit(user.businessId, user.id, "contact", c.id, "contact.phone_added", { e164 });
  return row;
}

export async function removeContactPhone(user: SessionUser, contactId: string, phoneId: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, businessId: user.businessId } });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  await assertCanEditContact(user, c);
  await prisma.contactPhone.deleteMany({ where: { id: phoneId, contactId: c.id } });
  await audit(user.businessId, user.id, "contact", c.id, "contact.phone_removed", { phoneId });
}

export async function addContactEmail(user: SessionUser, contactId: string, emailRaw: string, label?: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, businessId: user.businessId } });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  await assertCanEditContact(user, c);
  const email = emailRaw.trim().toLowerCase();
  if (!z.string().email().safeParse(email).success) throw new ApiError("אימייל לא תקין", 400, "invalid_email");
  const dup = await findDuplicateByEmail(user.businessId, email, c.id);
  if (dup) throw new ApiError("אימייל זה שייך לאיש קשר אחר", 409, "duplicate_email", { contactId: dup });
  if (c.email === email) throw new ApiError("זהו האימייל הראשי של איש הקשר", 400, "same_email");
  const row = await prisma.contactEmail.create({ data: { businessId: user.businessId, contactId: c.id, email, label: label || null } });
  const active = await prisma.suppression.findFirst({ where: { businessId: user.businessId, contactId: c.id, revokedAt: null }, orderBy: { scope: "desc" } });
  if (active) await suppressContact({ businessId: user.businessId, contactId: c.id, scope: active.scope, source: active.source, reason: active.reason ?? undefined, actorId: user.id });
  await audit(user.businessId, user.id, "contact", c.id, "contact.email_added", { email });
  return row;
}

export async function removeContactEmail(user: SessionUser, contactId: string, emailId: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, businessId: user.businessId } });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  await assertCanEditContact(user, c);
  await prisma.contactEmail.deleteMany({ where: { id: emailId, contactId: c.id } });
  await audit(user.businessId, user.id, "contact", c.id, "contact.email_removed", { emailId });
}

/**
 * Possible duplicates: contacts sharing an email, or a similar name + same
 * city/company. Never merged automatically – a person decides.
 */
export async function findDuplicateGroups(businessId: string, limit = 50) {
  type Row = { id: string; fullName: string; phoneE164: string; email: string | null; createdAt: Date };
  const groups: Array<{ reason: string; key: string; contacts: Row[] }> = [];
  const emails = await prisma.$queryRaw<{ email: string }[]>`SELECT email FROM "contacts" WHERE business_id = ${businessId} AND email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1 LIMIT ${limit}`;
  for (const { email } of emails) {
    const contacts = await prisma.contact.findMany({ where: { businessId, email }, select: { id: true, fullName: true, phoneE164: true, email: true, createdAt: true }, orderBy: { createdAt: "asc" } });
    groups.push({ reason: "אותו אימייל", key: email, contacts });
  }
  const names = await prisma.$queryRaw<{ full_name: string }[]>`SELECT full_name FROM "contacts" WHERE business_id = ${businessId} GROUP BY full_name HAVING COUNT(*) > 1 LIMIT ${limit}`;
  for (const { full_name } of names) {
    const contacts = await prisma.contact.findMany({ where: { businessId, fullName: full_name }, select: { id: true, fullName: true, phoneE164: true, email: true, createdAt: true }, orderBy: { createdAt: "asc" } });
    groups.push({ reason: "אותו שם (ייתכן אדם אחר – לא ממוזג אוטומטית)", key: full_name, contacts });
  }
  return groups.slice(0, limit);
}

/** Import rows; existing contacts (same normalized number) are updated, never re-subscribed. */
export async function importContacts(user: SessionUser, rows: ContactInput[], defaultSource?: string) {
  const businessId = user.businessId;
  await assertTenantReferences(businessId, { userIds: rows.map((r) => r.ownerUserId) });
  let created = 0, updated = 0, invalid = 0;
  const errors: Array<{ row: number; phone: string; reason: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const e164 = normalizePhone(r.phone);
    if (!e164) {
      invalid++;
      errors.push({ row: i + 1, phone: r.phone, reason: "מספר טלפון לא תקין" });
      continue;
    }
    const existingId = await findDuplicateByPhone(businessId, e164);
    const base = {
      fullName: r.fullName.trim(),
      email: r.email ? r.email.toLowerCase() : null,
      company: r.company || null,
      city: r.city || null,
      notes: r.notes || null,
      customFields: (r.customFields as Prisma.InputJsonValue | undefined) ?? undefined,
    };
    if (existingId) {
      // Update only the fields the file provides – never blank existing data, never touch consent
      // (an unsubscribe is never undone by a file).
      if (base.email) {
        const dupEmail = await findDuplicateByEmail(businessId, base.email, existingId);
        if (dupEmail) { errors.push({ row: i + 1, phone: r.phone, reason: "האימייל שייך לאיש קשר אחר" }); invalid++; continue; }
      }
      const existing = await prisma.contact.findUniqueOrThrow({ where: { id: existingId }, select: { email: true } });
      await prisma.contact.update({ where: { id: existingId }, data: { ...(base.email && base.email !== existing.email ? { emailStatus: null, emailBouncedAt: null } : {}), fullName: base.fullName, email: base.email ?? undefined, company: base.company ?? undefined, city: base.city ?? undefined, notes: base.notes ?? undefined, customFields: base.customFields, source: r.source || undefined, ownerUserId: r.ownerUserId || undefined } });
      await syncTags(prisma, businessId, existingId, undefined, r.tagNames);
      updated++;
    } else {
      try {
        await consumeQuota(businessId, "contacts");
      } catch (err) {
        errors.push({ row: i + 1, phone: r.phone, reason: (err as Error).message });
        invalid++;
        continue;
      }
      if (base.email && await findDuplicateByEmail(businessId, base.email)) {
        errors.push({ row: i + 1, phone: r.phone, reason: "האימייל שייך לאיש קשר אחר" });
        invalid++;
        continue;
      }
      const c = await prisma.contact.create({ data: { ...base, businessId, phoneE164: e164, phoneRaw: r.phone, source: r.source || defaultSource || "import", ownerUserId: r.ownerUserId || null, consentStatus: r.consentStatus ?? "UNKNOWN", consentSource: r.consentStatus ? "import" : null, consentAt: r.consentStatus && r.consentStatus !== "UNKNOWN" ? new Date() : null, consentScope: r.consentStatus ? "marketing" : null } });
      await syncTags(prisma, businessId, c.id, undefined, r.tagNames);
      if (r.consentStatus === "OPTED_OUT") await suppressContact({ businessId, contactId: c.id, scope: "marketing", source: "import", reason: "import flag", actorId: user.id });
      created++;
    }
  }
  await audit(businessId, user.id, "contact", "import", "contact.imported", { created, updated, invalid });
  return { created, updated, invalid, errors: errors.slice(0, 200) };
}

/**
 * Merge `duplicateId` INTO `primaryId` (2.04 / 9.08). Never automatic – a manager chooses the survivor.
 * Moves phones, emails, tags, leads, deals, tasks, notes, conversations (+messages), calls, queue leads,
 * campaign recipients, suppressions, sequence runs and events; fills blank primary fields from the duplicate;
 * consent/blocking take the more restrictive value (an opt-out is never lost); deletes the duplicate row and
 * records a full snapshot in the audit log. Unique conflicts (same list, same campaign) keep the primary's row.
 */
export async function mergeContacts(user: SessionUser, primaryId: string, duplicateId: string) {
  const businessId = user.businessId;
  if (primaryId === duplicateId) throw new ApiError("לא ניתן למזג איש קשר עם עצמו", 400, "same_contact");
  if (!["owner", "manager"].includes(user.role)) throw new ApiError("מיזוג אנשי קשר – למנהלים בלבד", 403, "forbidden");
  const [primary, duplicate] = await Promise.all([
    prisma.contact.findFirst({ where: { id: primaryId, businessId }, include: { phones: true, emails: true, tags: true } }),
    prisma.contact.findFirst({ where: { id: duplicateId, businessId }, include: { phones: true, emails: true, tags: true, leads: true, deals: true, tasks: true, conversations: true, suppressions: true } }),
  ]);
  if (!primary || !duplicate) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  const snapshot = JSON.parse(JSON.stringify({ ...duplicate, phones: duplicate.phones.map((p) => p.e164), emails: duplicate.emails.map((e) => e.email) })) as Record<string, unknown>;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "contacts" WHERE id IN (${primaryId}, ${duplicateId}) FOR UPDATE`;
    // Identifiers: the duplicate's primary phone/email become extra identifiers of the survivor.
    const knownPhones = new Set([primary.phoneE164, ...primary.phones.map((p) => p.e164)]);
    // Move (not copy) the duplicate's extra identifiers – [businessId, e164] is unique, so a copy before the delete would collide.
    await tx.contactPhone.deleteMany({ where: { contactId: duplicateId, e164: { in: [...knownPhones] } } });
    await tx.contactPhone.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId, label: "ממיזוג" } });
    if (!knownPhones.has(duplicate.phoneE164) && !await tx.contactPhone.findFirst({ where: { businessId, e164: duplicate.phoneE164 } })) await tx.contactPhone.create({ data: { businessId, contactId: primaryId, e164: duplicate.phoneE164, label: "ממיזוג" } });
    const knownEmails = new Set([primary.email, ...primary.emails.map((e) => e.email)].filter((e): e is string => Boolean(e)));
    await tx.contactEmail.deleteMany({ where: { contactId: duplicateId, email: { in: [...knownEmails] } } });
    await tx.contactEmail.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId, label: "ממיזוג" } });
    if (duplicate.email && !knownEmails.has(duplicate.email) && !await tx.contactEmail.findFirst({ where: { businessId, email: duplicate.email } })) await tx.contactEmail.create({ data: { businessId, contactId: primaryId, email: duplicate.email, label: "ממיזוג" } });
    // Tags: union.
    const primaryTags = new Set(primary.tags.map((t) => t.tagId));
    for (const t of duplicate.tags) if (!primaryTags.has(t.tagId)) await tx.contactTag.create({ data: { contactId: primaryId, tagId: t.tagId } });
    await tx.contactTag.deleteMany({ where: { contactId: duplicateId } });
    // Relations that simply move.
    await tx.lead.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    await tx.deal.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    await tx.task.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    await tx.note.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    await tx.conversation.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    await tx.call.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    for (const draft of await tx.noteDraft.findMany({ where: { contactId: duplicateId } })) {
      const existing = await tx.noteDraft.findUnique({ where: { userId_contactId: { userId: draft.userId, contactId: primaryId } } });
      if (existing) {
        await tx.noteDraft.update({ where: { id: existing.id }, data: { body: [existing.body, draft.body].filter(Boolean).join("\n---\n") } });
        await tx.noteDraft.delete({ where: { id: draft.id } });
      } else await tx.noteDraft.update({ where: { id: draft.id }, data: { contactId: primaryId } });
    }
    await tx.suppression.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    await tx.domainEvent.updateMany({ where: { contactId: duplicateId }, data: { contactId: primaryId } });
    // Unique-per-contact rows: keep the survivor's row when both exist.
    const primaryLists = new Set((await tx.listLead.findMany({ where: { contactId: primaryId }, select: { listId: true } })).map((l) => l.listId));
    for (const l of await tx.listLead.findMany({ where: { contactId: duplicateId } })) { if (primaryLists.has(l.listId)) await tx.listLead.delete({ where: { id: l.id } }); else await tx.listLead.update({ where: { id: l.id }, data: { contactId: primaryId } }); }
    const primaryCampaigns = new Set((await tx.campaignRecipient.findMany({ where: { contactId: primaryId }, select: { campaignId: true } })).map((r) => r.campaignId));
    for (const r of await tx.campaignRecipient.findMany({ where: { contactId: duplicateId } })) { if (primaryCampaigns.has(r.campaignId)) await tx.campaignRecipient.delete({ where: { id: r.id } }); else await tx.campaignRecipient.update({ where: { id: r.id }, data: { contactId: primaryId } }); }
    const primaryLists2 = new Set((await tx.distributionListMember.findMany({ where: { contactId: primaryId }, select: { listId: true } })).map((m) => m.listId));
    for (const m of await tx.distributionListMember.findMany({ where: { contactId: duplicateId } })) { if (primaryLists2.has(m.listId)) await tx.distributionListMember.delete({ where: { listId_contactId: { listId: m.listId, contactId: m.contactId } } }); else await tx.distributionListMember.update({ where: { listId_contactId: { listId: m.listId, contactId: m.contactId } }, data: { contactId: primaryId } }); }
    const primaryRuns = new Set((await tx.sequenceRun.findMany({ where: { contactId: primaryId }, select: { sequenceId: true, sourceKey: true } })).map((r) => `${r.sequenceId}:${r.sourceKey}`));
    for (const r of await tx.sequenceRun.findMany({ where: { contactId: duplicateId } })) { if (primaryRuns.has(`${r.sequenceId}:${r.sourceKey}`)) await tx.sequenceRun.delete({ where: { id: r.id } }); else await tx.sequenceRun.update({ where: { id: r.id }, data: { contactId: primaryId } }); }
    // Fields: fill blanks; consent/blocking = most restrictive; custom fields: primary wins.
    const restrictive = primary.consentStatus === "OPTED_OUT" || duplicate.consentStatus === "OPTED_OUT" ? "OPTED_OUT" : primary.consentStatus === "OPTED_IN" || duplicate.consentStatus === "OPTED_IN" ? "OPTED_IN" : "UNKNOWN";
    await tx.contact.update({ where: { id: primaryId }, data: {
      email: primary.email ?? duplicate.email ?? undefined, company: primary.company ?? duplicate.company, city: primary.city ?? duplicate.city, source: primary.source ?? duplicate.source, notes: [primary.notes, duplicate.notes].filter(Boolean).join("\n---\n") || null,
      ownerUserId: primary.ownerUserId ?? duplicate.ownerUserId, customFields: { ...((duplicate.customFields ?? {}) as object), ...((primary.customFields ?? {}) as object) },
      consentStatus: restrictive, consentAt: restrictive !== primary.consentStatus ? (duplicate.consentAt ?? new Date()) : primary.consentAt, consentSource: restrictive !== primary.consentStatus ? (duplicate.consentSource ?? "merge") : primary.consentSource, consentEvidence: restrictive !== primary.consentStatus ? (duplicate.consentEvidence ?? "ממיזוג") : primary.consentEvidence,
      isBlocked: primary.isBlocked || duplicate.isBlocked, emailStatus: primary.emailStatus ?? duplicate.emailStatus, lastActivityAt: [primary.lastActivityAt, duplicate.lastActivityAt].filter(Boolean).sort().at(-1) ?? null,
    } });
    await tx.contact.delete({ where: { id: duplicateId } });
    await tx.auditLog.create({ data: { businessId, actorId: user.id, action: "contact.merged", entityType: "Contact", entityId: primaryId, payload: { duplicateId, duplicate: snapshot } as Prisma.InputJsonValue } });
    const { emitEvent } = await import("@/lib/events");
    await emitEvent(tx, { businessId, type: "contact.merged", contactId: primaryId, actorUserId: user.id, source: "user", dedupeKey: `contact.merged:${primaryId}:${duplicateId}`, payload: { duplicateId, duplicateName: duplicate.fullName, phones: snapshot.phones, emails: snapshot.emails } });
  }, { timeout: 30000 });
  return prisma.contact.findUniqueOrThrow({ where: { id: primaryId }, include: await contactCardInclude(user) });
}
