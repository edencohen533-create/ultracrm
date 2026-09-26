/**
 * Layer 3 – knowledge retrieval. Finds the sales examples (reviewed moments from this business's own calls) and
 * the approved-knowledge objections that best match the customer's current utterance.
 * Embeddings when OpenAI is configured, otherwise a keyword overlap score. Everything is scoped to the
 * business of the current tenant context (prisma is the scoped client; RLS enforces it at the database too).
 */
import { prisma } from "@/lib/db";
import { embed, tokenize, type Usage } from "./providers";
import type { KnowledgeView } from "./prompt";

export interface RetrievedExample { id: string; objection: string; agentResponse: string; outcome: string; stage: string | null; score: number; callId: string | null }

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Jaccard over word tokens (Hebrew-friendly, no stemming) – the fallback when no embedding provider exists. */
export function keywordScore(a: string, b: string): number {
  const ta = new Set(tokenize(a)), tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0; for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Top-k approved examples for the utterance. Only approved examples are ever fed to the model. */
export async function retrieveExamples(businessId: string, utterance: string, k = 3): Promise<{ examples: RetrievedExample[]; usage: Usage; method: "embedding" | "keyword" }> {
  const rows = await prisma.coachExample.findMany({ where: { businessId, status: "approved" }, select: { id: true, objection: true, agentResponse: true, editedResponse: true, outcome: true, stage: true, embedding: true, callId: true }, take: 500, orderBy: { createdAt: "desc" } });
  if (rows.length === 0) return { examples: [], usage: { inputTokens: 0, outputTokens: 0 }, method: "keyword" };
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let method: "embedding" | "keyword" = "keyword";
  let scored: Array<RetrievedExample>;
  const withVectors = rows.filter((r) => Array.isArray(r.embedding));
  const q = withVectors.length ? await embed([utterance]).catch(() => ({ vectors: null, usage: { inputTokens: 0, outputTokens: 0 } })) : { vectors: null, usage: { inputTokens: 0, outputTokens: 0 } };
  if (q.vectors) {
    usage = q.usage; method = "embedding";
    scored = rows.map((r) => ({ id: r.id, objection: r.objection, agentResponse: r.editedResponse ?? r.agentResponse, outcome: r.outcome, stage: r.stage, callId: r.callId, score: Array.isArray(r.embedding) ? cosine(q.vectors![0], r.embedding as number[]) : keywordScore(utterance, r.objection) }));
  } else {
    scored = rows.map((r) => ({ id: r.id, objection: r.objection, agentResponse: r.editedResponse ?? r.agentResponse, outcome: r.outcome, stage: r.stage, callId: r.callId, score: keywordScore(utterance, r.objection) }));
  }
  const threshold = method === "embedding" ? 0.35 : 0.15;
  // Prefer examples from won deals on ties, but never hide lost ones – the model sees the outcome label.
  const examples = scored.filter((e) => e.score >= threshold).sort((a, b) => b.score - a.score || (a.outcome === "won" ? -1 : 1)).slice(0, k);
  return { examples, usage, method };
}

/** Knowledge objections most similar to the utterance (keyword) – passed as a compact subset to keep prompts short. */
export function matchKnowledgeObjections(k: KnowledgeView, utterance: string, max = 3) {
  return k.objections.map((o) => ({ ...o, score: keywordScore(utterance, o.objection) })).filter((o) => o.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
}
