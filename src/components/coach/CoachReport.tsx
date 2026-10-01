"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Panel, Spinner, Stat } from "@/components/ui";
import { formatDateTime, formatDuration } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";

type Metrics = { days: number; providers: { llm: string; stt: string; mock: boolean }; pricing: Record<string, number>; sessions: number; recommendationsShown: number; feedback: Record<string, number>; topObjections: Array<{ objection: string; count: number }>; avgLatencyMs: number | null; usage: { sttSeconds: number; tokensIn: number; tokensOut: number; costUsd: number; coachedTalkSeconds: number; costPerTalkHourUsd: number | null }; examples: Array<{ status: string; outcome: string; count: number }>; dealOutcomesOfCoachedLeads: Record<string, number>; note: string };
type SessionRow = { id: string; callId: string; status: string; createdAt: string; stage: string | null; lastObjection: string | null; segmentsCount: number; call: { at: string; answered: boolean; talkSeconds: number | null; outcome: string | null; agent: { fullName: string }; contact: { id: string; fullName: string } | null }; recommendations: number; helpful: number; notHelpful: number; costUsd: number; avgLatencyMs: number | null };
type Detail = { session: { segments: Array<{ id: string; speaker: string; text: string; source: string; createdAt: string }>; recommendations: Array<{ id: string; objection: string | null; sayNow: string; why: string; basis: string; confidence: number; sources: { exampleIds?: string[]; knowledge?: string[]; model?: string }; latencyMs: number | null; shownAt: string | null; feedback: string | null; supersededAt: string | null; createdAt: string }>; call: { user: { fullName: string }; contact: { fullName: string } | null; outcome: string | null } }; examples: Array<{ id: string; objection: string; agentResponse: string; outcome: string; status: string }>; sourceExamples: Array<{ id: string; objection: string; agentResponse: string; editedResponse: string | null; outcome: string; callId: string | null }> };

