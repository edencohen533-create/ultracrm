import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/** Carts list + headline numbers for the "עגלות נטושות" screen. */
export const GET = withAuth(async ({ req }) => {
  const f = parseQuery(req, z.object({ status: z.enum(["open", "abandoned", "converted", "recovered"]).optional(), storeId: z.string().optional(), q: z.string().max(100).optional(), days: z.coerce.number().int().min(1).max(365).default(30), page: z.coerce.number().int().min(1).default(1) }));
  const since = new Date(Date.now() - f.days * 86400_000);
  const base: Prisma.CartWhereInput = { createdAt: { gte: since }, ...(f.storeId ? { storeId: f.storeId } : {}) };
  const where: Prisma.CartWhereInput = { ...base, ...(f.status ? { status: f.status } : {}), ...(f.q ? { OR: [{ email: { contains: f.q, mode: "insensitive" } }, { phoneE164: { contains: f.q.replace(/\D/g, "").replace(/^0/, "") || f.q } }, { customerName: { contains: f.q, mode: "insensitive" } }] } : {}) };
  const [total, items, byStatus] = await Promise.all([
    prisma.cart.count({ where }),
    prisma.cart.findMany({ where, orderBy: { lastActivityAt: "desc" }, skip: (f.page - 1) * 50, take: 50, include: { store: { select: { name: true, platform: true } }, contact: { select: { id: true, fullName: true } } } }),
    prisma.cart.groupBy({ by: ["status"], where: base, _count: true, _sum: { total: true, orderTotal: true } }),
  ]);
  const stat = (s: string) => byStatus.find((b) => b.status === s);
  const abandonedEver = (stat("abandoned")?._count ?? 0) + (stat("recovered")?._count ?? 0);
  return ok({
    total, page: f.page, items,
    stats: {
      open: stat("open")?._count ?? 0,
      abandoned: stat("abandoned")?._count ?? 0, abandonedValue: Number(stat("abandoned")?._sum.total ?? 0),
      recovered: stat("recovered")?._count ?? 0, recoveredValue: Number(stat("recovered")?._sum.orderTotal ?? 0),
      converted: stat("converted")?._count ?? 0,
      recoveryRate: abandonedEver ? Math.round(((stat("recovered")?._count ?? 0) / abandonedEver) * 1000) / 10 : null,
    },
  });
}, { minRole: "manager", module: "messaging" });
