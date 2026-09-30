/**
 * External AI providers for the real-time sales coach – thin fetch adapters, no SDKs.
 *
 *   LLM        Anthropic Messages API   ANTHROPIC_API_KEY   (COACH_LLM_MODEL, default claude-haiku-4-5-20251001 for latency)
 *   STT        OpenAI audio API         OPENAI_API_KEY      (COACH_STT_MODEL, default whisper-1)
 *   Embeddings OpenAI embeddings        OPENAI_API_KEY      (text-embedding-3-small); keyword fallback when missing
 *
 * COACH_PROVIDER=mock swaps all three for deterministic local implementations. It exists for automated tests and
 * is never a substitute for a real provider: the UI labels mock output as "הדמיה" and it is refused in production
 * unless COACH_ALLOW_MOCK_IN_PRODUCTION=1.
 *
 * Every call returns usage so cost can be metered per business and call (see PRICING – list prices, editable via env).
 */

export type Usage = { inputTokens: number; outputTokens: number; sttSeconds?: number; embeddingTokens?: number };

/** USD list prices (estimates – override with COACH_PRICE_* env vars when your contract differs). */
export const PRICING = {
  llmInPerMTok: Number(process.env.COACH_PRICE_LLM_IN ?? 1),      // Haiku 4.5
  llmOutPerMTok: Number(process.env.COACH_PRICE_LLM_OUT ?? 5),
  sttPerMinute: Number(process.env.COACH_PRICE_STT_MIN ?? 0.006), // whisper-1
  embeddingPerMTok: Number(process.env.COACH_PRICE_EMB ?? 0.02),
};

export function usageCostUsd(u: Usage): number {
  return u.inputTokens / 1e6 * PRICING.llmInPerMTok + u.outputTokens / 1e6 * PRICING.llmOutPerMTok + (u.sttSeconds ?? 0) / 60 * PRICING.sttPerMinute + (u.embeddingTokens ?? 0) / 1e6 * PRICING.embeddingPerMTok;
}

export type ProviderStatus = { llm: "anthropic" | "mock" | "missing"; stt: "openai" | "mock" | "missing"; embeddings: "openai" | "mock" | "keyword"; mock: boolean };

export function providerStatus(): ProviderStatus {
  const mock = process.env.COACH_PROVIDER === "mock" && (process.env.NODE_ENV !== "production" || process.env.COACH_ALLOW_MOCK_IN_PRODUCTION === "1");
  if (mock) return { llm: "mock", stt: "mock", embeddings: "mock", mock: true };
  return {
    llm: process.env.ANTHROPIC_API_KEY ? "anthropic" : "missing",
    stt: process.env.OPENAI_API_KEY ? "openai" : "missing",
    embeddings: process.env.OPENAI_API_KEY ? "openai" : "keyword",
    mock: false,
  };
}

export class CoachProviderError extends Error {
  constructor(message: string, public readonly kind: "missing" | "http" | "parse" = "http") { super(message); }
}

// ───────────────────────── LLM ─────────────────────────

export interface LlmResult { text: string; usage: Usage; model: string; latencyMs: number }

/** Structured-output call: the caller passes a system prompt and ONE user message (data + task), expects JSON text back. */
export async function llmComplete(system: string, user: string, opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<LlmResult> {
  const status = providerStatus();
  const t0 = Date.now();
  if (status.mock) return { ...mockLlm(system, user), latencyMs: Date.now() - t0 };
  if (status.llm === "missing") throw new CoachProviderError("ANTHROPIC_API_KEY חסר – המאמן לא יכול לייצר המלצות", "missing");
  const model = process.env.COACH_LLM_MODEL ?? "claude-haiku-4-5-20251001";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 400, temperature: opts.temperature ?? 0.2, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new CoachProviderError(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number } };
  const text = data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  return { text, usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }, model, latencyMs: Date.now() - t0 };
}

// ───────────────────────── STT ─────────────────────────

export interface SttResult { text: string; usage: Usage; model: string }

