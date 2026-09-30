import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ALLOWED_AUTONOMY, RULE_KINDS, parseConfig, type RuleKind } from "@/server/ops/rules";

const ruleSchema = z.object({
  kind: z.enum(RULE_KINDS), name: z.string().trim().min(2).max(120), config: z.record(z.string(), z.unknown()).default({}),
  autonomy: z.enum(["insight", "recommend", "auto"]), priority: z.number().int().min(1).max(1000).default(100),
  sourceText: z.string().max(1000).nullable().optional(), expiresAt: z.string().datetime().nullable().optional(),
});

/** Save a rule (after the manager saw the summary). Business owners/managers only. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, ruleSchema);
  // Distribution rules are the owner's (CRM → חלוקת לידים), created there as drafts.
  if (b.kind === "performance_bonus") throw new ApiError("כללי חלוקה נוצרים במסך חלוקת הלידים, על ידי בעל העסק", 403, "owner_only");
  if (!ALLOWED_AUTONOMY[b.kind as RuleKind].includes(b.autonomy)) throw new ApiError("רמת האוטונומיה לא מתאימה לסוג הכלל", 400, "validation");
  const config = parseConfig(b.kind, b.config);
  const r = await prisma.opsRule.create({ data: { businessId: user.businessId, kind: b.kind, name: b.name, config: config as object, autonomy: b.autonomy, priority: b.priority, sourceText: b.sourceText ?? null, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null, createdById: user.id } });
  await audit(user.businessId, user.id, "ops_rule", r.id, "ops_rule.created", { kind: r.kind, autonomy: r.autonomy, config, sourceText: r.sourceText });
  return ok(r, 201);
}, { minRole: "manager", module: "crm" });
