/**
 * Layers 1+2+4 – call ingestion, conversation state and recommendation generation.
 *
 * Flow per batch of transcript segments:
 *   segments → session (rolling summary + last N lines) → retrieval → one LLM call → dedupe / supersede →
 *   CoachRecommendation (with latency measured from the end of the customer's utterance) → usage metered.
 *
 * Failure policy: any provider error marks the session `unavailable` and returns; the call itself is untouched.
 */
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { getBusinessSettings } from "@/lib/settings";
import type { CoachSpeaker, CoachSegmentSource, Prisma } from "@/generated/prisma/client";
import { llmComplete, providerStatus, usageCostUsd, type Usage } from "./providers";
import { knowledgeView, parseRecommendation, systemPrompt, userPrompt, type KnowledgeView } from "./prompt";
import { retrieveExamples, keywordScore, matchKnowledgeObjections } from "./retrieval";

const RECENT_LINES = 10;
const SUMMARY_EVERY = 8; // fold the transcript into the rolling summary every N segments

export interface CoachStatus { enabled: boolean; reason?: string; providers: ReturnType<typeof providerStatus>; live: boolean }

/** Is the coach on for this business + agent, and can it actually produce anything? */
export async function coachStatus(userId: string): Promise<CoachStatus> {
  const businessId = requireBusinessId();
  const [settings, user] = await Promise.all([getBusinessSettings(businessId), prisma.user.findUnique({ where: { id: userId }, select: { coachEnabled: true } })]);
  const providers = providerStatus();
  if (!settings.coach.enabled) return { enabled: false, reason: "המאמן כבוי לעסק (הגדרות → מאמן AI)", providers, live: false };
  if (!user?.coachEnabled) return { enabled: false, reason: "המאמן כבוי לנציג זה", providers, live: false };
  if (providers.llm === "missing") return { enabled: true, reason: "חסר מפתח AI (ANTHROPIC_API_KEY) – אין המלצות", providers, live: false };
  return { enabled: true, providers, live: true };
}

export async function ensureSession(callId: string) {
  const existing = await prisma.coachSession.findUnique({ where: { callId } });
  if (existing) return existing;
  // Call.leadId is the dial-list row; the coach links to the CRM lead (pipeline) of the contact – newest open one.
  const call = await prisma.call.findUniqueOrThrow({ where: { id: callId }, select: { id: true, businessId: true, userId: true, contactId: true } });
  const crmLead = call.contactId ? await prisma.lead.findFirst({ where: { contactId: call.contactId, status: { in: ["new", "contacted", "qualified"] } }, orderBy: { createdAt: "desc" }, select: { id: true } }) : null;
  return prisma.coachSession.upsert({ where: { callId }, update: {}, create: { businessId: call.businessId, callId, userId: call.userId, contactId: call.contactId, leadId: crmLead?.id ?? null, provider: providerStatus().llm } });
}

export interface SegmentInput { speaker: CoachSpeaker; text: string; startMs?: number | null; endMs?: number | null; source: CoachSegmentSource }

/** Layer 1: persist transcript segments and, when the customer just spoke, run the analysis. */
export async function addSegments(callId: string, input: SegmentInput[], opts: { sttSeconds?: number; usage?: Usage } = {}) {
  const session = await ensureSession(callId);
  const clean = input.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text.length > 0);
  if (clean.length === 0 && !opts.sttSeconds) return { session, created: 0, analyzed: false };
  const created = clean.length
    ? await prisma.coachSegment.createManyAndReturn({ data: clean.map((s) => ({ businessId: session.businessId, sessionId: session.id, callId, speaker: s.speaker, text: s.text, startMs: s.startMs ?? null, endMs: s.endMs ?? null, source: s.source })) })
    : [];
  await prisma.coachSession.update({ where: { id: session.id }, data: {
    segmentsCount: { increment: created.length }, lastSegmentAt: created.length ? new Date() : undefined,
    sttSeconds: opts.sttSeconds ? { increment: opts.sttSeconds } : undefined,
    costUsd: opts.usage ? { increment: usageCostUsd(opts.usage) } : undefined,
    status: session.status === "ended" ? "ended" : "listening",
  } });
  const trigger = [...created].reverse().find((s) => s.speaker !== "agent");
  let analyzed = false;
  if (trigger) { analyzed = await analyze(session.id, trigger.id); }
  return { session, created: created.length, analyzed };
}

