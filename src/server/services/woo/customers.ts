/**
 * Store customer ↔ CRM contact, carefully: by normalized phone first (primary or additional phone), then by exact email
 * – never by name. A new person with a phone gets a contact (silent on import: no automations); without a phone the
 * store customer is kept unlinked ("no_phone") and nothing is merged. CRM-edited fields are never overwritten: the
 * store only fills what is missing (the CRM is the source of truth for the person; the store for orders).
 */
import { prisma } from "@/lib/db";
import { contactForIdentifier } from "@/lib/suppression";
import { findOrCreateContactByPhone } from "@/lib/crm/contacts";

export interface StoreCustomerInput { externalId?: string | null; email?: string | null; phoneE164?: string | null; phoneRaw?: string | null; name?: string | null; modifiedAt?: Date | null }

export async function linkStoreCustomer(businessId: string, storeId: string, c: StoreCustomerInput, opts: { silent: boolean; source?: string }) {
  let contactId = c.phoneE164 ? await contactForIdentifier(businessId, c.phoneE164) : null;
  if (!contactId && c.email) contactId = await contactForIdentifier(businessId, c.email.toLowerCase());
  let linkState: "linked" | "created" | "no_phone" = contactId ? "linked" : "no_phone";
  if (!contactId && c.phoneE164) {
    const created = await findOrCreateContactByPhone(businessId, c.phoneE164, { fullName: c.name || c.email || c.phoneE164, phoneRaw: c.phoneRaw || c.phoneE164, source: opts.source ?? "woocommerce", email: c.email }, prisma, { silent: opts.silent });
    contactId = created.id; linkState = "created";
  }
  if (contactId && linkState === "linked") {
    // Fill-only: a missing email / placeholder name – never overwrite what the CRM has.
    const cur = await prisma.contact.findUnique({ where: { id: contactId }, select: { email: true, fullName: true, phoneE164: true } });
    const data: { email?: string; fullName?: string } = {};
    if (cur && !cur.email && c.email && !(await contactForIdentifier(businessId, c.email.toLowerCase()))) data.email = c.email.toLowerCase();
    if (cur && c.name && (cur.fullName === cur.phoneE164 || cur.fullName === "מספר לא מזוהה")) data.fullName = c.name;
    if (Object.keys(data).length) await prisma.contact.update({ where: { id: contactId }, data });
  }
  if (c.externalId && c.externalId !== "0") {
    const existing = await prisma.storeCustomer.findUnique({ where: { storeId_externalId: { storeId, externalId: c.externalId } } });
    if (!(existing?.sourceModifiedAt && c.modifiedAt && c.modifiedAt < existing.sourceModifiedAt)) {
      await prisma.storeCustomer.upsert({ where: { storeId_externalId: { storeId, externalId: c.externalId } },
        create: { businessId, storeId, externalId: c.externalId, contactId, email: c.email ?? null, phoneE164: c.phoneE164 ?? null, name: c.name ?? null, linkState, sourceModifiedAt: c.modifiedAt ?? null },
        update: { contactId: contactId ?? existing?.contactId ?? null, email: c.email ?? existing?.email ?? null, phoneE164: c.phoneE164 ?? existing?.phoneE164 ?? null, name: c.name ?? existing?.name ?? null, ...(contactId ? { linkState: existing?.linkState === "created" ? "created" : linkState } : {}), sourceModifiedAt: c.modifiedAt ?? existing?.sourceModifiedAt ?? null } });
    }
  }
  return { contactId, linkState };
}
