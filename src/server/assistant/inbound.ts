/**
 * Inbound WhatsApp message → assistant (called from the Meta webhook handler BEFORE the message becomes a customer
 * conversation, and from the demo simulator). Only phones with a pending/active AssistantLink of THIS business are
 * intercepted; everyone else continues to the normal inbox untouched.
 */
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { answer, assistantMode, type Memory } from "./brain";
import { sendToLink } from "./transport";
import type { ToolCtx } from "./tools";

export const hashCode = (businessId: string, code: string) => crypto.createHash("sha256").update(`${businessId}:${code}`).digest("hex");

export async function toolCtxFor(link: { businessId: string; userId: string; scope: string }, tz: string): Promise<ToolCtx | null> {
  const user = await prisma.user.findFirst({ where: { id: link.userId, businessId: link.businessId, isActive: true }, select: { id: true, role: true, teamId: true, email: true, fullName: true, accountId: true } });
  if (!user) return null;
  const session: SessionUser = { id: user.id, accountId: user.accountId, businessId: link.businessId, email: user.email, fullName: user.fullName, role: user.role, teamId: user.teamId };
  const scope = link.scope === "own" || user.role === "agent" ? "own" : "business";
  return { businessId: link.businessId, userId: user.id, role: user.role, scope, tz, visibleIds: scope === "own" ? [user.id] : await visibleUserIds(session) };
}

/** Returns true when the message was handled by the assistant (caller must NOT create a customer message). */
export async function handleAssistantInbound(input: { businessId: string; phoneE164: string; text: string; providerMessageId?: string | null; credentialId?: string | null }): Promise<boolean> {
  const link = await prisma.assistantLink.findUnique({ where: { businessId_phoneE164: { businessId: input.businessId, phoneE164: input.phoneE164 } } });
  if (!link || link.status === "revoked") return false;
  const t0 = Date.now();
  // Idempotency: a retried webhook with the same provider message id is processed once.
  try { await prisma.assistantMessage.create({ data: { businessId: input.businessId, linkId: link.id, direction: "in", inboundKey: input.providerMessageId ? `wa:${input.providerMessageId}` : null, text: input.text.slice(0, 2000) } }); }
  catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return true; throw e; }
  const fresh = await prisma.assistantLink.update({ where: { id: link.id }, data: { lastInboundAt: new Date() } });
  const reply = async (text: string, meta: { intent?: string | null; tools?: unknown; status?: string; error?: string; model?: string } = {}) => {
    const out = await sendToLink(fresh, text, { credentialId: input.credentialId });
    await prisma.assistantMessage.create({ data: { businessId: input.businessId, linkId: link.id, direction: "out", text: text.slice(0, 4000), intent: meta.intent ?? null, tools: (meta.tools ?? []) as Prisma.InputJsonValue, status: out.status === "sent" ? meta.status ?? "ok" : out.status, error: meta.error ?? out.detail ?? null, model: meta.model ?? null, latencyMs: Date.now() - t0 } });
  };
  const settings = await getBusinessSettings(input.businessId);

  if (link.status === "pending") {
    const code = input.text.match(/\b(\d{6})\b/)?.[1];
    if (!code || !link.codeHash || !link.codeExpiresAt || link.codeExpiresAt < new Date() || hashCode(input.businessId, code) !== link.codeHash) {
      await reply(link.codeExpiresAt && link.codeExpiresAt < new Date() ? "⏱️ קוד האימות פג תוקף. צור קוד חדש במערכת (הגדרות → העוזר האישי בוואטסאפ)." : "🔐 המספר ממתין לאימות. שלח כאן את קוד 6 הספרות שמופיע במערכת (הגדרות → העוזר האישי בוואטסאפ).", { status: "blocked", intent: "verify" });
      return true;
    }
    await prisma.assistantLink.update({ where: { id: link.id }, data: { status: "active", verifiedAt: new Date(), codeHash: null, codeExpiresAt: null } });
    await prisma.auditLog.create({ data: { businessId: input.businessId, actorId: link.userId, action: "assistant.link_verified", entityType: "AssistantLink", entityId: link.id, payload: { phoneLast4: link.phoneE164.slice(-4) } } });
    await reply("✅ המספר אומת! מעכשיו אפשר לשאול אותי על העסק, למשל: \"איך הולך היום?\"", { intent: "verify" });
    return true;
  }
  if (!settings.assistant.enabled) { await reply("העוזר האישי כבוי כרגע. אפשר להפעיל אותו במערכת: הגדרות → העוזר האישי בוואטסאפ.", { status: "blocked" }); return true; }
  const ctx = await toolCtxFor(link, settings.timezone);
  if (!ctx) {
    await prisma.assistantLink.update({ where: { id: link.id }, data: { status: "revoked", revokedAt: new Date() } });
    await reply("⛔ הגישה של המשתמש הזה בוטלה.", { status: "blocked" });
    return true;
  }
  // A report that waited for the service window to open is delivered first.
  if (fresh.pendingReport) {
    await prisma.assistantLink.update({ where: { id: link.id }, data: { pendingReport: null } });
    await reply(fresh.pendingReport, { intent: "pending_report" });
    if (/^(דוח|הדוח|כן|שלח|תשלח|report|ok|אוקיי)[\s!.?]*$/i.test(input.text.trim())) return true;
  }
  const history = (await prisma.assistantMessage.findMany({ where: { linkId: link.id, createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } }, orderBy: { createdAt: "desc" }, take: 11, select: { direction: true, text: true } })).reverse().slice(0, -1);
  try {
    const a = await answer(ctx, input.text, (link.context ?? {}) as Memory, history);
    await prisma.assistantLink.update({ where: { id: link.id }, data: { context: a.memory as Prisma.InputJsonValue } });
    await reply(a.text, { intent: a.intent, tools: a.tools, model: a.model, status: a.tools.some((t) => !t.ok) ? "error" : "ok" });
  } catch (e) {
    await reply("⚠️ משהו השתבש בשליפת הנתונים. לא מציג מספרים שאינם ודאיים – נסה שוב בעוד רגע.", { status: "error", error: (e as Error).message.slice(0, 200), model: assistantMode() });
  }
  return true;
}