async function loadContext(sessionId: string) {
  const session = await prisma.coachSession.findUniqueOrThrow({ where: { id: sessionId } });
  const [segments, knowledge, contact, lead, calls, messages] = await Promise.all([
    prisma.coachSegment.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } }),
    prisma.coachKnowledge.findUnique({ where: { businessId: session.businessId } }),
    session.contactId ? prisma.contact.findUnique({ where: { id: session.contactId }, select: { fullName: true, notes: true } }) : null,
    session.leadId ? prisma.lead.findUnique({ where: { id: session.leadId }, select: { title: true, status: true, notes: true } }) : null,
    session.contactId ? prisma.call.findMany({ where: { contactId: session.contactId, outcomeSavedAt: { not: null }, id: { not: session.callId } }, orderBy: { createdAt: "desc" }, take: 3, select: { outcome: true, outcomeNote: true } }) : [],
    session.contactId ? prisma.message.findMany({ where: { conversation: { contactId: session.contactId }, body: { not: null } }, orderBy: { createdAt: "desc" }, take: 5, select: { direction: true, body: true } }) : [],
  ]);
  return { session, segments, knowledge: knowledgeView(knowledge), contact, lead, calls, messages: messages.reverse() };
}

/** Layers 2–4 for one trigger segment. Returns true when a recommendation was produced. */
export async function analyze(sessionId: string, triggerSegmentId: string): Promise<boolean> {
  const t0 = Date.now();
  await prisma.coachSession.update({ where: { id: sessionId }, data: { status: "analyzing" } });
  try {
    const ctx = await loadContext(sessionId);
    const trigger = ctx.segments.find((s) => s.id === triggerSegmentId);
    if (!trigger) return false;
    const recent = ctx.segments.slice(-RECENT_LINES);
    const promisesSoFar = (Array.isArray(ctx.session.promises) ? ctx.session.promises : []) as string[];
    const { examples, usage: embUsage } = await retrieveExamples(ctx.session.businessId, trigger.text, 3);
    const knowledge: KnowledgeView = { ...ctx.knowledge, objections: matchKnowledgeObjections(ctx.knowledge, trigger.text, 3).length ? matchKnowledgeObjections(ctx.knowledge, trigger.text, 3) : ctx.knowledge.objections.slice(0, 5) };
    const llm = await llmComplete(systemPrompt(knowledge), userPrompt({
      summary: ctx.session.summary,
      recentTranscript: recent.map((s) => ({ speaker: s.speaker, text: s.text })),
      lastCustomerUtterance: trigger.text,
      lead: { name: ctx.contact?.fullName ?? "לקוח", leadTitle: ctx.lead?.title, leadStatus: ctx.lead?.status, notes: [ctx.lead?.notes, ctx.contact?.notes].filter(Boolean).join(" | ") || null, lastOutcomes: ctx.calls.map((c) => `${c.outcome ?? ""}${c.outcomeNote ? ` (${c.outcomeNote.slice(0, 80)})` : ""}`).filter(Boolean), promisesSoFar },
      whatsapp: ctx.messages.map((m) => ({ direction: m.direction === "INBOUND" ? "customer" : "agent", text: m.body ?? "" })),
      knowledge, examples,
    }));
    const parsed = parseRecommendation(llm.text);
    const usage: Usage = { inputTokens: llm.usage.inputTokens + embUsage.inputTokens, outputTokens: llm.usage.outputTokens, embeddingTokens: embUsage.embeddingTokens };
    const latencyMs = Date.now() - new Date(trigger.createdAt).getTime();
    const sessionData: Prisma.CoachSessionUpdateInput = {
      tokensIn: { increment: usage.inputTokens }, tokensOut: { increment: usage.outputTokens }, costUsd: { increment: usageCostUsd(usage) },
      status: "ready",
    };
    if (parsed) {
      sessionData.stage = parsed.stage ?? undefined;
      sessionData.customerGoal = parsed.customer_goal ?? undefined;
      if (parsed.objection) sessionData.lastObjection = parsed.objection;
      const merged = [...new Set([...promisesSoFar, ...parsed.promises])].slice(0, 20);
      sessionData.promises = merged as unknown as Prisma.InputJsonValue;
    }
    // Rolling summary: fold the transcript in every SUMMARY_EVERY segments (short, cheap) – never resend everything.
    if (ctx.segments.length % SUMMARY_EVERY === 0) {
      sessionData.summary = [ctx.session.summary, ...ctx.segments.slice(-SUMMARY_EVERY).map((s) => `${s.speaker}: ${s.text.slice(0, 120)}`)].filter(Boolean).join("\n").slice(-2400);
    }
    await prisma.coachSession.update({ where: { id: sessionId }, data: sessionData });
    if (!parsed || !parsed.say_now || parsed.needs_more_context) {
      // Not confident: ask the agent instead of asserting (only when the model gave a usable objection label).
      if (parsed?.objection && parsed.confidence < 0.5) {
        await createRecommendation(ctx.session, { objection: parsed.objection, sayNow: `האם הלקוח מתכוון ל"${parsed.objection}"? אם כן – שאל מה חשוב לו לפני שמגיבים.`, why: "הזיהוי לא ודאי – שאלה לנציג במקום קביעה", confidence: parsed.confidence, stage: parsed.stage, basis: "question", sources: { exampleIds: [], knowledge: [] }, triggerSegmentId, latencyMs });
        return true;
      }
      return false;
    }
    // Dedupe: same objection as the current (not superseded) recommendation → keep the old one.
    const current = await prisma.coachRecommendation.findFirst({ where: { sessionId, supersededAt: null }, orderBy: { createdAt: "desc" } });
    if (current && parsed.objection && current.objection && keywordScore(current.objection, parsed.objection) >= 0.6 && keywordScore(current.sayNow, parsed.say_now) >= 0.5) return false;
    const basis = examples.length ? "examples" : "knowledge_only";
    await createRecommendation(ctx.session, { objection: parsed.objection, sayNow: parsed.say_now, why: parsed.why, confidence: parsed.confidence, stage: parsed.stage, basis, sources: { exampleIds: examples.map((e) => e.id), exampleCalls: examples.map((e) => e.callId).filter(Boolean), knowledge: knowledge.objections.map((o) => o.objection).slice(0, 3), model: llm.model, llmLatencyMs: llm.latencyMs }, triggerSegmentId, latencyMs });
    return true;
  } catch (err) {
    await prisma.coachSession.update({ where: { id: sessionId }, data: { status: "unavailable" } }).catch(() => undefined);
    console.warn("[coach] analysis failed", (err as Error).message.slice(0, 200));
    return false;
  }
}

