import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

/** Contact card: details + call history + open tasks + list memberships. Call history respects team visibility. */
export const GET = withAuth(async ({ user, params }) => {
  const ids = await visibleUserIds(user);
  const c = await prisma.contact.findFirst({
    where: { id: params.id, businessId: user.businessId },
    include: {
      owner: { select: { id: true, fullName: true } },
      leads: { include: { list: { select: { id: true, name: true } } } },
      tasks: { where: { status: "open", businessId: user.businessId, ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { dueAt: "asc" }, include: { user: { select: { id: true, fullName: true } } } },
    },
  });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  const calls = await prisma.call.findMany({
    where: { contactId: c.id, businessId: user.businessId, ...(ids ? { userId: { in: ids } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, createdAt: true, answeredAt: true, endedAt: true, talkSeconds: true, status: true, telephonyResult: true, outcome: true, outcomeNote: true,
      callbackAt: true, recordingStatus: true, mode: true, fromE164: true, user: { select: { id: true, fullName: true } },
    },
  });
  const dnc = await prisma.dncEntry.findUnique({ where: { businessId_phoneE164: { businessId: user.businessId, phoneE164: c.phoneE164 } } });
  return ok({ ...c, calls, isDnc: Boolean(dnc), dncReason: dnc?.reason ?? null });
});

const patchSchema = z.object({
  fullName: z.string().min(1).max(120).optional(),
  phone: z.string().min(3).max(30).optional(),
  email: z.string().email().or(z.literal("")).optional(),
  company: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  source: z.string().max(100).optional(),
  notes: z.string().max(4000).optional(),
  ownerUserId: z.string().nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional(),
});

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, patchSchema);
  const c = await prisma.contact.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  // Agents may edit contacts they own or currently hold; managers/admins edit all.
  if (user.role === "agent" && c.ownerUserId !== user.id) {
    const held = await prisma.listLead.findFirst({ where: { contactId: c.id, lockedByUserId: user.id } });
    const called = await prisma.call.findFirst({ where: { contactId: c.id, userId: user.id } });
    if (!held && !called) throw new ApiError("אין הרשאה לערוך איש קשר זה", 403, "forbidden");
  }
  if (user.role !== "agent") await assertTenantReferences(user.businessId, { userIds: [b.ownerUserId] });
  const data: Record<string, unknown> = {};
  if (b.fullName !== undefined) data.fullName = b.fullName.trim();
  if (b.email !== undefined) data.email = b.email || null;
  if (b.company !== undefined) data.company = b.company || null;
  if (b.city !== undefined) data.city = b.city || null;
  if (b.source !== undefined) data.source = b.source || null;
  if (b.notes !== undefined) data.notes = b.notes || null;
  if (b.ownerUserId !== undefined && user.role !== "agent") data.ownerUserId = b.ownerUserId;
  if (b.tags !== undefined) data.tags = [...new Set(b.tags.map((t) => t.trim()).filter(Boolean))];
  if (b.phone !== undefined) {
    const e164 = normalizePhone(b.phone);
    if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
    const dup = await prisma.contact.findFirst({ where: { businessId: user.businessId, phoneE164: e164, NOT: { id: c.id } } });
    if (dup) throw new ApiError("מספר זה שייך לאיש קשר אחר", 409, "duplicate_phone", { contactId: dup.id });
    data.phoneE164 = e164;
    data.phoneRaw = b.phone;
  }
  const updated = await prisma.contact.update({ where: { id: c.id }, data });
  return ok(updated);
});
