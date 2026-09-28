import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { addLeadsToList } from "@/lib/lists";
import { leadForUser, personalListId } from "@/lib/crm/lead-ops";

export const dynamic = "force-dynamic";

/**
 * Move a lead into a dialer campaign (dial list) – e.g. an agent marks a lead "לא מתאים" and parks it in
 * "בריכת לידים". The contact joins the list (or is re-queued there) and leaves the agent's personal queue.
 * Agents may use lists assigned to them or open to everyone (same rule as the lists screen).
 */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ listId: z.string().min(1) }));
  const lead = await leadForUser(user, params.id);
  const list = await prisma.dialList.findFirst({ where: { id: b.listId, businessId: user.businessId, isActive: true, archivedAt: null, ...(user.role === "agent" ? { OR: [{ agents: { none: {} } }, { agents: { some: { userId: user.id } } }] } : {}) }, select: { id: true, name: true } });
  if (!list) throw new ApiError("הקמפיין לא נמצא או שאין לך גישה אליו", 404, "not_found");
  if (await prisma.dncEntry.findFirst({ where: { businessId: user.businessId, phoneE164: (await prisma.contact.findUniqueOrThrow({ where: { id: lead.contactId }, select: { phoneE164: true } })).phoneE164 } })) throw new ApiError("המספר ברשימת 'לא ליצור קשר'", 409, "dnc_blocked");
  await addLeadsToList(user.businessId, list.id, undefined, [lead.contactId]);
  await prisma.listLead.updateMany({ where: { listId: list.id, contactId: lead.contactId, status: { in: ["completed", "exhausted", "removed"] } }, data: { status: "pending", attempts: 0, followUpAttempts: null, nextAttemptAt: null, preferredUserId: null, lastOutcome: null } });
  if (lead.ownerUserId) { const own = await prisma.$transaction((tx) => personalListId(tx, user.businessId, lead.ownerUserId!)); if (own && own !== list.id) await prisma.listLead.updateMany({ where: { listId: own, contactId: lead.contactId, status: { in: ["pending", "callback"] } }, data: { status: "completed", nextAttemptAt: null } }); }
  await audit(user.businessId, user.id, "lead", lead.id, "lead.moved_to_list", { listId: list.id, listName: list.name });
  return ok({ listId: list.id, listName: list.name });
}, { perm: "crm.edit" });