async function createRecommendation(session: { id: string; businessId: string; callId: string }, r: { objection: string | null; sayNow: string; why: string; confidence: number; stage: string | null; basis: string; sources: Record<string, unknown>; triggerSegmentId: string; latencyMs: number }) {
  await prisma.$transaction(async (tx) => {
    // The conversation moved on: the previous recommendation is superseded, not deleted (kept for review).
    await tx.coachRecommendation.updateMany({ where: { sessionId: session.id, supersededAt: null }, data: { supersededAt: new Date() } });
    await tx.coachRecommendation.create({ data: { businessId: session.businessId, sessionId: session.id, callId: session.callId, objection: r.objection, sayNow: r.sayNow, why: r.why, confidence: r.confidence, stage: r.stage, basis: r.basis, sources: r.sources as Prisma.InputJsonValue, triggerSegmentId: r.triggerSegmentId, latencyMs: r.latencyMs } });
    await tx.coachSession.update({ where: { id: session.id }, data: { latencyMsTotal: { increment: r.latencyMs }, latencySamples: { increment: 1 } } });
  });
}

/** What the agent's card shows. */
export async function sessionState(callId: string) {
  const session = await prisma.coachSession.findUnique({ where: { callId }, include: { recommendations: { where: { supersededAt: null }, orderBy: { createdAt: "desc" }, take: 1 } } });
  if (!session) return null;
  const rec = session.recommendations[0] ?? null;
  if (rec && !rec.shownAt) await prisma.coachRecommendation.update({ where: { id: rec.id }, data: { shownAt: new Date() } });
  return {
    id: session.id, status: session.status, stage: session.stage, customerGoal: session.customerGoal, lastObjection: session.lastObjection, promises: session.promises, segmentsCount: session.segmentsCount,
    recommendation: rec && !rec.feedback ? { id: rec.id, objection: rec.objection, sayNow: rec.sayNow, why: rec.why, confidence: rec.confidence, basis: rec.basis, sources: rec.sources, latencyMs: rec.latencyMs, createdAt: rec.createdAt } : null,
    usage: { costUsd: Number(session.costUsd), sttSeconds: session.sttSeconds, tokensIn: session.tokensIn, tokensOut: session.tokensOut, avgLatencyMs: session.latencySamples ? Math.round(session.latencyMsTotal / session.latencySamples) : null },
  };
}

export async function endSession(callId: string) {
  await prisma.coachSession.updateMany({ where: { callId }, data: { status: "ended" } });
}
