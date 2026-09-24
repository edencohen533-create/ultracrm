import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { phoneDigits } from "@/lib/phone";

export const dynamic = "force-dynamic";

/** Active suppressions of the business (managers). */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }));
  const digits = f.q ? phoneDigits(f.q) : "";
  const items = await prisma.suppression.findMany({
    where: { businessId: user.businessId, revokedAt: null, ...(f.q ? { OR: [{ identifier: { contains: f.q.toLowerCase() } }, ...(digits.length >= 3 ? [{ identifier: { contains: digits.replace(/^0/, "") } }] : []), { contact: { fullName: { contains: f.q, mode: "insensitive" as const } } }] } : {}) },
    orderBy: { createdAt: "desc" },
    take: f.limit,
    include: { contact: { select: { id: true, fullName: true } }, createdBy: { select: { fullName: true } } },
  });
  return ok({ items });
}, { minRole: "manager" });
