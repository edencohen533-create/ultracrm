import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { createLead, leadFilterSchema, leadInputSchema, listLeads } from "@/lib/crm/pipeline";
import { createContact, findDuplicateByPhone } from "@/lib/crm/contacts";
import { canAccessContact } from "@/lib/crm/lead-ops";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ req, user }) => ok(await listLeads(user, parseQuery(req, leadFilterSchema))), { perm: "crm.view" });

/** A lead for an existing contact (`contactId`) or from a name + phone (the "ליד חדש" form). */
const createSchema = leadInputSchema.extend({
  contactId: z.string().min(1).optional(),
  contact: z.object({ fullName: z.string().trim().min(1, "יש להזין שם").max(120), phone: z.string().trim().min(3, "יש להזין טלפון").max(40) }).optional(),
}).refine((b) => Boolean(b.contactId) !== Boolean(b.contact), { message: "יש להזין שם וטלפון" });

/**
 * Name + phone: the same duplicate protection as before – a phone that already belongs to a contact uses that contact
 * (never a second contact with the same number; the name typed doesn't overwrite it), and a contact that already has
 * an open lead gets no second lead (createLead → 409 open_lead_exists).
 */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, createSchema);
  let contactId = b.contactId;
  let contactReused: { id: string; fullName: string } | null = null;
  if (b.contact) {
    const e164 = normalizePhone(b.contact.phone);
    if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
    const dup = await findDuplicateByPhone(user.businessId, e164);
    if (dup) {
      const existing = await prisma.contact.findFirst({ where: { id: dup, businessId: user.businessId }, select: { id: true, fullName: true, ownerUserId: true } });
      if (!existing || !(await canAccessContact(user, existing))) throw new ApiError("המספר שייך לאיש קשר קיים שאינו בתחום שלך – פנה למנהל", 409, "duplicate_phone_other_scope");
      contactId = existing.id; contactReused = { id: existing.id, fullName: existing.fullName };
    } else {
      contactId = (await createContact(user, { fullName: b.contact.fullName, phone: b.contact.phone, source: b.source || undefined } as Parameters<typeof createContact>[1])).id;
    }
  }
  const { contact: _c, ...input } = b;
  void _c;
  const lead = await createLead(user, { ...input, contactId: contactId! });
  return ok(Object.assign(lead, { contactReused }), 201);
}, { perm: "crm.create" });
