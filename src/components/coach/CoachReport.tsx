"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Panel, Spinner, Stat } from "@/components/ui";
import { formatDateTime, formatDuration } from "@/lib/client/format";

type Metrics = { days: number; providers: { llm: string; stt: string; mock: boolean }; pricing: Record<string, number>; sessions: number; recommendationsShown: number; feedback: Record<string, number>; topObjections: Array<{ objection: string; count: number }>; avgLatencyMs: number | null; usage: { sttSeconds: number; tokensIn: number; tokensOut: number; costUsd: number; coachedTalkSeconds: number; costPerTalkHourUsd: number | null }; examples: Array<{ status: string; outcome: string; count: number }>; dealOutcomesOfCoachedLeads: Record<string, number>; note: string };
type SessionRow = { id: string; callId: string; status: string; createdAt: string; stage: string | null; lastObjection: string | null; segmentsCount: number; call: { at: string; answered: boolean; talkSeconds: number | null; outcome: string | null; agent: { fullName: string }; contact: { id: string; fullName: string } | null }; recommendations: number; helpful: number; notHelpful: number; costUsd: number; avgLatencyMs: number | null };
type Detail = { session: { segments: Array<{ id: string; speaker: string; text: string; source: string; createdAt: string }>; recommendations: Array<{ id: string; objection: string | null; sayNow: string; why: string; basis: string; confidence: number; sources: { exampleIds?: string[]; knowledge?: string[]; model?: string }; latencyMs: number | null; shownAt: string | null; feedback: string | null; supersededAt: string | null; createdAt: string }>; call: { user: { fullName: string }; contact: { fullName: string } | null; outcome: string | null } }; examples: Array<{ id: string; objection: string; agentResponse: string; outcome: string; status: string }>; sourceExamples: Array<{ id: string; objection: string; agentResponse: string; editedResponse: string | null; outcome: string; callId: string | null }> };

