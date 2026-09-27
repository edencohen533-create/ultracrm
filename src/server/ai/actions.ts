/**
 * Assistant actions: every action is a row (AiAction) – proposed → executed / failed / cancelled – with who asked,
 * who approved, the exact parameters, a before-snapshot and the server result. Execution always runs through the
 * regular services with the permissions of the executing user; the model never touches data directly.
 * An action is reported as done only when its row says "executed".
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { canManage, getAiSettings } from "./settings";

export type Executor = (user: SessionUser, params: Record<string, unknown>, action: { id: string; before: unknown }) => Promise<Record<string, unknown>>;
const EXECUTORS: Record<string, { run: Executor; managerOnly?: boolean }> = {};
/** Modules register their executors (tasks, leads, automations, repairs…). */
export function registerExecutor(kind: string, run: Executor, opts: { managerOnly?: boolean } = {}) { EXECUTORS[kind] = { run, ...opts }; }

export interface ProposeInput { kind: string; params: Record<string, unknown>; summary: string; impact?: string; requiresApproval: boolean; before?: unknown; conversationId?: string | null; incidentId?: string | null; channel?: string; dedupeKey?: string }

export async function proposeAction(user: SessionUser | null, businessId: string, input: ProposeInput) {
  if (!EXECUTORS[input.kind]) throw new ApiError(`פעולה לא נתמכת: ${input.kind}`, 400, "unsupported_action");
  try {
    return await prisma.aiAction.create({ data: { businessId, requestedById: user?.id ?? null, conversationId: input.conversationId ?? null, incidentId: input.incidentId ?? null, channel: input.channel ?? "app", kind: input.kind, params: input.params as Prisma.InputJsonValue, summary: input.summary.slice(0, 500), impact: input.impact?.slice(0, 1000) ?? null, requiresApproval: input.requiresApproval, before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined, dedupeKey: input.dedupeKey ?? null } });
  } catch (e) {
    if (input.dedupeKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return prisma.aiAction.findFirstOrThrow({ where: { businessId, dedupeKey: input.dedupeKey } });
    throw e;
  }
}

/** Execute a proposed action exactly once (atomic claim). `approving` marks an explicit user approval. */
export async function executeAction(user: SessionUser, actionId: string, approving = false) {
  const a = await prisma.aiAction.findFirst({ where: { id: actionId, businessId: user.businessId } });
  if (!a) throw new ApiError("הפעולה לא נמצאה", 404, "not_found");
  const ex = EXECUTORS[a.kind];
  if (!ex) throw new ApiError("פעולה לא נתמכת", 400, "unsupported_action");
  if (a.requiresApproval && !approving) throw new ApiError("הפעולה ממתינה לאישור", 409, "approval_required");
  const { ai } = await getAiSettings(user.businessId);
  if (ex.managerOnly && !canManage(user, ai)) throw new ApiError("אישור פעולה זו דורש הרשאת ניהול", 403, "forbidden");
  if (!ex.managerOnly && a.requestedById && a.requestedById !== user.id && !canManage(user, ai)) throw new ApiError("רק מי שביקש את הפעולה או מנהל יכולים לאשר אותה", 403, "forbidden");
  const claim = await prisma.aiAction.updateMany({ where: { id: a.id, status: "proposed" }, data: { status: "executing", ...(approving ? { approvedById: user.id, approvedAt: new Date() } : {}) } });
  if (!claim.count) return prisma.aiAction.findUniqueOrThrow({ where: { id: a.id } }); // already executed / cancelled
  try {
    const result = await ex.run(user, a.params as Record<string, unknown>, { id: a.id, before: a.before });
    const done = await prisma.aiAction.update({ where: { id: a.id }, data: { status: "executed", result: result as Prisma.InputJsonValue, executedAt: new Date(), error: null } });
    await audit(user.businessId, user.id, "ai_action", a.id, "ai.action_executed", { kind: a.kind, requestedBy: a.requestedById, approvedBy: approving ? user.id : null });
    return done;
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message.slice(0, 300);
    await audit(user.businessId, user.id, "ai_action", a.id, "ai.action_failed", { kind: a.kind, error: msg });
    return prisma.aiAction.update({ where: { id: a.id }, data: { status: "failed", error: msg, executedAt: new Date() } });
  }
}

export async function cancelAction(user: SessionUser, actionId: string) {
  const r = await prisma.aiAction.updateMany({ where: { id: actionId, businessId: user.businessId, status: "proposed", OR: [{ requestedById: user.id }, ...(user.role !== "agent" ? [{}] : [])] }, data: { status: "cancelled" } });
  if (!r.count) throw new ApiError("לא ניתן לבטל את הפעולה", 409, "not_cancellable");
  await audit(user.businessId, user.id, "ai_action", actionId, "ai.action_cancelled");
}

export const actionView = (a: { id: string; kind: string; summary: string; impact: string | null; status: string; requiresApproval: boolean; result: unknown; error: string | null; createdAt: Date; executedAt: Date | null; approvedById: string | null }) =>
  ({ id: a.id, kind: a.kind, summary: a.summary, impact: a.impact, status: a.status, requiresApproval: a.requiresApproval, result: a.result, error: a.error, createdAt: a.createdAt, executedAt: a.executedAt, approved: Boolean(a.approvedById) });
