import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { CONTACT_CARD_INCLUDE, contactPatchSchema, updateContact } from "@/lib/crm/contacts";
import { suppressionSummary } from "@/lib/suppression";
import { TASK_INCLUDE } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

/** Contact card: identity, consent + suppression, leads, deals, open tasks, calls, conversations. */
export const GET = withAuth(async ({ user, params }) => {
  const ids = await visibleUserIds(user);
  const c = await prisma.contact.findFirst({ where: { id: params.id, businessId: user.businessId }, include: CONTACT_CARD_INCLUDE });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  const [tasks, calls, conversations, dnc, suppression, notes] = await Promise.all([
    prisma.task.findMany({ where: { contactId: c.id, status: "open", ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { dueAt: "asc" }, include: TASK_INCLUDE }),
    prisma.call.findMany({
      where: { contactId: c.id, ...(ids ? { userId: { in: ids } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, createdAt: true, direction: true, answeredAt: true, endedAt: true, talkSeconds: true, status: true, telephonyResult: true, outcome: true, outcomeNote: true, callbackAt: true, recordingStatus: true, mode: true, fromE164: true, user: { select: { id: true, fullName: true } } },
    }),
    prisma.conversation.findMany({
      where: { contactId: c.id, ...(user.role === "agent" ? { OR: [{ assignedAgentId: user.id }, { assignedAgentId: null }] } : {}) },
      orderBy: { lastMessageAt: "desc" },
      take: 20,
      select: { id: true, channel: true, status: true, lastMessageAt: true, lastInboundAt: true, unreadCount: true, assignedAgent: { select: { id: true, fullName: true } }, providerCredential: { select: { id: true, label: true, displayPhoneNumber: true, isActive: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, direction: true, createdAt: true } } },
    }),
    prisma.dncEntry.findUnique({ where: { businessId_phoneE164: { businessId: user.businessId, phoneE164: c.phoneE164 } } }),
    suppressionSummary(user.businessId, c.id),
    prisma.note.findMany({ where: { contactId: c.id }, orderBy: { createdAt: "desc" }, take: 20, include: { author: { select: { id: true, fullName: true } } } }),
  ]);
  return ok({ ...c, tags: c.tags.map((t) => t.tag), tasks, calls, conversations, notes, isDnc: Boolean(dnc), dncReason: dnc?.reason ?? null, suppression });
});

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, contactPatchSchema);
  return ok(await updateContact(user, params.id, b));
});