/** Managers' view: measured usage, objections seen, feedback, coached calls with every recommendation and its sources. */
export function CoachReport() {
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
      <div className="flex items-center gap-2 text-sm">{[7, 30, 90].map((d) => <Button key={d} size="sm" variant={days === d ? "primary" : "ghost"} onClick={() => setDays(d)}>{d} ימים</Button>)}{m.providers.mock && <Badge tone="warn">ספק AI מדומה – נתוני בדיקה</Badge>}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <Stat label="שיחות עם מאמן פעיל" value={m.sessions} />
        <Stat label="המלצות שהוצגו" value={m.recommendationsShown} />
        <Stat label="סומנו מועיל" value={fb.helpful ?? 0} sub={`לא מועיל ${fb.not_helpful ?? 0} · דולגו ${fb.skipped ?? 0} · הוסתרו ${fb.hidden ?? 0}`} />
        <Stat label="השהיה ממוצעת" value={m.avgLatencyMs != null ? `${(m.avgLatencyMs / 1000).toFixed(1)} שנ׳` : "—"} sub="מסיום משפט הלקוח עד ההמלצה" />
        <Stat label="עלות נמדדת" value={`$${m.usage.costUsd.toFixed(3)}`} sub={m.usage.costPerTalkHourUsd != null ? `≈ $${m.usage.costPerTalkHourUsd.toFixed(3)} לשעת שיחה` : "אין זמן שיחה נמדד"} />
        <Stat label="דקות תמלול" value={Math.round(m.usage.sttSeconds / 60)} sub={`${m.usage.tokensIn + m.usage.tokensOut} טוקנים`} />
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        <Panel title="התנגדויות נפוצות" bodyClassName="p-0">{m.topObjections.length === 0 ? <EmptyState title="אין עדיין" /> : <ul className="divide-y divide-line text-sm">{m.topObjections.map((o) => <li key={o.objection} className="px-4 py-2 flex justify-between"><span>{o.objection}</span><span className="tabular text-muted">{o.count}</span></li>)}</ul>}</Panel>
        <Panel title="דוגמאות למידה"><ul className="text-sm space-y-1">{m.examples.length === 0 ? <li className="text-muted text-xs">אין דוגמאות עדיין</li> : m.examples.map((e) => <li key={e.status + e.outcome} className="flex justify-between"><span>{e.status === "approved" ? "מאושרות" : e.status === "pending" ? "ממתינות" : "נפסלו"} · {e.outcome === "won" ? "עסקה נסגרה" : e.outcome === "lost" ? "לא נסגרה" : "ללא תוצאה"}</span><span className="tabular">{e.count}</span></li>)}</ul></Panel>
        <Panel title="תוצאות עסקאות של לידים בשיחות מאומנות"><ul className="text-sm space-y-1">{Object.keys(m.dealOutcomesOfCoachedLeads).length === 0 ? <li className="text-muted text-xs">אין עסקאות מקושרות</li> : Object.entries(m.dealOutcomesOfCoachedLeads).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k === "won" ? "נסגרו" : k === "lost" ? "לא נסגרו" : "פתוחות"}</span><span className="tabular">{v}</span></li>)}</ul><p className="text-[11px] text-muted mt-2">{m.note}</p></Panel>
      </div>
      <Panel title="שיחות שבהן ניתנו המלצות" bodyClassName="p-0">
        {!rows ? <div className="p-4"><Spinner /></div> : rows.length === 0 ? <EmptyState title="עדיין אין שיחות עם מאמן" /> : (
          <table className="w-full text-sm"><thead className="text-xs text-muted bg-white/3"><tr><th className="text-start px-3 h-9">מועד</th><th className="text-start px-3">נציג</th><th className="text-start px-3">לקוח</th><th className="text-start px-3">משך</th><th className="text-start px-3">התנגדות אחרונה</th><th className="text-start px-3">המלצות</th><th className="text-start px-3">מועיל</th><th className="text-start px-3">השהיה</th><th className="text-start px-3">עלות</th><th className="text-start px-3">תוצאה</th><th></th></tr></thead>
            <tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.id}><td className="px-3 h-10 tabular text-xs">{formatDateTime(r.call.at)}</td><td className="px-3">{r.call.agent.fullName}</td><td className="px-3">{r.call.contact?.fullName ?? "—"}</td><td className="px-3 tabular">{r.call.talkSeconds ? formatDuration(r.call.talkSeconds) : "—"}</td><td className="px-3 text-xs">{r.lastObjection ?? "—"}</td><td className="px-3 tabular">{r.recommendations}</td><td className="px-3 tabular">{r.helpful}</td><td className="px-3 tabular text-xs">{r.avgLatencyMs != null ? `${(r.avgLatencyMs / 1000).toFixed(1)}s` : "—"}</td><td className="px-3 tabular text-xs">${r.costUsd.toFixed(4)}</td><td className="px-3 text-xs">{r.call.outcome ?? "—"}</td><td className="px-3"><Button size="sm" variant="ghost" onClick={() => open(r.id)}>פרטים</Button></td></tr>)}</tbody></table>
        )}
      </Panel>
      {detail && (
        <Panel title={`שיחה: ${detail.session.call.user.fullName} ↔ ${detail.session.call.contact?.fullName ?? "—"}`} actions={<Button size="sm" variant="ghost" onClick={() => setDetail(null)}>סגור</Button>}>
          <div className="grid lg:grid-cols-2 gap-4 text-sm">
            <div><p className="text-xs text-muted mb-1">תמלול (מקור לכל מקטע)</p><ul className="space-y-1 max-h-96 overflow-auto">{detail.session.segments.map((s) => <li key={s.id} className="text-xs"><span className="text-muted">[{s.speaker === "customer" ? "לקוח" : s.speaker === "agent" ? "נציג" : "?"} · {s.source === "simulation" ? "הדמיה" : s.source === "recording" ? "הקלטה" : "תמלול חי"}]</span> {s.text}</li>)}</ul></div>
            <div><p className="text-xs text-muted mb-1">המלצות – מה הוצג, מתי, על סמך מה</p><ul className="space-y-2 max-h-96 overflow-auto">{detail.session.recommendations.map((r) => <li key={r.id} className="rounded-md border border-line p-2 text-xs space-y-0.5"><p className="tabular text-muted">{formatDateTime(r.createdAt)} · {r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)} שנ׳` : ""} · {r.feedback ? `פידבק: ${r.feedback}` : r.shownAt ? "הוצג" : "לא הוצג"}{r.supersededAt ? " · הוחלף" : ""}</p>{r.objection && <p>התנגדות: {r.objection}</p>}<p className="font-medium text-sm">{r.sayNow}</p><p className="text-muted">{r.why}</p><p className="text-muted">בסיס: {r.basis === "examples" ? `דוגמאות ${(r.sources.exampleIds ?? []).length}` : r.basis === "question" ? "שאלה לנציג" : "ידע עסקי בלבד"} · ביטחון {Math.round(r.confidence * 100)}% · מודל {r.sources.model ?? "—"}</p></li>)}</ul>
              {detail.sourceExamples.length > 0 && <div className="mt-2"><p className="text-xs text-muted">דוגמאות ששימשו:</p><ul className="text-xs space-y-1">{detail.sourceExamples.map((e) => <li key={e.id}><Badge tone={e.outcome === "won" ? "good" : e.outcome === "lost" ? "bad" : "neutral"}>{e.outcome}</Badge> {e.objection} → {e.editedResponse ?? e.agentResponse}</li>)}</ul></div>}
              {detail.examples.length > 0 && <div className="mt-2"><p className="text-xs text-muted">דוגמאות שחולצו משיחה זו: {detail.examples.length}</p></div>}
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
