import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseConfig } from "@/server/ops/rules";
import { conflictsOf } from "@/server/ops/distribution";

export const dynamic = "force-dynamic";

async function load(businessId: string, id: string) {
  const r = await prisma.opsRule.findFirst({ where: { id, businessId, kind: "performance_bonus" } });
  if (!r) throw new ApiError("הכלל לא נמצא", 404, "not_found");
  return r;
}

/** Activate (owner's approval) / pause / back to draft / edit. Activation re-validates and reports conflicts. */
export const PATCH = withAuth(async ({ req, user, params }) => {
  const r = await load(user.businessId, params.id);
  const b = await parseBody(req, z.object({ status: z.enum(["active", "paused", "draft"]).optional(), name: z.string().trim().min(2).max(120).optional(), config: z.record(z.string(), z.unknown()).optional(), priority: z.number().int().min(1).max(1000).optional(), autonomy: z.enum(["recommend", "auto"]).optional() }));
  const config = b.config ? parseConfig("performance_bonus", { ...(r.config as object), ...b.config }) : parseConfig("performance_bonus", r.config);
  if (b.status === "active" && !(await prisma.user.findFirst({ where: { id: config.agentId, businessId: user.businessId, isActive: true }, select: { id: true } }))) throw new ApiError("הנציג אינו פעיל – אי אפשר להפעיל את הכלל", 409, "agent_inactive");
  // Editing an active rule's substance returns it to draft – the owner approves the new version.
  const substantive = Boolean(b.config) && r.status === "active" && !b.status;
  const u = await prisma.opsRule.update({ where: { id: r.id }, data: { ...(b.name ? { name: b.name } : {}), ...(b.priority ? { priority: b.priority } : {}), ...(b.autonomy ? { autonomy: b.autonomy } : {}), ...(b.config ? { config: config as object } : {}), ...(b.status ? { status: b.status } : substantive ? { status: "draft" } : {}) } });
  await audit(user.businessId, user.id, "ops_rule", r.id, b.status === "active" ? "distribution_rule.approved" : "distribution_rule.updated", { changes: b, backToDraft: substantive });
  const active = await prisma.opsRule.findMany({ where: { businessId: user.businessId, kind: "performance_bonus", status: "active" }, select: { id: true, name: true, priority: true, createdAt: true, config: true } });
  return ok({ ...u, conflicts: conflictsOf(active)[u.id] ?? [] });
}, { minRole: "owner" });

export const DELETE = withAuth(async ({ user, params }) => {
  const r = await load(user.businessId, params.id);
  await prisma.opsRule.delete({ where: { id: r.id } });
  await audit(user.businessId, user.id, "ops_rule", r.id, "distribution_rule.deleted", { name: r.name });
  return ok({ deleted: true });
}, { minRole: "owner" });
