/**
 * Learning from finished calls and deal outcomes.
 *
 *   call.ended  → transcript (live segments, or the saved recording transcribed when the business allows it)
 *              → LLM extraction of objection/response moments with verbatim quotes → CoachExample rows (pending review)
 *   deal.won / deal.lost → examples of the deal's calls get the outcome label (won/lost); nothing is ranked as a
 *              "winning line" – reviewers see the outcome next to the quote and decide what to approve.
 */
import { prisma } from "@/lib/db";
import { getBusinessSettings } from "@/lib/settings";
import type { Prisma } from "@/generated/prisma/client";
import { embed, llmComplete, providerStatus, transcribeAudio, usageCostUsd } from "./providers";
import { learningSystemPrompt, learningUserPrompt } from "./prompt";
import { ensureSession, endSession } from "./session";

interface ExtractedJson { examples?: Array<{ objection?: string; agent_response?: string; stage?: string; quote?: string; questions?: string[] }>; questions_asked?: string[]; closing?: string }

/** Outcome for a call: the deal linked to the call's lead (or any deal of the contact closed after the call). */
async function outcomeForCall(call: { contactId: string | null; createdAt: Date }, crmLeadId: string | null): Promise<{ outcome: "won" | "lost" | "unknown"; dealId: string | null }> {
  if (!call.contactId) return { outcome: "unknown", dealId: null };
  const deal = await prisma.deal.findFirst({
    where: { status: { in: ["won", "lost"] }, OR: [...(crmLeadId ? [{ leadId: crmLeadId }] : []), { contactId: call.contactId, closedAt: { gte: call.createdAt } }] },
    orderBy: { closedAt: "desc" }, select: { id: true, status: true },
  });
  return deal ? { outcome: deal.status === "won" ? "won" : "lost", dealId: deal.id } : { outcome: "unknown", dealId: null };
}

/** Transcribe a saved recording into segments (speaker unknown – single channel) when allowed and possible. */
async function transcriptFromRecording(callId: string, businessId: string) {
  const settings = await getBusinessSettings(businessId);
  if (!settings.coach.learnFromRecordings || providerStatus().stt === "missing") return 0;
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { recordingStatus: true, recordingId: true, talkSeconds: true } });
  if (!call || call.recordingStatus !== "saved" || !call.recordingId) return 0;
  const { getTelephony } = await import("@/lib/telephony");
  const src = await getTelephony().getRecordingDownloadUrl(call.recordingId);
  if (!src) return 0;
  const res = await fetch(src.url);
  if (!res.ok) return 0;
  const buf = Buffer.from(await res.arrayBuffer());
  const stt = await transcribeAudio(buf, { mimeType: src.contentType, durationSeconds: call.talkSeconds ?? 0, fileName: `call-${callId}.${src.contentType.includes("wav") ? "wav" : "mp3"}` });
  if (!stt.text) return 0;
  const session = await ensureSession(callId);
  await prisma.coachSegment.create({ data: { businessId, sessionId: session.id, callId, speaker: "unknown", text: stt.text, source: "recording" } });
  await prisma.coachSession.update({ where: { id: session.id }, data: { segmentsCount: { increment: 1 }, sttSeconds: { increment: stt.usage.sttSeconds ?? 0 }, costUsd: { increment: usageCostUsd(stt.usage) } } });
  return 1;
}

/** Runs after call.ended (idempotent per call). */
export async function learnFromCall(callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true, businessId: true, userId: true, contactId: true, createdAt: true, answeredAt: true } });
  if (!call || !call.answeredAt) return { skipped: "not answered" };
  const settings = await getBusinessSettings(call.businessId);
  if (!settings.coach.enabled) return { skipped: "coach disabled" };
  if (providerStatus().llm === "missing") return { skipped: "no llm" };
  await endSession(callId);
  let segments = await prisma.coachSegment.findMany({ where: { callId }, orderBy: { createdAt: "asc" } });
  if (segments.length === 0) { await transcriptFromRecording(callId, call.businessId); segments = await prisma.coachSegment.findMany({ where: { callId }, orderBy: { createdAt: "asc" } }); }
  if (segments.length === 0) return { skipped: "no transcript" };
  if (await prisma.coachExample.count({ where: { callId } })) return { skipped: "already extracted" };
  const session = await ensureSession(callId);
  const llm = await llmComplete(learningSystemPrompt(), learningUserPrompt(segments.map((s) => ({ speaker: s.speaker, text: s.text }))), { maxTokens: 1200 });
  const m = llm.text.match(/\{[\s\S]*\}/);
  const parsed: ExtractedJson = m ? (JSON.parse(m[0]) as ExtractedJson) : {};
  const { outcome, dealId } = await outcomeForCall(call, session.leadId);
  const items = (parsed.examples ?? []).filter((e) => e.objection && e.agent_response).slice(0, 12);
  const vectors = items.length ? (await embed(items.map((e) => e.objection!)).catch(() => ({ vectors: null, usage: { inputTokens: 0, outputTokens: 0 } }))) : { vectors: null, usage: { inputTokens: 0, outputTokens: 0 } };
  const created = await prisma.coachExample.createManyAndReturn({ data: items.map((e, i) => ({
    businessId: call.businessId, callId, sessionId: session.id, dealId, leadId: session.leadId, userId: call.userId,
    objection: e.objection!.slice(0, 300), agentResponse: e.agent_response!.slice(0, 600), stage: e.stage?.slice(0, 40) ?? null, outcome,
    quote: (e.quote ?? "").slice(0, 800), questions: (e.questions ?? []).slice(0, 8) as unknown as Prisma.InputJsonValue,
    segmentIds: segments.filter((s) => (e.quote ?? "").includes(s.text.slice(0, 40))).map((s) => s.id) as unknown as Prisma.InputJsonValue,
    embedding: vectors.vectors ? (vectors.vectors[i] as unknown as Prisma.InputJsonValue) : undefined,
  })) });
  await prisma.coachSession.update({ where: { id: session.id }, data: { tokensIn: { increment: llm.usage.inputTokens }, tokensOut: { increment: llm.usage.outputTokens }, costUsd: { increment: usageCostUsd(llm.usage) + usageCostUsd(vectors.usage) } } });
  return { examples: created.length, outcome, closing: parsed.closing ?? null };
}

/** Runs after deal.won / deal.lost: label every example of the deal's calls (call → lead → deal, or contact after call). */
export async function attachDealOutcome(dealId: string, outcome: "won" | "lost") {
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true, contactId: true, leadId: true, createdAt: true } });
  if (!deal) return { updated: 0 };
  // Every answered call with this contact before the deal closed (Call.leadId is a dial-list row, not the CRM lead).
  const calls = await prisma.call.findMany({ where: { contactId: deal.contactId, answeredAt: { not: null } }, select: { id: true } });
  const r = await prisma.coachExample.updateMany({ where: { callId: { in: calls.map((c) => c.id) }, OR: [{ dealId: null }, { dealId }] }, data: { outcome, dealId } });
  return { updated: r.count };
}
