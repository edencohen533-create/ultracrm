/**
 * "עוזר AI" settings (business settings JSON key "ai"). Everything the assistant may do is decided here + by the
 * user's role – never by what the user or a customer writes in a message.
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";

export type ActionPolicy = "auto" | "approve" | "off";
export interface AiSettings {
  name: string; language: "he" | "en"; tone: "friendly" | "formal" | "short"; length: "short" | "normal" | "detailed";
  /** Who may chat with the internal assistant: managers always; agents only when allowed (own data only). */
  agentsCanChat: boolean;
  /** Managers allowed to manage the assistant (knowledge approval, automations, settings). Empty = every manager. Owner always. */
  managerIds: string[];
  /** One-off actions from the chat. Automations and wide / irreversible changes always require approval. */
  actions: { create_task: ActionPolicy; set_follow_up: ActionPolicy; change_lead_status: ActionPolicy; transfer_lead: ActionPolicy };
  /** Limited, reversible repairs (e.g. re-sync a dial queue, release a stale lock) may run without asking. */
  autoRepairs: boolean;
  /** Customer-service agent on WhatsApp – OFF until the manager tested and enabled it. */
  service: {
    enabled: boolean; credentialIds: string[]; hours: { start: string; end: string; days: number[] };
    qualificationQuestions: string[]; handoffTopics: string[]; allowOrderStatus: boolean; maxRepliesPerConversationPerHour: number; dailyReplyLimit: number;
    offHoursMessage: string;
  };
  limits: { dailyChatMessagesPerUser: number };
}
export const DEFAULT_AI: AiSettings = {
  name: "העוזר", language: "he", tone: "friendly", length: "short", agentsCanChat: true, managerIds: [],
  actions: { create_task: "auto", set_follow_up: "auto", change_lead_status: "auto", transfer_lead: "approve" },
  autoRepairs: true,
  service: { enabled: false, credentialIds: [], hours: { start: "09:00", end: "18:00", days: [0, 1, 2, 3, 4] }, qualificationQuestions: [], handoffTopics: ["תלונה", "ביטול עסקה", "החזר כספי"], allowOrderStatus: true, maxRepliesPerConversationPerHour: 12, dailyReplyLimit: 500, offHoursMessage: "" },
  limits: { dailyChatMessagesPerUser: 300 },
};

export function mergeAi(raw: unknown): AiSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AiSettings>;
  return { ...DEFAULT_AI, ...r, actions: { ...DEFAULT_AI.actions, ...(r.actions ?? {}) }, service: { ...DEFAULT_AI.service, ...(r.service ?? {}), hours: { ...DEFAULT_AI.service.hours, ...(r.service?.hours ?? {}) } }, limits: { ...DEFAULT_AI.limits, ...(r.limits ?? {}) }, managerIds: Array.isArray(r.managerIds) ? r.managerIds : [] };
}
export async function getAiSettings(businessId: string) {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { settings: true, timezone: true, name: true } });
  return { ai: mergeAi((b?.settings as { ai?: unknown } | null)?.ai), timezone: b?.timezone ?? "Asia/Jerusalem", businessName: b?.name ?? "" };
}

export const canManage = (user: SessionUser, s: AiSettings) => user.role === "owner" || (user.role === "manager" && (!s.managerIds.length || s.managerIds.includes(user.id)));
export function assertCanChat(user: SessionUser, s: AiSettings) {
  if (user.role === "agent" && !s.agentsCanChat) throw new ApiError("העוזר זמין כרגע למנהלים בלבד (הגדרות → עוזר AI)", 403, "forbidden");
}
export function assertCanManage(user: SessionUser, s: AiSettings) {
  if (!canManage(user, s)) throw new ApiError("נדרשת הרשאת ניהול של העוזר", 403, "forbidden");
}
export const aiConnected = () => Boolean(process.env.ANTHROPIC_API_KEY);
