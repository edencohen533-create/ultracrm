import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const items = await prisma.tag.findMany({ where: { businessId: user.businessId }, orderBy: { name: "asc" }, include: { _count: { select: { contacts: true, conversations: true } } } });
  return ok({ items });
});

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }));
  const tag = await prisma.tag.upsert({ where: { businessId_name: { businessId: user.businessId, name: b.name } }, update: { ...(b.color ? { color: b.color } : {}) }, create: { businessId: user.businessId, name: b.name, color: b.color ?? "#6366f1" } });
  return ok(tag, 201);
});
