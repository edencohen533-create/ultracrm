import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertCanSeeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(["done", "cancelled", "open"]).optional(), dueAt: z.string().datetime({ offset: true }).optional(), note: z.string().max(4000).optional() });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const t = await prisma.task.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!t) throw new ApiError("משימה לא נמצאה", 404, "not_found");
  await assertCanSeeUser(user, t.userId);
  const updated = await prisma.task.update({
    where: { id: t.id },
    data: {
      ...(b.status ? { status: b.status, doneAt: b.status === "done" ? new Date() : null } : {}),
      ...(b.dueAt ? { dueAt: new Date(b.dueAt) } : {}),
      ...(b.note !== undefined ? { note: b.note } : {}),
    },
  });
  if (b.dueAt && t.leadId) {
    await prisma.listLead.updateMany({ where: { id: t.leadId, status: "callback" }, data: { nextAttemptAt: new Date(b.dueAt) } });
  }
  if (b.status && b.status !== "open" && t.leadId) {
    // Callback resolved outside a call → put the lead back in the normal queue.
    await prisma.listLead.updateMany({ where: { id: t.leadId, status: "callback" }, data: { status: b.status === "done" ? "completed" : "pending", preferredUserId: null, nextAttemptAt: null } });
  }
  return ok(updated);
});