export async function transcribeAudio(audio: Blob | Buffer, opts: { mimeType: string; durationSeconds: number; language?: string; fileName?: string }): Promise<SttResult> {
  const status = providerStatus();
  if (status.mock) return { text: "", usage: { inputTokens: 0, outputTokens: 0, sttSeconds: opts.durationSeconds }, model: "mock" };
  if (status.stt === "missing") throw new CoachProviderError("OPENAI_API_KEY חסר – אין תמלול חי", "missing");
  const model = process.env.COACH_STT_MODEL ?? "whisper-1";
  const form = new FormData();
  const blob = audio instanceof Blob ? audio : new Blob([new Uint8Array(audio)], { type: opts.mimeType });
  form.append("file", blob, opts.fileName ?? `chunk.${opts.mimeType.includes("webm") ? "webm" : opts.mimeType.includes("wav") ? "wav" : "mp3"}`);
  form.append("model", model);
  form.append("language", opts.language ?? "he");
  form.append("response_format", "json");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new CoachProviderError(`OpenAI STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { text: string };
  return { text: (data.text ?? "").trim(), usage: { inputTokens: 0, outputTokens: 0, sttSeconds: opts.durationSeconds }, model };
}

export interface TimedSegment { startMs: number; endMs: number; text: string }
/**
 * A whole recording → text with segment timestamps (verbose_json). Whisper accepts files up to 25 MB.
 * Mock mode (tests only): the transcript is read from a "#TRANSCRIPT" block inside the file ("12.5|text" per line);
 * a file without it has no speech – exactly what an empty real transcription looks like.
 */
export async function transcribeTimed(audio: Buffer, opts: { mimeType: string; fileName: string; language?: string }): Promise<{ segments: TimedSegment[]; text: string; durationSec: number; usage: Usage; model: string }> {
  const status = providerStatus();
  if (status.mock) {
    const raw = audio.toString("utf8"); const i = raw.indexOf("#TRANSCRIPT\n");
    const segments = i < 0 ? [] : raw.slice(i + 12).split("\n").map((l) => l.trim()).filter(Boolean).map((l, k, all) => { const [sec, ...rest] = l.split("|"); const start = Math.round(Number(sec) * 1000) || k * 5000; const next = all[k + 1] ? Math.round(Number(all[k + 1].split("|")[0]) * 1000) : start + 5000; return { startMs: start, endMs: next, text: rest.join("|").trim() }; });
    const durationSec = Math.ceil((segments.at(-1)?.endMs ?? 0) / 1000);
    return { segments, text: segments.map((x) => x.text).join("\n"), durationSec, usage: { inputTokens: 0, outputTokens: 0, sttSeconds: durationSec }, model: "mock" };
  }
  if (status.stt === "missing") throw new CoachProviderError("OPENAI_API_KEY חסר – אין תמלול", "missing");
  const model = process.env.COACH_STT_MODEL ?? "whisper-1";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: opts.mimeType }), opts.fileName);
  form.append("model", model);
  form.append("language", opts.language ?? "he");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(240_000) });
  if (!res.ok) throw new CoachProviderError(`OpenAI STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { text?: string; duration?: number; segments?: Array<{ start: number; end: number; text: string }> };
  const segments = (data.segments ?? []).map((x) => ({ startMs: Math.round(x.start * 1000), endMs: Math.round(x.end * 1000), text: x.text.trim() })).filter((x) => x.text);
  const durationSec = Math.ceil(data.duration ?? (segments.at(-1)?.endMs ?? 0) / 1000);
  return { segments, text: (data.text ?? "").trim(), durationSec, usage: { inputTokens: 0, outputTokens: 0, sttSeconds: durationSec }, model };
}

// ───────────────────────── Embeddings ─────────────────────────

export async function embed(texts: string[]): Promise<{ vectors: number[][] | null; usage: Usage }> {
  const status = providerStatus();
  if (status.mock) return { vectors: texts.map(mockEmbedding), usage: { inputTokens: 0, outputTokens: 0 } };
  if (status.embeddings !== "openai") return { vectors: null, usage: { inputTokens: 0, outputTokens: 0 } };
  const res = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: "text-embedding-3-small", input: texts }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new CoachProviderError(`OpenAI embeddings ${res.status}`);
  const data = await res.json() as { data: Array<{ embedding: number[] }>; usage: { total_tokens: number } };
  return { vectors: data.data.map((d) => d.embedding), usage: { inputTokens: 0, outputTokens: 0, embeddingTokens: data.usage.total_tokens } };
}

