/**
 * Business automation on unsubscribe ("הסר" reply on WhatsApp/SMS, STOP, or the email/SMS unsubscribe link).
 * The global marketing block always happens in suppressContact; this adds the optional clean-up the business chose:
 * remove the contact from every static distribution list and/or tag it. Idempotent.
 */
import { prisma, type Db } from "@/lib/db";
import { getBusinessSettings } from "@/lib/settings";

export async function applyUnsubscribeAutomation(businessId: string, contactId: string, db: Db = prisma) {
  const cfg = (await getBusinessSettings(businessId, db)).automations.unsubscribe;
  let removedFromLists = 0; let tagged = false;
  if (cfg.removeFromLists) {
    const r = await db.distributionListMember.deleteMany({ where: { contactId, list: { businessId } } });
    removedFromLists = r.count;
  }
  const tagName = cfg.tagName?.trim();
  if (tagName) {
    const tag = await db.tag.findFirst({ where: { businessId, name: tagName } }) ?? await db.tag.create({ data: { businessId, name: tagName } });
    await db.contactTag.upsert({ where: { contactId_tagId: { contactId, tagId: tag.id } }, create: { contactId, tagId: tag.id }, update: {} });
    tagged = true;
  }
  if (removedFromLists || tagged) await db.auditLog.create({ data: { businessId, actorId: null, action: "contact.unsubscribe_automation", entityType: "Contact", entityId: contactId, payload: { removedFromLists, tag: tagged ? tagName : null } } });
  return { removedFromLists, tagged };
}
