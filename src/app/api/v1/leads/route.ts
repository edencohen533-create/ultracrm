import { assertAccess } from "@/lib/access/engine";
import { visibleUserIds } from "@/lib/auth";
import { ownerScope } from "@/lib/crm/access";
import { z } from "zod";
import { ok, handleError, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { normalizePhone } from "@/lib/phone";
import { authenticateApiKey } from "@/server/services/integrations";
import { createLead } from "@/lib/crm/pipeline";
import { OPEN_LEAD_STATUSES } from "@/lib/crm/labels";

export const dynamic = "force-dynamic";

const schema = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(6).max(30),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal("")),
  source: z.string().trim().max(100).optional(),
  title: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(4000).optional(),
  /** Assign to this agent (email of an active user of the business); otherwise the business's distribution policy decides. */
  ownerEmail: z.string().trim().toLowerCase().max(200).optional(),
  customFields: z.record(z.string().max(60), z.union([z.string().max(1000), z.number(), z.boolean()])).optional(),
});

/**
 * Public API: create a lead (Make / Zapier / forms). The contact is matched by phone (created if new); if it already
 * has an open lead, that lead is returned instead of a duplicate.
 */
export async function POST(req: Request) {
  try {
    const a = await authenticateApiKey(req);
    let body: unknown; try { body = await req.json(); } catch { throw new ApiError("גוף הבקשה אינו JSON תקין", 400, "invalid_json"); }
    const p = schema.safeParse(body);
    if (!p.success) throw new ApiError("נתונים לא תקינים", 400, "validation", p.error.flatten());
    const b = p.data;
    const e164 = normalizePhone(b.phone);
    if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
    const result = await withBusiness(a.business.id, async () => {
      const owner = b.ownerEmail ? await prisma.user.findFirst({ where: { businessId: a.business.id, email: b.ownerEmail, isActive: true }, select: { id: true } }) : null;
      if (b.ownerEmail && !owner) throw new ApiError("לא נמצא משתמש פעיל עם האימייל שב-ownerEmail", 400, "invalid_owner");
      const { findOrCreateContactByPhone } = await import("@/lib/crm/contacts");
      const contact = await findOrCreateContactByPhone(a.business.id, e164, { fullName: b.fullName, phoneRaw: b.phone, source: b.source ?? "api" });
      const emailFree = b.email && !contact.email ? !(await prisma.contact.findFirst({ where: { businessId: a.business.id, email: b.email, NOT: { id: contact.id } }, select: { id: true } })) : false;
      if (b.customFields || emailFree) await prisma.contact.update({ where: { id: contact.id }, data: { ...(b.customFields ? { customFields: { ...((contact.customFields as object | null) ?? {}), ...b.customFields } } : {}), ...(emailFree ? { email: b.email } : {}) } });
      const open = await prisma.lead.findFirst({ where: { businessId: a.business.id, contactId: contact.id, status: { in: [...OPEN_LEAD_STATUSES] } }, select: { id: true } });
      if (open) return { leadId: open.id, contactId: contact.id, created: false };
      const lead = await createLead(a.session, { contactId: contact.id, title: b.title, source: b.source ?? "api", notes: b.notes, ...(owner ? { ownerUserId: owner.id } : {}) }, "webhook");
      return { leadId: lead.id, contactId: contact.id, created: true };
    }, a.session);
    return ok(result, result.created ? 201 : 200);
  } catch (e) { return handleError(e); }
}

/** Public API: recent leads (polling trigger for Make / Zapier). */
export async function GET(req: Request) {
  try {
    const a = await authenticateApiKey(req);
    const url = new URL(req.url);
    const since = url.searchParams.get("since"); const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    // Listing leads is an export: the key's creator needs crm.export, and sees only the leads their role scope allows.
    const items = await withBusiness(a.business.id, async () => {
      await assertAccess(a.session, "crm.export");
      const scope = ownerScope(await visibleUserIds(a.session));
      return prisma.lead.findMany({
      where: { businessId: a.business.id, ...scope, ...(since && !Number.isNaN(Date.parse(since)) ? { createdAt: { gt: new Date(since) } } : {}) },
      orderBy: { createdAt: "desc" }, take: limit,
      select: { id: true, status: true, source: true, title: true, createdAt: true, owner: { select: { id: true, fullName: true, email: true } }, contact: { select: { id: true, fullName: true, phoneE164: true, email: true } } },
    }); }, a.session);
    return ok({ items });
  } catch (e) { return handleError(e); }
}
