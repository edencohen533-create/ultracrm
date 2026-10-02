import { normalizePhone } from "@/lib/phone";
import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { resolvedContactWhere } from "@/lib/crm/contact-filter";
import { prisma } from "@/lib/db";
import { contactFilterSchema, contactInputSchema, createContact } from "@/lib/crm/contacts";
import { contactScope } from "@/lib/crm/access";
import { visibleUserIds } from "@/lib/auth";

export const dynamic = "force-dynamic";

const listSchema = contactFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, listSchema);
  // Agents (and team-scoped managers) list only their contacts – settings → הרשאות.
  const where = { AND: [await resolvedContactWhere(user.businessId, f), contactScope(await visibleUserIds(user))] };
  const [total, items] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: [{ lastActivityAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (f.page - 1) * f.limit,
      take: f.limit,
      include: {
        owner: { select: { id: true, fullName: true } },
        tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
        _count: { select: { calls: true, conversations: true, leads: { where: { status: { in: ["new", "contacted", "qualified", "follow_up"] } } } } },
        calls: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, outcome: true, telephonyResult: true } },
      },
    }),
  ]);
  const phones = items.map((c) => c.phoneE164);
  const [dnc, suppressed] = await Promise.all([
    prisma.dncEntry.findMany({ where: { businessId: user.businessId, phoneE164: { in: phones } }, select: { phoneE164: true } }),
    prisma.suppression.findMany({ where: { businessId: user.businessId, contactId: { in: items.map((c) => c.id) }, revokedAt: null }, select: { contactId: true, scope: true } }),
  ]);
  const dncSet = new Set(dnc.map((d) => d.phoneE164));
  const supMap = new Map<string, "marketing" | "all">();
  for (const s of suppressed) if (s.contactId) supMap.set(s.contactId, s.scope === "all" || supMap.get(s.contactId) === "all" ? "all" : "marketing");
  return ok({
    items: items.map((c) => ({ ...c, tags: c.tags.map((t) => t.tag), isDnc: dncSet.has(c.phoneE164), suppression: supMap.get(c.id) ?? null, lastCall: c.calls[0] ?? null, calls: undefined,
      // Why the WhatsApp button is unavailable (same rules as POST /api/contacts/:id/whatsapp).
      whatsappBlock: !c.phoneE164 || !normalizePhone(c.phoneE164) ? "אין מספר טלפון תקין" : c.isBlocked || supMap.get(c.id) === "all" ? "חסום לכל פנייה" : null })),
    total,
    page: f.page,
    limit: f.limit,
  });
}, { perm: ["crm.view", "telephony.use", "whatsapp.view", "sms.view", "email.view"] });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, contactInputSchema);
  return ok(await createContact(user, b), 201);
}, { perm: ["crm.create", "telephony.use", "whatsapp.reply", "sms.draft", "email.draft"] });