// ───────────────────────── Mock (tests only) ─────────────────────────

/** Hashed bag-of-words vector – stable, tenant-neutral, good enough for similarity tests. */
export function mockEmbedding(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  for (const w of tokenize(text)) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 64] += 1; }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2);
}

/**
 * Deterministic stand-in for the LLM: parses the structured task from the user message and answers from the
 * data it was given (last customer utterance + approved knowledge). Never used for real customers.
 */
function mockLlm(system: string, user: string): Omit<LlmResult, "latencyMs"> {
  const usage = { inputTokens: Math.ceil((system.length + user.length) / 4), outputTokens: 120 };
  const grab = (tag: string) => { const m = user.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ""; };
  if (user.includes("TASK: sales_insights")) return { text: JSON.stringify(mockSalesInsights(grab("transcript"))), usage, model: "mock" };
  if (user.includes("TASK: extract_learning")) {
    const transcript = grab("transcript");
    const lines = transcript.split("\n").filter(Boolean);
    const items: Array<Record<string, unknown>> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^customer:/i.test(line) && /יקר|מחיר|לחשוב|לא בטוח|זמן|תחרות|אין לי/.test(line)) {
        const reply = lines.slice(i + 1).find((l) => /^agent:/i.test(l)) ?? "";
        items.push({ objection: line.replace(/^customer:\s*/i, "").slice(0, 160), agent_response: reply.replace(/^agent:\s*/i, "").slice(0, 300), stage: "objection", quote: `${line}\n${reply}`.slice(0, 400), questions: [] });
      }
    }
    return { text: JSON.stringify({ examples: items, questions_asked: lines.filter((l) => /^agent:.*\?/.test(l)).map((l) => l.replace(/^agent:\s*/i, "")).slice(0, 5), closing: lines.some((l) => /^agent:.*(נסגור|להתקדם|לסגור)/.test(l)) ? "asked_for_close" : "none" }), usage, model: "mock" };
  }
  if (user.includes("TASK: coach_chat")) {
    const q = grab("agent_question");
    const knowledge = grab("approved_knowledge");
    const examples = grab("retrieved_examples");
    const fromExamples = examples.match(/agent_response: (.+)/);
    const fromKnowledge = knowledge.match(/objection: .*\n\s*response: (.+)/);
    const price = /יקר|מחיר|עולה|תקציב/.test(q); const delay = /לחשוב|נחזור|לא עכשיו|אין לי זמן|תחזור/.test(q);
    const fromInsights = grab("sales_insights").match(/body: (.+)/);
    const fact = grab("business_facts").match(/^\[(\d+)\][^\n]*\n([^\n]+)/m);
    const sayNow = fromInsights?.[1] ?? fromExamples?.[1] ?? fromKnowledge?.[1] ?? (price ? "מבין אותך לגמרי. לפני שנדבר על המחיר – מה הכי חשוב לך שזה ייתן לך?" : delay ? "ברור, קח את הזמן. רק כדי שאדע – מה הדבר שהיית רוצה לבדוק לפני שמחליטים?" : "שאלה טובה. מה בעצם הכי חשוב לך לפתור עכשיו?");
    const followUp = price ? "אם אחלק לך את זה לתשלומים, זה משנה את התמונה?" : delay ? "מה יעזור לך להחליט – שאשלח סיכום קצר בוואטסאפ?" : null;
    return { text: JSON.stringify({ facts: fact ? [{ text: fact[2].slice(0, 160), source: Number(fact[1]) }, { text: "עובדה בלי מקור", source: 99 }] : [], say_now: sayNow.slice(0, 220), follow_up: followUp, why: fromInsights ? "מבוסס על ידע מכירתי מאושר של העסק" : fromExamples ? "מבוסס על דוגמה שנבדקה מהעסק" : fromKnowledge ? "מבוסס על הידע העסקי המאושר" : "ניסוח כללי – אין ידע או דוגמאות דומות בעסק", confidence: fromExamples || fromKnowledge ? 0.8 : 0.5 }), usage, model: "mock" };
  }
  const last = grab("last_customer_utterance");
  const knowledge = grab("approved_knowledge");
  const examples = grab("retrieved_examples");
  const objectionMatch = /יקר|מחיר|עולה|תקציב/.test(last) ? "מחיר" : /לחשוב|נחזור|לא עכשיו|אין לי זמן/.test(last) ? "דחייה" : /תחרות|אצל|מתחרה|הצעה אחרת/.test(last) ? "השוואה למתחרה" : /לא בטוח|לא יודע|מה זה נותן/.test(last) ? "ספק בערך" : null;
  if (!last) return { text: JSON.stringify({ objection: null, say_now: null, why: "", confidence: 0.2, stage: "opening", needs_more_context: true }), usage, model: "mock" };
  const fromExamples = examples.match(/agent_response: (.+)/);
  const fromKnowledge = knowledge.match(/objection: .*\n\s*response: (.+)/);
  const sayNow = objectionMatch === "מחיר"
    ? (fromExamples?.[1] ?? fromKnowledge?.[1] ?? "מבין אותך. כדי שאוכל להגיד לך אם זה בכלל מתאים, מה הכי חשוב לך לקבל מהמוצר?")
    : objectionMatch ? (fromExamples?.[1] ?? fromKnowledge?.[1] ?? "בסדר גמור. מה היה צריך לקרות כדי שזה יהיה נכון עבורך עכשיו?")
    : "שאלה טובה. מה הכי חשוב לך לבדוק לפני שמחליטים?";
  return { text: JSON.stringify({ objection: objectionMatch, say_now: sayNow.slice(0, 220), why: fromExamples ? "מבוסס על דוגמה שנבדקה מהעסק" : fromKnowledge ? "מבוסס על הידע העסקי המאושר" : "המלצת AI כללית ללא דוגמאות מספיקות", confidence: objectionMatch ? (fromExamples ? 0.8 : 0.6) : 0.4, stage: objectionMatch ? "objection" : "discovery", needs_more_context: !objectionMatch && last.length < 12 }), usage, model: "mock" };
}

