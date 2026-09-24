import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ok, ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { assertTenantReferences } from "@/lib/tenant-references";
import { numberProviderFor } from "@/lib/numbers/providers";
import { lockNumberPool, numberPolicySchema } from "@/lib/numbers/selection";
import { numberOperationLimit, checkNumberConnection, syncNumbers, createNumberQuote, confirmNumberPurchase, reconcileNumberOrder, saveNumberPolicy, numbersOverview } from "@/lib/numbers/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Management overview: numbers with activity/reputation, orders, campaign policies. Managers and owners. */
export const GET = withAuth(async ({ user, req }) => {
  const { days } = parseQuery(req, z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }));
  return ok(await numbersOverview(user, days));
}, { minRole: "manager", module: "telephony" });

const id = z.string().min(1).max(100);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connection") }), z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("search"), country: z.string().regex(/^[A-Z]{2}$/), type: z.enum(["local", "mobile", "toll-free", "national"]) }),
  z.object({ action: z.literal("quote"), e164: z.string().regex(/^\+[1-9]\d{6,14}$/), country: z.string().regex(/^[A-Z]{2}$/), type: z.enum(["local", "mobile", "toll-free", "national"]) }),
  z.object({ action: z.literal("purchase"), id, confirmed: z.literal(true) }), z.object({ action: z.literal("reconcile"), id }),
  z.object({ action: z.literal("policy"), listId: id, policy: numberPolicySchema }),
  z.object({ action: z.literal("number"), id, outboundPaused: z.boolean().optional(), isActive: z.boolean().optional(), assignedUserId: id.nullable().optional(), callbackUserId: id.nullable().optional(), maxConcurrent: z.number().int().min(1).max(1000).nullable().optional(), maxDailyAttempts: z.number().int().min(1).max(100000).nullable().optional() }),
  z.object({ action: z.literal("reputation_check"), id }),
  z.object({ action: z.literal("reputation_manual"), id, status: z.enum(["clear", "spam", "unknown"]), note: z.string().min(5).max(1000) }),
  z.object({ action: z.literal("review"), id, note: z.string().min(5).max(1000), resolved: z.boolean().default(false) }),
]);

export const POST = withAuth(async ({ user, req }) => {
  const b = await parseBody(req, schema);
  if (["connection", "sync", "search", "quote", "purchase", "reconcile"].includes(b.action)) requireRole(user, "owner");
  await numberOperationLimit(user.businessId, user.id, b.action);
  if (b.action === "connection") { const c = await checkNumberConnection(user.businessId); return ok({ status: c.status, checkedAt: c.checkedAt }); }
  if (b.action === "sync") return ok(await syncNumbers(user.businessId));
  if (b.action === "search") return ok(await numberProviderFor(user.businessId).search(b.country, b.type));
  if (b.action === "quote") return ok(await createNumberQuote(user, b));
  if (b.action === "purchase") return ok(await confirmNumberPurchase(user, b.id, b.confirmed));
  if (b.action === "reconcile") return ok(await reconcileNumberOrder(user, b.id));
  if (b.action === "policy") return ok(await saveNumberPolicy(user, b.listId, b.policy));
  const n = await prisma.phoneNumber.findFirst({ where: { id: b.id, businessId: user.businessId } });
  if (!n) throw new ApiError("מספר לא נמצא", 404, "not_found");
  if (b.action === "reputation_check") return ok({ status: "unsupported", checkedAt: null, message: "אין API מורשה מחובר לבדיקת מוניטין Truecaller. ניתן לבצע בדיקה ידנית אצל הספק ולתעד אותה." });
  if (b.action === "number") {
    await assertTenantReferences(user.businessId, { userIds: [b.assignedUserId, b.callbackUserId] });
    const { action: _action, id: _id, ...data } = b; void _action; void _id;
    return ok(await prisma.$transaction(async (tx) => { await lockNumberPool(tx, user.businessId); await audit(user.businessId, user.id, "phone_number", n.id, "number.updated", data, tx); return tx.phoneNumber.update({ where: { id: n.id }, data }); }));
  }
  if (b.action === "reputation_manual") {
    const updated = await prisma.phoneNumber.update({ where: { id: n.id }, data: { reputationStatus: b.status, reputationSource: "manual_truecaller", reputationCheckedAt: new Date(), reputationData: { note: b.note, reportedBy: user.id, method: "manual", providerApiResponse: null }, reputationReview: b.status === "spam" ? "required" : null } });
    await audit(user.businessId, user.id, "phone_number", n.id, "number.reputation_manual", { status: b.status, note: b.note }); return ok(updated);
  }
  await audit(user.businessId, user.id, "phone_number", n.id, "number.reputation_review", { note: b.note, resolved: b.resolved });
  return ok(await prisma.phoneNumber.update({ where: { id: n.id }, data: { reputationReview: b.resolved ? "resolved" : "open" } }));
}, { minRole: "manager", module: "telephony" });
