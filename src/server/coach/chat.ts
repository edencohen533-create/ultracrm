/**
 * "נתקעתי? שאל את ה-AI" – free-text chat between the agent and the coach during a call.
 * Same data sources as the live coach (lead, WhatsApp, previous outcomes, transcript when it exists, reviewed
 * examples, approved knowledge) plus the chat history of this call. When there is no transcript the prompt says so
 * explicitly and the answer is based on what the agent typed. Every answer records which sources actually fed it.
 */
import { prisma } from "@/lib/db";
import { llmComplete, usageCostUsd, type Usage } from "./providers";
import { chatSystemPrompt, chatUserPrompt, parseChat, type KnowledgeView } from "./prompt";
import { retrieveExamples, matchKnowledgeObjections } from "./retrieval";
import { ensureSession, loadContext } from "./session";

const HISTORY = 10;
const TRANSCRIPT_LINES = 12;

export interface ChatSources { transcriptLines: number; lead: boolean; product: boolean; whatsapp: number; outcomes: number; examples: number; knowledgeObjections: number; model: string; latencyMs: number; mock: boolean }
export interface ChatMessageView { id: string; role: "agent" | "assistant"; text: string; followUp: string | null; why: string | null; basis: string | null; sources: Partial<ChatSources>; createdAt: Date }

const view = (m: { id: string; role: string; text: string; followUp: string | null; why: string | null; basis: string | null; sources: unknown; createdAt: Date }): ChatMessageView =>
  ({ id: m.id, role: m.role === "agent" ? "agent" : "assistant", text: m.text, followUp: m.followUp, why: m.why, basis: m.basis, sources: (m.sources ?? {}) as Partial<ChatSources>, createdAt: m.createdAt });

export async function chatHistory(callId: string): Promise<ChatMessageView[]> {
  const session = await prisma.coachSession.findUnique({ where: { callId }, select: { id: true } });
  if (!session) return [];
  return (await prisma.coachChatMessage.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" }, take: 60 })).map(view);
}

/** One question → one answer. Throws CoachProviderError when no LLM is configured (the route turns it into a clear message). */
export async function askCoach(callId: string, question: string): Promise<{ question: ChatMessageView; answer: ChatMessageView }> {
  const t0 = Date.now();
  const session = await ensureSession(callId);
  const q = question.trim().slice(0, 1000);
  const asked = await prisma.coachChatMessage.create({ data: { businessId: session.businessId, sessionId: session.id, callId, role: "agent", text: q } });
  try {
  const ctx = await loadContext(session.id);
  const history = (await prisma.coachChatMessage.findMany({ where: { sessionId: session.id, id: { not: asked.id } }, orderBy: { createdAt: "desc" }, take: HISTORY })).reverse();
  const transcript = ctx.segments.slice(-TRANSCRIPT_LINES);
  const contact = session.contactId ? await prisma.contact.findUnique({ where: { id: session.contactId }, select: { source: true, customFields: true } }) : null;
  const cf = (contact?.customFields ?? {}) as Record<string, unknown>;
  const product = typeof cf.product === "string" ? cf.product : null;
  const { examples, usage: embUsage } = await retrieveExamples(session.businessId, q, 3);
  const matched = matchKnowledgeObjections(ctx.knowledge, q, 3);
  const knowledge: KnowledgeView = { ...ctx.knowledge, objections: matched.length ? matched : ctx.knowledge.objections.slice(0, 5) };
  const outcomes = ctx.calls.map((c) => `${c.outcome ?? ""}${c.outcomeNote ? ` – ${c.outcomeNote}` : ""}`.trim()).filter(Boolean);
  const llm = await llmComplete(chatSystemPrompt(knowledge, transcript.length > 0), chatUserPrompt({
    question: q,
    history: history.map((m) => ({ role: m.role, text: m.role === "agent" ? m.text : [m.text, m.followUp].filter(Boolean).join(" / ") })),
    transcript: transcript.map((s) => ({ speaker: s.speaker, text: s.text })),
    summary: ctx.session.summary,
    lead: { name: ctx.contact?.fullName ?? "לקוח", leadTitle: ctx.lead?.title, leadStatus: ctx.lead?.status, notes: [ctx.lead?.notes, ctx.contact?.notes].filter(Boolean).join(" | ") || null, lastOutcomes: outcomes, promisesSoFar: [], product, source: contact?.source ?? null },
    whatsapp: ctx.messages.map((m) => ({ direction: m.direction === "INBOUND" ? "customer" : "agent", text: m.body ?? "" })),
    outcomes, knowledge, examples,
  }), { maxTokens: 350, temperature: 0.4 });
  const parsed = parseChat(llm.text);
  const usage: Usage = { inputTokens: llm.usage.inputTokens + embUsage.inputTokens, outputTokens: llm.usage.outputTokens, embeddingTokens: embUsage.embeddingTokens };
  const sources: ChatSources = { transcriptLines: transcript.length, lead: Boolean(ctx.lead || ctx.contact), product: Boolean(product), whatsapp: ctx.messages.length, outcomes: outcomes.length, examples: examples.length, knowledgeObjections: matched.length, model: llm.model, latencyMs: Date.now() - t0, mock: llm.model === "mock" };
  const basis = examples.length ? "examples" : matched.length || ctx.knowledge.products.length || ctx.knowledge.faqs.length ? "knowledge_only" : "general";
  const answer = await prisma.$transaction(async (tx) => {
    await tx.coachSession.update({ where: { id: session.id }, data: { tokensIn: { increment: usage.inputTokens }, tokensOut: { increment: usage.outputTokens }, costUsd: { increment: usageCostUsd(usage) } } });
    return tx.coachChatMessage.create({ data: {
      businessId: session.businessId, sessionId: session.id, callId, role: "assistant",
      text: parsed?.say_now ?? "לא הצלחתי לנסח תשובה מהמידע שיש. נסה לתאר במשפט מה הלקוח אמר בדיוק.",
      followUp: parsed?.follow_up ?? null, why: parsed?.why ?? null, basis: parsed ? basis : "unparsed",
      sources: { ...sources, exampleIds: examples.map((e) => e.id), exampleCalls: examples.map((e) => e.callId).filter(Boolean), confidence: parsed?.confidence ?? 0 },
    } });
  });
  return { question: view(asked), answer: view(answer) };
  } catch (e) {
    // Provider/DB failure: do not leave an unanswered question in the history.
    await prisma.coachChatMessage.delete({ where: { id: asked.id } }).catch(() => undefined);
    throw e;
  }
}