/** Mock extraction (tests only): lines are "[mm:ss] speaker: text"; keywords decide the kind. */
function mockSalesInsights(transcript: string) {
  const lines = transcript.split("\n").filter(Boolean).map((l) => { const m = l.match(/^\[(\d+):(\d+)\]\s*([^:]+):\s*(.*)$/); return m ? { ms: (Number(m[1]) * 60 + Number(m[2])) * 1000, who: m[3].trim(), text: m[4] } : null; }).filter((x): x is { ms: number; who: string; text: string } => Boolean(x));
  const out: Array<Record<string, unknown>> = [];
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    if (i === 0 && l.who !== "customer") out.push({ kind: "opening", title: "פתיחה", body: l.text, quote: l.text, start_ms: l.ms, flags: [] });
    if (l.who === "agent" && /\?/.test(l.text) && i > 0) out.push({ kind: "discovery", title: "שאלת בירור", body: l.text, quote: l.text, start_ms: l.ms, flags: [] });
    if (l.who === "customer" && /(יקר|לא בטוח|אחשוב|אין לי זמן)/.test(l.text) && next) out.push({ kind: "objection", title: "התנגדות", objection: l.text, body: next.text, quote: `${l.text}\n${next.text}`, start_ms: l.ms, flags: /(הנחה|%|חינם)/.test(next.text) ? ["discount"] : /(מבטיח|מובטח|אחריות לכל החיים)/.test(next.text) ? ["promise"] : [] });
    if (l.who === "agent" && /(נסגור|נתקדם|לסגור)/.test(l.text)) out.push({ kind: "closing", title: "שלב סגירה", body: l.text, quote: l.text, start_ms: l.ms, flags: [] });
  });
  out.push({ kind: "improvement", title: "נקודה לשיפור", body: "לשאול שאלת בירור נוספת לפני הצגת המחיר", quote: "", start_ms: null, flags: [] });
  return { insights: out };
}
