import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";

export const dynamic = "force-dynamic";

const q = z.object({ status: z.enum(["open", "done", "cancelled"]).default("open"), userId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, q);
  const ids = await visibleUserIds(user);
  const userFilter = f.userId ? (ids && !ids.includes(f.userId) ? { userId: "__none__" } : { userId: f.userId }) : ids ? { userId: { in: ids } } : {};
  const items = await prisma.task.findMany({
    where: { businessId: user.businessId, status: f.status, ...userFilter },
    orderBy: { dueAt: "asc" },
    take: f.limit,
    include: { contact: { select: { id: true, fullName: true, phoneE164: true } }, user: { select: { id: true, fullName: true } }, lead: { select: { id: true, listId: true, status: true } } },
  });
  return ok({ items, now: new Date().toISOString() });
});
