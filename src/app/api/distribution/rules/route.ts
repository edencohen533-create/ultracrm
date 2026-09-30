import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseConfig } from "@/server/ops/rules";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(2).max(120), config: z.record(z.string(), z.unknown()), autonomy: z.enum(["recommend", "auto"]).default("auto"),
  priority: z.number().int().min(1).max(1000).default(100), sourceText: z.string().max(1000).nullable().optional(), expiresAt: z.string().datetime().nullable().optional(),
});

/** Save a distribution rule as a DRAFT (it does nothing until the owner activates it). Owner only. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const config = parseConfig("performance_bonus", b.config);
  const agent = await prisma.user.findFirst({ where: { id: config.agentId, businessId: user.businessId, isActive: true, role: { in: ["agent", "manager"] } }, select: { id: true } });
  if (!agent) throw new ApiError("הנציג לא נמצא בעסק", 400, "invalid_agent");
  if (config.listId && !(await prisma.dialList.findFirst({ where: { id: config.listId, businessId: user.businessId }, select: { id: true } }))) throw new ApiError("הקמפיין לא נמצא", 400, "invalid_list");
  const r = await prisma.opsRule.create({ data: { businessId: user.businessId, kind: "performance_bonus", name: b.name, config: config as object, autonomy: b.autonomy, priority: b.priority, status: "draft", sourceText: b.sourceText ?? null, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null, createdById: user.id } });
  await audit(user.businessId, user.id, "ops_rule", r.id, "distribution_rule.drafted", { config, sourceText: r.sourceText });
  return ok(r, 201);
}, { minRole: "owner" });
