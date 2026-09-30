/**
 * CRM lead import (Excel / CSV parsed in the browser → rows). Each row: contact matched by phone (created if new),
 * email / product / campaign / ad filled when missing, and a lead opened – assigned to the chosen agent or, with
 * "auto", to the business's distribution policy (round robin / least loaded). A contact that already has an open
 * lead is not duplicated and never moved by an import (reported as "exists" – when it belongs to another agent than the
 * chosen one it is a "conflict": transfers go through "העבר ליד" only). An existing customer / a person owned by an active
 * agent opens with that handling agent (createLead intake), whatever agent the file names.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/response";
import { normalizePhone } from "@/lib/phone";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { findOrCreateContactByPhone } from "./contacts";
import { createLead } from "./pipeline";
import { OPEN_LEAD_STATUSES } from "./labels";

export const leadImportSchema = z.object({
  rows: z.array(z.object({
    fullName: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(40),
    email: z.string().trim().toLowerCase().max(200).optional(),
    source: z.string().trim().max(100).optional(),
    product: z.string().trim().max(160).optional(),
    campaign: z.string().trim().max(160).optional(),
    ad: z.string().trim().max(160).optional(),
    /** Meta ids when the file has them (ad_id / adset_id / campaign_id columns) – names alone never attribute to an ad. */
    adId: z.string().trim().max(40).optional(), adsetId: z.string().trim().max(40).optional(), campaignId: z.string().trim().max(40).optional(),
    utmSource: z.string().trim().max(200).optional(), utmCampaign: z.string().trim().max(300).optional(),
    notes: z.string().trim().max(2000).optional(),
  })).min(1).max(500),
  /** "auto" = distribution policy; otherwise an active user id of the business. */
  owner: z.union([z.literal("auto"), z.string().min(1)]),
  source: z.string().trim().max(100).optional(),
  /** Row number of the first row in this chunk (for error reports across chunks). */
  offset: z.number().int().min(0).default(0),
});

export async function importLeads(user: SessionUser, input: z.infer<typeof leadImportSchema>) {
  let ownerId: string | undefined;
  if (input.owner !== "auto") {
    const ids = await visibleUserIds(user);
    const u = await prisma.user.findFirst({ where: { id: input.owner, businessId: user.businessId, isActive: true }, select: { id: true } });
    if (!u || (ids && !ids.includes(u.id))) throw new ApiError("יש לבחור נציג פעיל בעסק", 400, "invalid_agent");
    ownerId = u.id;
  }
  const result = { created: 0, exists: 0, invalid: 0, conflicts: 0, existingCustomers: 0, routedToHandler: 0, review: 0, errors: [] as Array<{ row: number; phone: string; reason: string }> };
  for (let i = 0; i < input.rows.length; i++) {
    const r = input.rows[i]; const rowNo = input.offset + i + 2; // +1 header, +1 human numbering
    const e164 = normalizePhone(r.phone);
    if (!e164) { result.invalid++; result.errors.push({ row: rowNo, phone: r.phone, reason: "מספר טלפון לא תקין" }); continue; }
    try {
      const source = r.source || input.source || "import";
      const contact = await findOrCreateContactByPhone(user.businessId, e164, { fullName: r.fullName || e164, phoneRaw: r.phone, source });
      const fields = Object.fromEntries(Object.entries({ product: r.product, campaign: r.campaign, ad: r.ad }).filter(([, v]) => v));
      const cf = (contact.customFields && typeof contact.customFields === "object" ? contact.customFields : {}) as Record<string, unknown>;
      const emailFree = r.email && !contact.email ? !(await prisma.contact.findFirst({ where: { businessId: user.businessId, email: r.email, NOT: { id: contact.id } }, select: { id: true } })) : false;
      if (Object.keys(fields).length || emailFree) await prisma.contact.update({ where: { id: contact.id }, data: { ...(Object.keys(fields).length ? { customFields: { ...cf, ...fields } as Prisma.InputJsonValue } : {}), ...(emailFree ? { email: r.email } : {}) } });
      const open = await prisma.lead.findFirst({ where: { businessId: user.businessId, contactId: contact.id, status: { in: [...OPEN_LEAD_STATUSES] } }, select: { id: true, ownerUserId: true } });
      if (open) {
        result.exists++;
        if (ownerId && open.ownerUserId && open.ownerUserId !== ownerId) {
          result.conflicts++;
          result.errors.push({ row: rowNo, phone: r.phone, reason: "לאיש הקשר יש ליד פתוח אצל נציג אחר – לא הועבר (העברה דרך \"העבר ליד\" בלבד)" });
        }
        continue;
      }
      const lead = await createLead(user, { contactId: contact.id, source, notes: r.notes || undefined, ...(ownerId ? { ownerUserId: ownerId } : {}) }, "import", { touch: { adId: r.adId, adsetId: r.adsetId, campaignId: r.campaignId, utm: { source: r.utmSource, campaign: r.utmCampaign ?? r.campaign } }, channel: "import", dataSource: "import" });
      result.created++;
      if (lead.existingCustomer) result.existingCustomers++;
      if (lead.routedTo) result.routedToHandler++;
      if (lead.reviewReason) result.review++;
    } catch (e) {
      result.invalid++; result.errors.push({ row: rowNo, phone: r.phone, reason: (e as Error).message.slice(0, 200) });
    }
  }
  return result;
}
