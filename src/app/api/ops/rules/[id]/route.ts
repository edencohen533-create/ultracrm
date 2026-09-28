import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ALLOWED_AUTONOMY, parseConfig, type RuleKind } from "@/server/ops/rules";

const patch = z.object({ name: z.string().trim().min(2).max(120).optional(), status: z.enum(["active", "paused"]).optional(), autonomy: z.enum(["insight", "recommend", "auto"]).optional(), priority: z.number().int().min(1).max(1000).optional(), config: z.record(z.string(), z.unknown()).optional(), expiresAt: z.string().datetime().nullable().optional() });

async function load(businessId: string, id: string) {
  const r = await prisma.opsRule.findFirst({ where: { id, businessId } });
  if (!r) throw new ApiError("הכלל לא נמצא", 404, "not_found");
  return r;
}

/** Edit / pause / resume a rule. Pausing never undoes what already happened. */
export const PATCH = withAuth(async ({ req, user, params }) => {
  const r = await load(user.businessId, params.id);
  const b = await parseBody(req, patch);
  if (b.autonomy && !ALLOWED_AUTONOMY[r.kind as RuleKind].includes(b.autonomy)) throw new ApiError("רמת האוטונומיה לא מתאימה לסוג הכלל", 400, "validation");
  const config = b.config ? parseConfig(r.kind as RuleKind, { ...(r.config as object), ...b.config }) : undefined;
  const u = await prisma.opsRule.update({ where: { id: r.id }, data: { ...(b.name ? { name: b.name } : {}), ...(b.status ? { status: b.status } : {}), ...(b.autonomy ? { autonomy: b.autonomy } : {}), ...(b.priority ? { priority: b.priority } : {}), ...(config ? { config: config as object } : {}), ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt ? new Date(b.expiresAt) : null } : {}) } });
  await audit(user.businessId, user.id, "ops_rule", r.id, "ops_rule.updated", { changes: b });
  return ok(u);
}, { minRole: "manager", module: "crm" });

export const DELETE = withAuth(async ({ user, params }) => {
  const r = await load(user.businessId, params.id);
  await prisma.opsRule.delete({ where: { id: r.id } });
  await audit(user.businessId, user.id, "ops_rule", r.id, "ops_rule.deleted", { kind: r.kind, name: r.name });
  return ok({ deleted: true });
}, { minRole: "manager", module: "crm" });
