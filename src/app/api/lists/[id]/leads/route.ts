import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { contactFilterSchema } from "@/lib/contacts";
import { addLeadsToList } from "@/lib/lists";
import { phoneDigits } from "@/lib/phone";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const q = z.object({
  status: z.string().optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(["queue", "name", "attempts", "lastAttempt", "nextAttempt"]).default("queue"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = withAuth(async ({ req, user, params }) => {
  const f = parseQuery(req, q);
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId }, select: { id: true, agents: { select: { userId: true } } } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  if (user.role === "agent" && list.agents.length && !list.agents.some((a) => a.userId === user.id)) throw new ApiError("אין הרשאה", 403, "forbidden");

  const where: Prisma.ListLeadWhereInput = { listId: list.id };
  if (f.status) where.status = f.status as Prisma.ListLeadWhereInput["status"];
  if (f.q) {
    const d = phoneDigits(f.q);
    where.contact = { OR: [{ fullName: { contains: f.q, mode: "insensitive" } }, ...(d.length >= 3 ? [{ phoneE164: { contains: d.replace(/^0/, "") } }] : [])] };
  }
  const orderBy: Prisma.ListLeadOrderByWithRelationInput[] =
    f.sort === "name" ? [{ contact: { fullName: "asc" } }]
    : f.sort === "attempts" ? [{ attempts: "desc" }]
    : f.sort === "lastAttempt" ? [{ lastAttemptAt: { sort: "desc", nulls: "last" } }]
    : f.sort === "nextAttempt" ? [{ nextAttemptAt: { sort: "asc", nulls: "first" } }]
    : [{ priority: "desc" }, { nextAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }];

  const [total, items] = await Promise.all([
    prisma.listLead.count({ where }),
    prisma.listLead.findMany({
      where,
      orderBy,
      skip: (f.page - 1) * f.limit,
      take: f.limit,
      include: { contact: { select: { id: true, fullName: true, phoneE164: true, source: true, company: true, city: true } }, lockedBy: { select: { id: true, fullName: true } } },
    }),
  ]);
  return ok({ items, total, page: f.page, limit: f.limit });
});

const addSchema = z.object({ filter: contactFilterSchema.optional(), contactIds: z.array(z.string()).max(10000).optional() });

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, addSchema);
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  const added = await addLeadsToList(user.businessId, list.id, b.filter, b.contactIds);
  return ok({ added });
}, { minRole: "manager" });

const patchSchema = z.object({ leadIds: z.array(z.string()).min(1).max(1000), action: z.enum(["remove", "requeue", "priority"]), priority: z.number().int().min(0).max(100).optional() });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, patchSchema);
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  const where = { listId: list.id, id: { in: b.leadIds }, status: { notIn: ["in_call" as const] } };
  if (b.action === "remove") await prisma.listLead.updateMany({ where, data: { status: "removed", lockedByUserId: null, lockToken: null, lockExpiresAt: null } });
  else if (b.action === "requeue") await prisma.listLead.updateMany({ where: { ...where, status: { notIn: ["in_call", "dnc"] } }, data: { status: "pending", nextAttemptAt: null, attempts: 0, lockedByUserId: null, lockToken: null, lockExpiresAt: null } });
  else await prisma.listLead.updateMany({ where, data: { priority: b.priority ?? 0 } });
  return ok({ updated: true });
}, { minRole: "manager" });
