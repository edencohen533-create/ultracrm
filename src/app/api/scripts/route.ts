import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => ok(await prisma.script.findMany({ where: { businessId: user.businessId }, orderBy: [{ isDefault: "desc" }, { title: "asc" }] })));

const schema = z.object({ title: z.string().min(1).max(120), body: z.string().max(20000), isDefault: z.boolean().optional() });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const s = await prisma.$transaction(async (tx) => {
    if (b.isDefault) await tx.script.updateMany({ where: { businessId: user.businessId }, data: { isDefault: false } });
    return tx.script.create({ data: { businessId: user.businessId, title: b.title.trim(), body: b.body, isDefault: Boolean(b.isDefault) } });
  });
  return ok(s, 201);
}, { minRole: "manager" });
