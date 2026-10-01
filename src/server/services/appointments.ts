/**
 * Appointments ("פגישות") with a contact. Scheduling emits appointment.scheduled once per appointment; changing the
 * time is a reschedule of the SAME appointment (appointment.rescheduled – not a new meeting); attended / no-show /
 * cancelled close it (attended emits appointment.attended once). Visibility follows the contact's scope.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { contactScope } from "@/lib/crm/access";

export const createSchema = z.object({ contactId: z.string().min(1), leadId: z.string().optional().nullable(), scheduledAt: z.string().datetime({ offset: true }), title: z.string().trim().max(120).optional() });
export const patchSchema = z.object({ scheduledAt: z.string().datetime({ offset: true }).optional(), status: z.enum(["scheduled", "attended", "no_show", "cancelled"]).optional() });

async function visibleContact(user: SessionUser, contactId: string) {
  const c = await prisma.contact.findFirst({ where: { AND: [{ id: contactId, businessId: user.businessId }, contactScope(await visibleUserIds(user))] }, select: { id: true, ownerUserId: true } });
  if (!c) throw new ApiError("איש הקשר לא נמצא", 404, "not_found");
  return c;
}

export async function listAppointments(user: SessionUser, contactId: string) {
  await visibleContact(user, contactId);
  return prisma.appointment.findMany({ where: { contactId }, orderBy: { scheduledAt: "desc" }, take: 50 });
}

export async function createAppointment(user: SessionUser, input: z.infer<typeof createSchema>) {
  const c = await visibleContact(user, input.contactId);
  if (input.leadId && !(await prisma.lead.findFirst({ where: { id: input.leadId, contactId: c.id }, select: { id: true } }))) throw new ApiError("הליד אינו של איש קשר זה", 400, "lead_mismatch");
  const { emitEvent, kickEventProcessing } = await import("@/lib/events");
  const row = await prisma.$transaction(async (tx) => {
    const a = await tx.appointment.create({ data: { businessId: user.businessId, contactId: c.id, leadId: input.leadId ?? null, scheduledAt: new Date(input.scheduledAt), title: input.title || "פגישה", ownerUserId: user.id, createdById: user.id } });
    await emitEvent(tx, { businessId: user.businessId, type: "appointment.scheduled", contactId: c.id, actorUserId: user.id, source: "user", dedupeKey: `appointment.scheduled:${a.id}`, payload: { appointmentId: a.id, leadId: a.leadId, scheduledAt: a.scheduledAt.toISOString() } });
    await audit(user.businessId, user.id, "contact", c.id, "appointment.created", { appointmentId: a.id }, tx);
    return a;
  });
  kickEventProcessing(user.businessId);
  return row;
}

export async function updateAppointment(user: SessionUser, id: string, input: z.infer<typeof patchSchema>) {
  const a = await prisma.appointment.findFirst({ where: { id } });
  if (!a) throw new ApiError("הפגישה לא נמצאה", 404, "not_found");
  await visibleContact(user, a.contactId);
  const { emitEvent, kickEventProcessing } = await import("@/lib/events");
  const row = await prisma.$transaction(async (tx) => {
    // Re-read under a row lock: retries must compare with the last committed state, not a stale preflight read.
    await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} AND business_id = ${user.businessId} FOR UPDATE`;
    const a = await tx.appointment.findUnique({ where: { id } });
    if (!a) throw new ApiError("הפגישה לא נמצאה", 404, "not_found");
    if (a.status !== "scheduled" && input.scheduledAt) throw new ApiError("הפגישה כבר נסגרה – אפשר לקבוע פגישה חדשה", 409, "closed");
    const resched = input.scheduledAt && new Date(input.scheduledAt).getTime() !== a.scheduledAt.getTime();
    const u = await tx.appointment.update({ where: { id: a.id }, data: {
      ...(resched ? { scheduledAt: new Date(input.scheduledAt!), rescheduledCount: { increment: 1 } } : {}),
      ...(input.status ? { status: input.status, attendedAt: input.status === "attended" ? (a.attendedAt ?? new Date()) : null } : {}),
    } });
    // A new time is the same meeting (never a second "scheduled"); attended is emitted once per appointment.
    if (resched) await emitEvent(tx, { businessId: user.businessId, type: "appointment.rescheduled", contactId: a.contactId, actorUserId: user.id, source: "user", dedupeKey: `appointment.rescheduled:${a.id}:${u.rescheduledCount}`, payload: { appointmentId: a.id, scheduledAt: input.scheduledAt } });
    if (input.status === "attended" && a.status !== "attended") await emitEvent(tx, { businessId: user.businessId, type: "appointment.attended", contactId: a.contactId, actorUserId: user.id, source: "user", dedupeKey: `appointment.attended:${a.id}`, payload: { appointmentId: a.id, leadId: a.leadId } });
    await audit(user.businessId, user.id, "contact", a.contactId, "appointment.updated", { appointmentId: a.id, status: input.status, rescheduled: Boolean(resched) }, tx);
    return u;
  });
  kickEventProcessing(user.businessId);
  return row;
}
