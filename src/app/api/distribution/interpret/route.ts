import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { interpretRule } from "@/server/ops/rules";

export const dynamic = "force-dynamic";

/** "תאר איך לחלק את הלידים": free text → a structured rule proposal + questions (nothing saved). Owner only. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ text: z.string().trim().min(5).max(1000) }));
  const agents = await prisma.user.findMany({ where: { businessId: user.businessId, isActive: true, role: { in: ["agent", "manager"] } }, select: { id: true, fullName: true } });
  return ok(await interpretRule(b.text, { agents }));
}, { minRole: "owner" });
