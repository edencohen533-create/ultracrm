import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Saved replies for the inbox composer (all roles read; managers manage). */
export const GET = withAuth(async () => ok({ items: await prisma.cannedReply.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true, body: true, shortcut: true } }) }), { module: "messaging" });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ id: z.string().optional(), title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(4096), shortcut: z.string().trim().max(30).optional() }));
  const row = b.id
    ? await prisma.cannedReply.update({ where: { id: b.id }, data: { title: b.title, body: b.body, shortcut: b.shortcut || null } })
    : await prisma.cannedReply.create({ data: { businessId: user.businessId, title: b.title, body: b.body, shortcut: b.shortcut || null, createdByUserId: user.id } });
  await audit(user.businessId, user.id, "canned_reply", row.id, b.id ? "canned_reply.updated" : "canned_reply.created", { title: b.title });
  return ok(row);
}, { minRole: "manager", module: "messaging" });

export const DELETE = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ id: z.string().min(1) }));
  const r = await prisma.cannedReply.deleteMany({ where: { id: b.id } });
  if (!r.count) throw new ApiError("לא נמצא", 404, "not_found");
  await audit(user.businessId, user.id, "canned_reply", b.id, "canned_reply.deleted");
  return ok({ deleted: true });
}, { minRole: "manager", module: "messaging" });
