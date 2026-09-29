import { canAccessContact } from "@/lib/crm/lead-ops";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { revokeSuppressions, suppressContact, suppressionSummary } from "@/lib/suppression";

export const dynamic = "force-dynamic";

/** Unsubscribe (marketing) or do-not-contact (all channels + calls) for a contact. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ scope: z.enum(["marketing", "all"]).default("marketing"), reason: z.string().max(500).optional() }));
  const c = await prisma.contact.findFirst({ where: { id: params.id, businessId: user.businessId }, select: { id: true, ownerUserId: true } });
  if (!c || !(await canAccessContact(user, c))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  await suppressContact({ businessId: user.businessId, contactId: c.id, scope: b.scope, source: "manual", kind: "manual", reason: b.reason ?? "בקשת הסרה דרך נציג", actorId: user.id });
  return ok(await suppressionSummary(user.businessId, c.id));
}, { minRole: "manager", perm: ["crm.edit", "whatsapp.reply", "sms.draft", "email.draft"] });

/** Re-consent: revokes the active suppressions. Requires documented evidence. Managers only. */
export const DELETE = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ evidence: z.string().trim().min(5).max(1000) }));
  // Lifting a block: a manager who can see this contact, with documented renewed consent (audited; no expiry otherwise).
  const c = await prisma.contact.findFirst({ where: { id: params.id, businessId: user.businessId }, select: { id: true, ownerUserId: true } });
  if (!c || !(await canAccessContact(user, c))) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  await revokeSuppressions(user.businessId, c.id, user.id, b.evidence);
  return ok(await suppressionSummary(user.businessId, c.id));
}, { minRole: "manager", perm: ["crm.edit", "whatsapp.reply", "sms.draft", "email.draft"] });