/** Managers' view: measured usage, objections seen, feedback, coached calls with every recommendation and its sources. */
export function CoachReport() {
  const t = useT();
  const [days, setDays] = useState(30);
  const [m, setM] = useState<Metrics | null>(null);
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  useEffect(() => { api.get<Metrics>(`/api/coach/metrics?days=${days}`).then(setM).catch((e) => toast.error(e.message)); api.get<{ items: SessionRow[] }>("/api/coach/sessions").then((r) => setRows(r.items)).catch((e) => toast.error(e.message)); }, [days]);
  async function open(id: string) { try { setDetail(await api.get<Detail>(`/api/coach/sessions/${id}`)); } catch (e) { toast.error((e as Error).message); } }
  if (!m) return <div className="p-6"><Spinner /></div>;
  const fb = m.feedback;
  return (
    <div className="p-5 space-y-4" data-testid="coach-report">
      <div className="flex flex-wrap items-center gap-2 text-sm">{[7, 30, 90].map((d) => <Button key={d} size="sm" variant={days === d ? "primary" : "ghost"} onClick={() => setDays(d)}>{t(`${d} ימים`, `${d} days`)}</Button>)}{m.providers.mock && <Badge tone="warn">{t("ספק AI מדומה – נתוני בדיקה", "Mock AI provider – test data")}</Badge>}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <Stat label={t("שיחות עם מאמן פעיל", "Calls with coach active")} value={m.sessions} />
        <Stat label={t("המלצות שהוצגו", "Suggestions shown")} value={m.recommendationsShown} />
        <Stat label={t("סומנו מועיל", "Marked helpful")} value={fb.helpful ?? 0} sub={t(`לא מועיל ${fb.not_helpful ?? 0} · דולגו ${fb.skipped ?? 0} · הוסתרו ${fb.hidden ?? 0}`, `Not helpful ${fb.not_helpful ?? 0} · Skipped ${fb.skipped ?? 0} · Hidden ${fb.hidden ?? 0}`)} />
        <Stat label={t("השהיה ממוצעת", "Average latency")} value={m.avgLatencyMs != null ? t(`${(m.avgLatencyMs / 1000).toFixed(1)} שנ׳`, `${(m.avgLatencyMs / 1000).toFixed(1)}s`) : "—"} sub={t("מסיום משפט הלקוח עד ההמלצה", "From end of customer's sentence to suggestion")} />
        <Stat label={t("עלות נמדדת", "Measured cost")} value={`$${m.usage.costUsd.toFixed(3)}`} sub={m.usage.costPerTalkHourUsd != null ? t(`≈ $${m.usage.costPerTalkHourUsd.toFixed(3)} לשעת שיחה`, `≈ $${m.usage.costPerTalkHourUsd.toFixed(3)} per talk hour`) : t("אין זמן שיחה נמדד", "No measured talk time")} />
        <Stat label={t("דקות תמלול", "Transcription minutes")} value={Math.round(m.usage.sttSeconds / 60)} sub={t(`${m.usage.tokensIn + m.usage.tokensOut} טוקנים`, `${m.usage.tokensIn + m.usage.tokensOut} tokens`)} />
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        <Panel title={t("התנגדויות נפוצות", "Common objections")} bodyClassName="p-0">{m.topObjections.length === 0 ? <EmptyState title={t("אין עדיין", "None yet")} /> : <ul className="divide-y divide-line text-sm">{m.topObjections.map((o) => <li key={o.objection} className="px-4 py-2 flex justify-between"><span>{o.objection}</span><span className="tabular text-muted">{o.count}</span></li>)}</ul>}</Panel>
        <Panel title={t("דוגמאות למידה", "Learning examples")}><ul className="text-sm space-y-1">{m.examples.length === 0 ? <li className="text-muted text-xs">{t("אין דוגמאות עדיין", "No examples yet")}</li> : m.examples.map((e) => <li key={e.status + e.outcome} className="flex justify-between"><span>{e.status === "approved" ? t("מאושרות", "Approved") : e.status === "pending" ? t("ממתינות", "Pending") : t("נפסלו", "Rejected")} · {e.outcome === "won" ? t("עסקה נסגרה", "Deal closed") : e.outcome === "lost" ? t("לא נסגרה", "Not closed") : t("ללא תוצאה", "No outcome")}</span><span className="tabular">{e.count}</span></li>)}</ul></Panel>
        <Panel title={t("תוצאות עסקאות של לידים בשיחות מאומנות", "Deal outcomes of leads in coached calls")}><ul className="text-sm space-y-1">{Object.keys(m.dealOutcomesOfCoachedLeads).length === 0 ? <li className="text-muted text-xs">{t("אין עסקאות מקושרות", "No linked deals")}</li> : Object.entries(m.dealOutcomesOfCoachedLeads).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k === "won" ? t("נסגרו", "Won") : k === "lost" ? t("לא נסגרו", "Lost") : t("פתוחות", "Open")}</span><span className="tabular">{v}</span></li>)}</ul><p className="text-[11px] text-muted mt-2">{m.note}</p></Panel>
      </div>
      <Panel title={t("שיחות שבהן ניתנו המלצות", "Calls with suggestions")} bodyClassName="p-0">
        {!rows ? <div className="p-4"><Spinner /></div> : rows.length === 0 ? <EmptyState title={t("עדיין אין שיחות עם מאמן", "No coached calls yet")} /> : (
          <table className="w-full text-sm"><thead className="text-xs text-muted bg-white/3"><tr><th className="text-start px-3 h-9">{t("מועד", "Time")}</th><th className="text-start px-3">{t("נציג", "Agent")}</th><th className="text-start px-3">{t("לקוח", "Customer")}</th><th className="text-start px-3">{t("משך", "Duration")}</th><th className="text-start px-3">{t("התנגדות אחרונה", "Last objection")}</th><th className="text-start px-3">{t("המלצות", "Suggestions")}</th><th className="text-start px-3">{t("מועיל", "Helpful")}</th><th className="text-start px-3">{t("השהיה", "Latency")}</th><th className="text-start px-3">{t("עלות", "Cost")}</th><th className="text-start px-3">{t("תוצאה", "Outcome")}</th><th></th></tr></thead>
            <tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.id}><td className="px-3 h-10 tabular text-xs">{formatDateTime(r.call.at)}</td><td className="px-3">{r.call.agent.fullName}</td><td className="px-3">{r.call.contact?.fullName ?? "—"}</td><td className="px-3 tabular">{r.call.talkSeconds ? formatDuration(r.call.talkSeconds) : "—"}</td><td className="px-3 text-xs">{r.lastObjection ?? "—"}</td><td className="px-3 tabular">{r.recommendations}</td><td className="px-3 tabular">{r.helpful}</td><td className="px-3 tabular text-xs">{r.avgLatencyMs != null ? `${(r.avgLatencyMs / 1000).toFixed(1)}s` : "—"}</td><td className="px-3 tabular text-xs">${r.costUsd.toFixed(4)}</td><td className="px-3 text-xs">{r.call.outcome ?? "—"}</td><td className="px-3"><Button size="sm" variant="ghost" onClick={() => open(r.id)}>{t("פרטים", "Details")}</Button></td></tr>)}</tbody></table>
        )}
      </Panel>
      {detail && (
        <Panel title={t(`שיחה: ${detail.session.call.user.fullName} ↔ ${detail.session.call.contact?.fullName ?? "—"}`, `Call: ${detail.session.call.user.fullName} ↔ ${detail.session.call.contact?.fullName ?? "—"}`)} actions={<Button size="sm" variant="ghost" onClick={() => setDetail(null)}>{t("סגור", "Close")}</Button>}>
          <div className="grid lg:grid-cols-2 gap-4 text-sm">
            <div><p className="text-xs text-muted mb-1">{t("תמלול (מקור לכל מקטע)", "Transcript (source per segment)")}</p><ul className="space-y-1 max-h-96 overflow-auto">{detail.session.segments.map((s) => <li key={s.id} className="text-xs"><span className="text-muted">[{s.speaker === "customer" ? t("לקוח", "Customer") : s.speaker === "agent" ? t("נציג", "Agent") : "?"} · {s.source === "simulation" ? t("הדמיה", "Simulation") : s.source === "recording" ? t("הקלטה", "Recording") : t("תמלול חי", "Live transcription")}]</span> {s.text}</li>)}</ul></div>
            <div><p className="text-xs text-muted mb-1">{t("המלצות – מה הוצג, מתי, על סמך מה", "Suggestions – what was shown, when, and based on what")}</p><ul className="space-y-2 max-h-96 overflow-auto">{detail.session.recommendations.map((r) => <li key={r.id} className="rounded-md border border-line p-2 text-xs space-y-0.5"><p className="tabular text-muted">{formatDateTime(r.createdAt)} · {r.latencyMs != null ? t(`${(r.latencyMs / 1000).toFixed(1)} שנ׳`, `${(r.latencyMs / 1000).toFixed(1)}s`) : ""} · {r.feedback ? t(`פידבק: ${r.feedback}`, `Feedback: ${r.feedback}`) : r.shownAt ? t("הוצג", "Shown") : t("לא הוצג", "Not shown")}{r.supersededAt ? t(" · הוחלף", " · Superseded") : ""}</p>{r.objection && <p>{t("התנגדות:", "Objection:")} {r.objection}</p>}<p className="font-medium text-sm">{r.sayNow}</p><p className="text-muted">{r.why}</p><p className="text-muted">{t("בסיס:", "Basis:")} {r.basis === "examples" ? t(`דוגמאות ${(r.sources.exampleIds ?? []).length}`, `${(r.sources.exampleIds ?? []).length} examples`) : r.basis === "question" ? t("שאלה לנציג", "Question for the agent") : t("ידע עסקי בלבד", "Business knowledge only")} · {t("ביטחון", "Confidence")} {Math.round(r.confidence * 100)}% · {t("מודל", "Model")} {r.sources.model ?? "—"}</p></li>)}</ul>
              {detail.sourceExamples.length > 0 && <div className="mt-2"><p className="text-xs text-muted">{t("דוגמאות ששימשו:", "Examples used:")}</p><ul className="text-xs space-y-1">{detail.sourceExamples.map((e) => <li key={e.id}><Badge tone={e.outcome === "won" ? "good" : e.outcome === "lost" ? "bad" : "neutral"}>{e.outcome}</Badge> {e.objection} → {e.editedResponse ?? e.agentResponse}</li>)}</ul></div>}
              {detail.examples.length > 0 && <div className="mt-2"><p className="text-xs text-muted">{t("דוגמאות שחולצו משיחה זו:", "Examples extracted from this call:")} {detail.examples.length}</p></div>}
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
