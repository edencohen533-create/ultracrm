"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, History, Play, Upload } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Modal, Panel, Select, Spinner, Textarea, cx } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";
import { RecordingDownload } from "@/components/calling/RecordingDownload";
import { CoachAdmin } from "./CoachAdmin";

type T = (he: string, en: string) => string;
type RecStatus = "uploading" | "queued" | "processing" | "ready" | "no_transcript" | "failed";
interface Rec { id: string; source: "upload" | "call"; callId: string | null; dealId: string | null; title: string; fileName: string | null; sizeBytes: number | null; durationSec: number | null; status: RecStatus; error: string | null; auto: boolean; processedAt: string | null; createdAt: string; _count?: { insights: number } }
interface Insight { id: string; kind: Kind; title: string; body: string; objection: string | null; quote: string; startMs: number | null; flags: string[]; status: "candidate" | "approved" | "rejected" | "removed"; version: number; autoPublished: boolean; needsReview: boolean; reviewReason: string | null; recordingId: string | null; dealId: string | null; createdAt: string; recording?: { id: string; title: string; source: string; status: string } | null }
type Kind = "opening" | "discovery" | "objection" | "offer" | "closing" | "improvement";

const KIND: Record<Kind, [string, string]> = { opening: ["פתיחת שיחה", "Opening"], discovery: ["בירור צרכים", "Needs discovery"], objection: ["התנגדות ותשובה", "Objection & answer"], offer: ["הסבר ההצעה", "Explaining the offer"], closing: ["שלב סגירה", "Closing step"], improvement: ["נקודה לשיפור", "To improve"] };
const FLAG: Record<string, [string, string]> = { customer_detail: ["פרטי לקוח", "Customer details"], promise: ["הבטחה", "Promise"], discount: ["הנחה / מחיר חריג", "Discount / unusual price"], price: ["מחיר", "Price"], unverified_fact: ["עובדה שלא אומתה", "Unverified fact"] };
const REC_STATUS: Record<RecStatus, [string, string, "neutral" | "warn" | "good" | "bad" | "info"]> = { uploading: ["מעלה", "Uploading", "info"], queued: ["ממתין לעיבוד", "Queued", "neutral"], processing: ["בעיבוד", "Processing", "warn"], ready: ["מוכן", "Ready", "good"], no_transcript: ["ללא תמלול", "No transcript", "neutral"], failed: ["נכשל", "Failed", "bad"] };
const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const SECTIONS = [["recordings", "הקלטות", "Recordings"], ["insights", "תובנות לסקירה", "Insights to review"], ["learning", "למידה מעסקאות שנסגרו", "Learning from closed deals"], ["setup", "הגדרות וידע מאושר", "Settings & approved knowledge"]] as const;
type Section = (typeof SECTIONS)[number][0];

/**
 * "מאמן מכירות" in the AI Center. Recordings (upload / pick a recorded call) are transcribed and analysed in the
 * background; what comes out is a CANDIDATE until a manager approves it. Approved insights feed the in-call assistant
 * as phrasing; facts come only from approved business sources. Learning = extraction + retrieval, not model training.
 */
export function SalesCoach({ isOwner }: { isOwner: boolean }) {
  const t = useT();
  const [section, setSection] = useState<Section>(() => { try { return (sessionStorage.getItem("sales-coach-section") as Section) || "recordings"; } catch { return "recordings"; } });
  const pick = (s: Section) => { setSection(s); try { sessionStorage.setItem("sales-coach-section", s); } catch { /* private mode */ } };
  return (
    <div className="space-y-4" data-testid="sales-coach">
      <p className="text-sm text-muted">{t("המאמן מפיק ידע מכירתי מהקלטות: פתיחה, בירור צרכים, התנגדויות ותשובות, הסבר ההצעה, סגירה ונקודות לשיפור. כל תובנה נשמרת עם המקור והגרסה, וממתינה לאישור מנהל לפני שעוזר המכירות בחייגן משתמש בה. \"למידה\" כאן = הפקת ידע ושליפתו בזמן הצורך; המודל עצמו אינו מאומן מחדש.", "The coach extracts sales knowledge from recordings: openings, needs discovery, objections and answers, explaining the offer, closing and points to improve. Every insight keeps its source and version and waits for a manager's approval before the in-call assistant uses it. \"Learning\" here = extracting knowledge and retrieving it when needed; the model itself is not re-trained.")}</p>
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-line bg-panel p-1 w-fit max-w-full" role="tablist">
        {SECTIONS.map(([k, he, en]) => <button key={k} role="tab" aria-selected={section === k} onClick={() => pick(k)} className={cx("h-8 px-3 rounded-md text-sm whitespace-nowrap", section === k ? "bg-accent text-white" : "text-muted hover:text-text")} data-testid={`sc-tab-${k}`}>{t(he, en)}</button>)}
      </div>
      {section === "recordings" && <Recordings t={t} />}
      {section === "insights" && <Insights t={t} />}
      {section === "learning" && <Learning t={t} isOwner={isOwner} />}
      {section === "setup" && <CoachAdmin isAdmin={isOwner} />}
    </div>
  );
}

// ─── Recordings ─────────────────────────────────────────────────────────────────

function Recordings({ t }: { t: T }) {
  const [items, setItems] = useState<Rec[] | null>(null);
  const [uploads, setUploads] = useState<Record<string, { name: string; pct: number; error?: string }>>({});
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => { try { setItems((await api.get<{ items: Rec[] }>("/api/coach/recordings")).items); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const busy = items?.some((r) => r.status === "queued" || r.status === "processing");
  useEffect(() => { if (!busy) return; const h = setInterval(() => void load(), 5000); return () => clearInterval(h); }, [busy, load]);

  async function upload(file: File) {
    const key = `${file.name}-${Date.now()}`;
    const set = (v: { pct: number; error?: string }) => setUploads((u) => ({ ...u, [key]: { name: file.name, ...v } }));
    set({ pct: 0 });
    try {
      const s = await api.post<{ id: string; chunkBytes: number; chunks: number }>("/api/coach/recordings", { fileName: file.name, mimeType: file.type || guessType(file.name), sizeBytes: file.size, title: file.name.replace(/\.[^.]+$/, "") });
      for (let i = 0; i < s.chunks; i++) {
        const body = file.slice(i * s.chunkBytes, Math.min(file.size, (i + 1) * s.chunkBytes));
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const res = await fetch(`/api/coach/recordings/${s.id}/chunks/${i}`, { method: "PUT", body, headers: { "content-type": "application/octet-stream" } });
          if (res.ok) ok = true; else if (res.status < 500) { const j = await res.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? t("ההעלאה נכשלה", "Upload failed")); }
        }
        if (!ok) throw new Error(t("ההעלאה נכשלה – בדקו את החיבור ונסו שוב", "Upload failed – check your connection and try again"));
        set({ pct: Math.round(((i + 1) / s.chunks) * 100) });
      }
      const r = await api.post<{ duplicateOf: string | null }>(`/api/coach/recordings/${s.id}/complete`);
      if (r.duplicateOf) toast.info(t("הקובץ הזה כבר הועלה – לא נשמר ולא יעובד שוב", "This file was already uploaded – not saved or processed again"));
      else toast.success(t("ההקלטה הועלתה ונשלחה לעיבוד ברקע", "Uploaded and sent to background processing"));
      setUploads((u) => { const n = { ...u }; delete n[key]; return n; });
      void load();
    } catch (e) { set({ pct: 0, error: (e as Error).message }); }
  }
  async function retry(r: Rec) { try { await api.post(`/api/coach/recordings/${r.id}/reprocess`, { force: false }); toast.success(t("נשלח שוב לעיבוד", "Sent to processing again")); void load(); } catch (e) { toast.error((e as Error).message); } }
  async function remove(r: Rec) {
    if (!confirm(t(`למחוק את "${r.title}"? ההקלטה והתמלול יימחקו; תובנות שממתינות לסקירה יוסרו, וידע שכבר אושר יסומן לבדיקה.`, `Delete "${r.title}"? The recording and transcript are deleted; insights awaiting review are removed and approved knowledge is flagged for review.`))) return;
    try { await api.delete(`/api/coach/recordings/${r.id}`); toast.success(t("נמחק", "Deleted")); setOpen(null); void load(); } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button icon={<Upload size={15} />} onClick={() => fileRef.current?.click()} data-testid="sc-upload">{t("העלאת הקלטה", "Upload a recording")}</Button>
        <Button variant="secondary" onClick={() => setPicking(true)} data-testid="sc-pick">{t("בחירה מהקלטות שיחה קיימות", "Pick from existing call recordings")}</Button>
        <span className="text-xs text-muted">{t("MP3, M4A, WAV, OGG, WEBM · עד 25MB · התמלול והניתוח רצים ברקע (גם אם סוגרים את הדף)", "MP3, M4A, WAV, OGG, WEBM · up to 25MB · transcription and analysis run in the background (even if you close the page)")}</span>
        <input ref={fileRef} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm" multiple hidden onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) void upload(f); e.target.value = ""; }} data-testid="sc-file" />
      </div>
      {Object.entries(uploads).map(([k, u]) => (
        <div key={k} className="rounded-lg border border-line bg-panel p-3 text-sm" data-testid="sc-upload-progress">
          <div className="flex justify-between gap-2"><span className="truncate">{u.name}</span><span className={u.error ? "text-bad" : "text-muted"}>{u.error ?? `${u.pct}%`}</span></div>
          {!u.error && <div className="mt-2 h-1.5 rounded bg-line overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${u.pct}%` }} /></div>}
          {u.error && <button className="mt-1 text-xs underline" onClick={() => setUploads((x) => { const n = { ...x }; delete n[k]; return n; })}>{t("סגור", "Dismiss")}</button>}
        </div>
      ))}
      {!items ? <Spinner /> : !items.length ? <EmptyState title={t("עדיין אין הקלטות במאמן", "No recordings in the coach yet")} hint={t("העלו הקלטת שיחת מכירה טובה, בחרו שיחה מוקלטת מהמערכת, או הפעילו למידה אוטומטית מעסקאות שנסגרו", "Upload a good sales call, pick a recorded call from the system, or turn on learning from closed deals")} /> : (
        <Panel bodyClassName="p-0"><ul className="divide-y divide-line">{items.map((r) => {
          const st = REC_STATUS[r.status];
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-2 p-3 text-sm" data-testid="sc-rec-row" data-status={r.status}>
              <button className="min-w-0 flex-1 text-start" onClick={() => setOpen(r.id)}>
                <div className="font-medium truncate">{r.title}</div>
                <div className="text-xs text-muted">{r.source === "upload" ? t("הועלה", "Uploaded") : r.auto ? t("שיחה מעסקה שנסגרה", "Call from a closed deal") : t("שיחה מהמערכת", "Call from the system")} · {formatDateTime(r.createdAt)}{r.durationSec ? ` · ${mmss(r.durationSec * 1000)}` : ""}{r._count?.insights ? ` · ${t(`${r._count.insights} תובנות`, `${r._count.insights} insights`)}` : ""}</div>
                {r.error && r.status !== "ready" && <div className={cx("text-xs", r.status === "failed" ? "text-bad" : "text-muted")}>{r.error}</div>}
              </button>
              <Badge tone={st[2]} dot={r.status === "processing" || r.status === "queued"}>{t(st[0], st[1])}</Badge>
              {r.status === "failed" && <Button size="sm" variant="secondary" onClick={() => void retry(r)} data-testid="sc-retry">{t("נסה שוב", "Retry")}</Button>}
              <Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>{t("פתיחה", "Open")}</Button>
            </li>);
        })}</ul></Panel>
      )}
      {picking && <PickCall t={t} onClose={() => setPicking(false)} onAdded={() => { setPicking(false); void load(); }} />}
      {open && <RecordingDetail t={t} id={open} onClose={() => setOpen(null)} onDelete={(r) => void remove(r)} onChanged={() => void load()} />}
    </div>
  );
}
function guessType(name: string) { const e = name.toLowerCase().split(".").pop(); return e === "mp3" ? "audio/mpeg" : e === "m4a" ? "audio/mp4" : e === "wav" ? "audio/wav" : e === "ogg" ? "audio/ogg" : e === "webm" ? "audio/webm" : "application/octet-stream"; }

function PickCall({ t, onClose, onAdded }: { t: T; onClose: () => void; onAdded: () => void }) {
  const [q, setQ] = useState(""); const [rows, setRows] = useState<Array<{ id: string; createdAt: string; talkSeconds: number | null; contact: { fullName: string } | null; user: { fullName: string }; salesRecordingId: string | null }> | null>(null);
  useEffect(() => { const h = setTimeout(() => { api.get<{ items: NonNullable<typeof rows> }>(`/api/coach/recordings/calls${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => setRows(r.items)).catch((e) => toast.error(e.message)); }, 250); return () => clearTimeout(h); }, [q]);
  async function add(id: string) { try { const r = await api.post<{ existing: boolean }>("/api/coach/recordings/from-call", { callId: id }); toast.success(r.existing ? t("השיחה כבר במאמן – לא תעובד שוב", "The call is already in the coach – not processed again") : t("נוספה ונשלחה לעיבוד", "Added and sent to processing")); onAdded(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Modal open onClose={onClose} title={t("בחירה מהקלטות שיחה", "Pick a call recording")} width="max-w-2xl">
      <div className="space-y-3" data-testid="sc-pick-modal">
        <Input aria-label={t("חיפוש", "Search")} placeholder={t("שם לקוח או טלפון", "Customer name or phone")} value={q} onChange={(e) => setQ(e.target.value)} />
        {!rows ? <Spinner /> : !rows.length ? <p className="text-sm text-muted">{t("אין שיחות מוקלטות שנענו (בטווח ההרשאות שלך)", "No answered recorded calls (within your permissions)")}</p> : (
          <ul className="divide-y divide-line text-sm max-h-[50dvh] overflow-y-auto">{rows.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1"><div className="truncate">{c.contact?.fullName ?? t("לקוח", "Customer")}</div><div className="text-xs text-muted">{formatDateTime(c.createdAt)} · {c.user.fullName}{c.talkSeconds ? ` · ${mmss(c.talkSeconds * 1000)}` : ""}</div></div>
              {c.salesRecordingId ? <Badge tone="neutral">{t("כבר במאמן", "Already added")}</Badge> : <Button size="sm" onClick={() => void add(c.id)} data-testid="sc-pick-add">{t("הוספה", "Add")}</Button>}
            </li>))}</ul>
        )}
      </div>
    </Modal>
  );
}

function RecordingDetail({ t, id, onClose, onDelete, onChanged }: { t: T; id: string; onClose: () => void; onDelete: (r: Rec) => void; onChanged: () => void }) {
  const [d, setD] = useState<{ recording: Rec & { segments: Array<{ startMs: number; endMs: number; text: string }>; costUsd: number }; insights: Insight[]; deal: { id: string; title: string; status: string } | null } | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const load = useCallback(async () => { try { setD(await api.get(`/api/coach/recordings/${id}`)); } catch (e) { toast.error((e as Error).message); onClose(); } }, [id, onClose]);
  useEffect(() => { void load(); }, [load]);
  const pending = d && (d.recording.status === "queued" || d.recording.status === "processing");
  useEffect(() => { if (!pending) return; const h = setInterval(() => void load(), 5000); return () => clearInterval(h); }, [pending, load]);
  const seek = (ms: number | null) => { if (ms === null || !audio.current) return; audio.current.currentTime = ms / 1000; void audio.current.play().catch(() => undefined); };
  async function reprocess() {
    if (!confirm(t("לעבד מחדש? התמלול והניתוח ירוצו שוב (עלות נוספת). תובנות שממתינות לסקירה יוחלפו; ידע שכבר אושר נשאר.", "Re-process? Transcription and analysis run again (extra cost). Insights awaiting review are replaced; approved knowledge stays."))) return;
    try { await api.post(`/api/coach/recordings/${id}/reprocess`, { force: true }); toast.success(t("נשלח לעיבוד חוזר", "Sent for re-processing")); void load(); onChanged(); } catch (e) { toast.error((e as Error).message); }
  }
  const src = `/api/coach/recordings/${id}/audio`;
  return (
    <Modal open onClose={onClose} title={d?.recording.title ?? t("הקלטה", "Recording")} width="max-w-3xl">
      {!d ? <Spinner /> : (
        <div className="space-y-4 text-sm" data-testid="sc-detail">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={REC_STATUS[d.recording.status][2]}>{t(REC_STATUS[d.recording.status][0], REC_STATUS[d.recording.status][1])}</Badge>
            {d.deal && <Badge tone={d.deal.status === "won" ? "good" : "warn"}>{t("עסקה:", "Deal:")} {d.deal.title}</Badge>}
            {d.recording.costUsd > 0 && <span className="text-xs text-muted">{t("עלות עיבוד", "Processing cost")} ${d.recording.costUsd.toFixed(3)}</span>}
            <span className="ms-auto flex gap-2">
              {(d.recording.status === "ready" || d.recording.status === "no_transcript" || d.recording.status === "failed") && <Button size="sm" variant="secondary" onClick={() => void (d.recording.status === "failed" ? api.post(`/api/coach/recordings/${id}/reprocess`, { force: false }).then(() => { void load(); onChanged(); }).catch((e) => toast.error(e.message)) : reprocess())} data-testid="sc-reprocess">{d.recording.status === "failed" ? t("נסה שוב", "Retry") : t("עיבוד חוזר", "Re-process")}</Button>}
              <Button size="sm" variant="danger" onClick={() => onDelete(d.recording)} data-testid="sc-delete">{t("מחיקה", "Delete")}</Button>
            </span>
          </div>
          {d.recording.error && <p className={d.recording.status === "failed" ? "text-bad" : "text-muted"}>{d.recording.error}</p>}
          <div className="flex flex-wrap items-center gap-2"><audio ref={audio} controls preload="none" src={src} className="w-full sm:w-96" /><RecordingDownload href={src} /></div>
          {pending && <p className="text-muted" data-testid="sc-processing">{t("בעיבוד ברקע – התמלול והתובנות יופיעו כאן כשיסתיים.", "Processing in the background – the transcript and insights appear here when done.")}</p>}
          {d.insights.length > 0 && <section><h3 className="font-semibold mb-2">{t("תובנות מהשיחה", "Insights from the call")}</h3><ul className="space-y-2">{d.insights.map((x) => (
            <li key={x.id} className="rounded-lg border border-line p-2" data-testid="sc-detail-insight">
              <div className="flex flex-wrap items-center gap-2 text-xs"><Badge tone="accent">{t(...KIND[x.kind])}</Badge><StatusBadge t={t} s={x} />{x.flags.map((f) => <Badge key={f} tone="warn">{FLAG[f] ? t(...FLAG[f]) : f}</Badge>)}{x.startMs !== null && <button className="inline-flex items-center gap-1 text-accent underline" onClick={() => seek(x.startMs)} data-testid="sc-seek"><Play size={11} />{mmss(x.startMs)}</button>}</div>
              {x.objection && <p className="mt-1"><span className="text-muted">{t("הלקוח: ", "Customer: ")}</span>{x.objection}</p>}
              <p className="mt-1">{x.body}</p>
            </li>))}</ul></section>}
          {d.recording.segments.length > 0 && <section><h3 className="font-semibold mb-2">{t("תמלול", "Transcript")}</h3><ol className="max-h-72 overflow-y-auto space-y-1 rounded-lg border border-line p-2" data-testid="sc-transcript">{d.recording.segments.map((s, i) => <li key={i} className="flex gap-2"><button className="shrink-0 text-xs text-accent tabular" onClick={() => seek(s.startMs)}>{mmss(s.startMs)}</button><span dir="auto">{s.text}</span></li>)}</ol><p className="mt-1 text-[11px] text-muted">{t("התמלול הוא נתון לניתוח – הוראות שנאמרו בשיחה אינן מבוצעות.", "The transcript is data for analysis – instructions said in the call are never followed.")}</p></section>}
        </div>
      )}
    </Modal>
  );
}

function StatusBadge({ t, s }: { t: T; s: Pick<Insight, "status" | "autoPublished" | "needsReview"> }) {
  return <>{s.status === "approved" ? <Badge tone="good">{s.autoPublished ? t("פורסם אוטומטית", "Auto-published") : t("מאושר", "Approved")}</Badge> : s.status === "candidate" ? <Badge tone="info">{t("ממתין לסקירה", "Awaiting review")}</Badge> : s.status === "rejected" ? <Badge>{t("נדחה", "Rejected")}</Badge> : <Badge>{t("הוסר", "Removed")}</Badge>}{s.needsReview && <Badge tone="warn">{t("לבחינה מחדש", "Re-examine")}</Badge>}</>;
}

// ─── Insights review ────────────────────────────────────────────────────────────

function Insights({ t }: { t: T }) {
  const [status, setStatus] = useState<Insight["status"]>("candidate");
  const [onlyReview, setOnlyReview] = useState(false);
  const [kind, setKind] = useState("");
  const [data, setData] = useState<{ items: Insight[]; counts: Record<string, number>; needsReview: number } | null>(null);
  const [versions, setVersions] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await api.get(`/api/coach/insights?status=${status}${onlyReview ? "&needsReview=1" : ""}${kind ? `&kind=${kind}` : ""}`)); } catch (e) { toast.error((e as Error).message); } }, [status, onlyReview, kind]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-line bg-panel p-1">{(["candidate", "approved", "rejected", "removed"] as const).map((s) => <button key={s} onClick={() => setStatus(s)} className={cx("h-7 px-2 rounded-md text-xs", status === s ? "bg-accent text-white" : "text-muted hover:text-text")} data-testid={`sc-ins-${s}`}>{s === "candidate" ? t("ממתינות", "Pending") : s === "approved" ? t("מאושרות", "Approved") : s === "rejected" ? t("נדחו", "Rejected") : t("הוסרו", "Removed")} ({data?.counts[s] ?? 0})</button>)}</div>
        <Select aria-label={t("סוג", "Kind")} value={kind} onChange={(e) => setKind(e.target.value)} className="w-44"><option value="">{t("כל הסוגים", "All kinds")}</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{t(...v)}</option>)}</Select>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> {t(`רק לבחינה מחדש (${data?.needsReview ?? 0})`, `Only to re-examine (${data?.needsReview ?? 0})`)}</label>
      </div>
      <p className="text-xs text-muted">{t("לא כל מה שנאמר בשיחה נכון או מתאים לשימוש חוזר. תובנות עם פרטי לקוח חייבות עריכה לפני אישור; הבטחות, הנחות ומחירים דורשים אישור מפורש שהם מתאימים כמדיניות כללית. כל עריכה נשמרת כגרסה חדשה ואפשר לחזור לגרסה קודמת.", "Not everything said in a call is true or reusable. Insights with customer details must be edited before approval; promises, discounts and prices need an explicit confirmation that they fit as general policy. Every edit is saved as a new version and you can go back to an earlier one.")}</p>
      {!data ? <Spinner /> : !data.items.length ? <EmptyState title={t("אין תובנות במצב הזה", "No insights in this state")} /> : <ul className="space-y-2">{data.items.map((x) => <InsightCard key={x.id} t={t} x={x} onDone={() => void load()} onVersions={() => setVersions(x.id)} />)}</ul>}
      {versions && <Versions t={t} id={versions} onClose={() => setVersions(null)} onRestored={() => { setVersions(null); void load(); }} />}
    </div>
  );
}

function InsightCard({ t, x, onDone, onVersions }: { t: T; x: Insight; onDone: () => void; onVersions: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ title: x.title, body: x.body, objection: x.objection ?? "" });
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const softFlags = x.flags.filter((fl) => fl !== "customer_detail");
  async function act(action: "approve" | "reject" | "remove") {
    setBusy(true);
    try {
      await api.patch(`/api/coach/insights/${x.id}`, { action, ...(action === "approve" && edit ? { title: f.title, body: f.body, objection: x.kind === "objection" ? f.objection || null : undefined } : {}), ...(action === "approve" ? { acknowledgeFlags: ack } : {}) });
      toast.success(action === "approve" ? t("אושר – עוזר המכירות ישתמש בזה כהצעת ניסוח", "Approved – the sales assistant will use it as suggested wording") : action === "reject" ? t("נדחה", "Rejected") : t("הוסר משימוש", "Removed from use"));
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <li className="rounded-xl border border-line bg-panel p-3 text-sm space-y-2" data-testid="sc-insight">
      <div className="flex flex-wrap items-center gap-2 text-xs"><Badge tone="accent">{t(...KIND[x.kind])}</Badge><StatusBadge t={t} s={x} />{x.flags.map((fl) => <Badge key={fl} tone={fl === "customer_detail" ? "bad" : "warn"}>{FLAG[fl] ? t(...FLAG[fl]) : fl}</Badge>)}<span className="text-muted">{t(`גרסה ${x.version}`, `v${x.version}`)}</span>{x.recording && <span className="text-muted truncate">· {t("מקור:", "Source:")} {x.recording.title}{x.startMs !== null ? ` @ ${mmss(x.startMs)}` : ""}{x.recording.status === "deleted" ? t(" (נמחק)", " (deleted)") : ""}</span>}</div>
      {x.needsReview && x.reviewReason && <p className="flex items-center gap-1 text-xs text-warn"><AlertTriangle size={13} />{x.reviewReason}</p>}
      {edit ? <div className="space-y-2">
        <Input label={t("כותרת", "Title")} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        {x.kind === "objection" && <Input label={t("מה הלקוח אמר", "What the customer said")} value={f.objection} onChange={(e) => setF({ ...f, objection: e.target.value })} />}
        <Textarea label={t("ניסוח / טכניקה לשימוש חוזר", "Reusable wording / technique")} rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} data-testid="sc-insight-body" />
      </div> : <>
        <p className="font-medium">{x.title}</p>
        {x.objection && <p><span className="text-muted">{t("הלקוח: ", "Customer: ")}</span>{x.objection}</p>}
        <p>{x.body}</p>
      </>}
      {x.quote && <details className="text-xs text-muted"><summary className="cursor-pointer">{t("ציטוט מהשיחה", "Quote from the call")}</summary><blockquote className="mt-1 whitespace-pre-wrap border-s-2 border-line ps-2" dir="auto">{x.quote}</blockquote></details>}
      {(x.status === "candidate" || x.status === "rejected" || x.status === "removed" || x.status === "approved") && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {softFlags.length > 0 && x.status !== "approved" && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="sc-ack" /> {t("בדקתי – מתאים לשימוש כללי (לא הבטחה/הנחה חד-פעמית)", "Checked – fits general use (not a one-off promise/discount)")}</label>}
          {x.status !== "approved" || edit ? <Button size="sm" onClick={() => void act("approve")} loading={busy} data-testid="sc-approve">{edit ? t("שמור גרסה ואשר", "Save version & approve") : t("אשר", "Approve")}</Button> : null}
          <Button size="sm" variant="secondary" onClick={() => setEdit((v) => !v)} data-testid="sc-edit">{edit ? t("ביטול עריכה", "Cancel edit") : t("עריכה", "Edit")}</Button>
          {x.status === "candidate" && <Button size="sm" variant="ghost" onClick={() => void act("reject")} data-testid="sc-reject">{t("דחה", "Reject")}</Button>}
          {x.status === "approved" && <Button size="sm" variant="ghost" onClick={() => void act("remove")} data-testid="sc-remove">{t("הסר משימוש", "Remove from use")}</Button>}
          <button className="ms-auto inline-flex items-center gap-1 text-xs text-muted hover:text-text" onClick={onVersions} data-testid="sc-versions"><History size={13} />{t("גרסאות", "Versions")}</button>
        </div>
      )}
    </li>
  );
}

function Versions({ t, id, onClose, onRestored }: { t: T; id: string; onClose: () => void; onRestored: () => void }) {
  const [items, setItems] = useState<Array<{ id: string; version: number; title: string; body: string; status: string; autoPublished: boolean; reviewedAt: string | null; reviewedBy: string | null; createdAt: string }> | null>(null);
  useEffect(() => { api.get<{ items: NonNullable<typeof items> }>(`/api/coach/insights/${id}/versions`).then((r) => setItems(r.items)).catch((e) => toast.error(e.message)); }, [id]);
  const current = items?.find((v) => v.status !== "superseded");
  async function restore(versionId: string) { try { await api.patch(`/api/coach/insights/${current!.id}`, { action: "restore", versionId }); toast.success(t("הגרסה שוחזרה כגרסה נוכחית", "Restored as the current version")); onRestored(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <Modal open onClose={onClose} title={t("היסטוריית גרסאות", "Version history")} width="max-w-2xl">
      {!items ? <Spinner /> : <ul className="space-y-2 text-sm" data-testid="sc-versions-list">{items.map((v) => (
        <li key={v.id} className="rounded-lg border border-line p-2">
          <div className="flex flex-wrap items-center gap-2 text-xs"><b>{t(`גרסה ${v.version}`, `Version ${v.version}`)}</b><span className="text-muted">{v.status === "superseded" ? t("קודמת", "Previous") : t("נוכחית", "Current")}{v.autoPublished ? t(" · פורסמה אוטומטית", " · auto-published") : ""}{v.reviewedBy ? ` · ${v.reviewedBy}` : ""} · {formatDateTime(v.reviewedAt ?? v.createdAt)}</span>
            {v.status === "superseded" && current && <button className="ms-auto text-accent underline" onClick={() => void restore(v.id)} data-testid="sc-restore">{t("שחזר גרסה זו", "Restore this version")}</button>}</div>
          <p className="mt-1 font-medium">{v.title}</p><p className="text-muted">{v.body}</p>
        </li>))}</ul>}
    </Modal>
  );
}

// ─── Learning from closed deals ─────────────────────────────────────────────────

interface LearningData { settings: { learnFromRecordings: boolean; learnDealCondition: "won" | "paid"; autoPublish: { enabled: boolean; kinds: string[] }; documentFromRecordings: boolean }; conditions: Record<"won" | "paid", string>; selection: string; providers: { llm: string; stt: string }; deals: Array<{ id: string; dealId: string; condition: string; status: string; callIds: string[]; note: string | null; updatedAt: string; deal: { title: string; status: string; contact: { fullName: string } } | null }> }
const DL_STATUS: Record<string, [string, string, "neutral" | "warn" | "good" | "bad" | "info"]> = { waiting_payment: ["ממתין לתשלום", "Waiting for payment", "warn"], queued: ["נשלח לעיבוד", "Sent to processing", "info"], done: ["הסתיים", "Done", "good"], no_recordings: ["אין הקלטות", "No recordings", "neutral"], changed: ["העסקה השתנתה – לבחינה", "Deal changed – re-examine", "bad"] };

function Learning({ t, isOwner }: { t: T; isOwner: boolean }) {
  const [d, setD] = useState<LearningData | null>(null);
  const load = useCallback(async () => { try { setD(await api.get("/api/coach/learning")); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function save(patch: Partial<LearningData["settings"]>) {
    if (!d) return;
    try { await api.patch("/api/settings", { settings: { coach: patch } }); toast.success(t("נשמר", "Saved")); void load(); } catch (e) { toast.error((e as Error).message); }
  }
  if (!d) return <Spinner />;
  const s = d.settings;
  const kinds = Object.keys(KIND) as Kind[];
  return (
    <div className="space-y-4">
      <Panel title={t("למידה אוטומטית מהקלטות של עסקאות שנסגרו", "Learn automatically from recordings of closed deals")}>
        <div className="space-y-3 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.learnFromRecordings} disabled={!isOwner} onChange={(e) => void save({ learnFromRecordings: e.target.checked })} data-testid="sc-learn-toggle" /> {t("ללמוד אוטומטית מהקלטות של עסקאות שנסגרו (עלות תמלול וניתוח)", "Learn automatically from recordings of closed deals (transcription and analysis cost)")}</label>
          <fieldset className="space-y-1" disabled={!isOwner}>
            <legend className="text-xs text-muted mb-1">{t("מתי עסקה נחשבת סגורה ללמידה", "When a deal counts as closed for learning")}</legend>
            {(["won", "paid"] as const).map((k) => <label key={k} className="flex items-start gap-2"><input type="radio" name="sc-cond" className="mt-1" checked={s.learnDealCondition === k} onChange={() => void save({ learnDealCondition: k })} data-testid={`sc-cond-${k}`} /><span><b>{k === "won" ? t("עסקה שנסגרה", "Closed deal") : t("עסקה שנסגרה ושולמה", "Closed and paid deal")}</b> – {d.conditions[k]}</span></label>)}
          </fieldset>
          <dl className="grid gap-2 sm:grid-cols-[10rem_1fr] text-sm" data-testid="sc-learn-explain">
            <dt className="text-muted">{t("אילו שיחות נכללות", "Which calls are included")}</dt><dd>{d.selection}</dd>
            <dt className="text-muted">{t("מתי מתבצע העיבוד", "When processing happens")}</dt><dd>{t("ברקע, כמה דקות אחרי שהעסקה עומדת בתנאי (בתנאי \"שולמה\" – אחרי אישור התשלום, עד 30 יום). שיחה שכבר עובדה לא מעובדת שוב.", "In the background, a few minutes after the deal meets the condition (for \"paid\" – after the payment is confirmed, up to 30 days). A call already processed is not processed again.")}</dd>
            <dt className="text-muted">{t("מה נעשה עם התוצאה", "What happens with the result")}</dt><dd>{t("התובנות נכנסות לתור \"תובנות לסקירה\" כמועמדות. הן לא משמשות את עוזר המכירות עד שמנהל מאשר – או לפי מדיניות פרסום אוטומטי מפורשת (למטה). אם העסקה בוטלה או נפתחה מחדש, מה שנלמד ממנה מסומן לבחינה מחדש.", "Insights enter the \"Insights to review\" queue as candidates. The sales assistant doesn't use them until a manager approves – or an explicit auto-publish policy (below). If the deal is cancelled or reopened, what was learned from it is flagged for re-examination.")}</dd>
          </dl>
          {(d.providers.stt === "missing" || d.providers.llm === "missing") && <p className="text-warn text-xs" data-testid="sc-providers-missing">{t("חסר חיבור לשירות תמלול (OPENAI_API_KEY) או למודל AI (ANTHROPIC_API_KEY) – הקלטות יסומנו \"נכשל\" עם הסבר עד לחיבור, ואפשר לנסות שוב אחריו.", "Missing a transcription (OPENAI_API_KEY) or AI model (ANTHROPIC_API_KEY) connection – recordings are marked \"failed\" with an explanation until connected, then can be retried.")}</p>}
        </div>
      </Panel>

      <Panel title={t("מדיניות פרסום אוטומטי (כבוי כברירת מחדל)", "Auto-publish policy (off by default)")}>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.autoPublish.enabled} disabled={!isOwner} onChange={(e) => void save({ autoPublish: { ...s.autoPublish, enabled: e.target.checked } })} data-testid="sc-auto-toggle" /> {t("לפרסם אוטומטית תובנות מהסוגים שנבחרו", "Auto-publish insights of the chosen kinds")}</label>
          <div className="flex flex-wrap gap-3">{kinds.map((k) => <label key={k} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!isOwner || !s.autoPublish.enabled} checked={s.autoPublish.kinds.includes(k)} onChange={(e) => void save({ autoPublish: { ...s.autoPublish, kinds: e.target.checked ? [...s.autoPublish.kinds, k] : s.autoPublish.kinds.filter((x) => x !== k) } })} data-testid={`sc-auto-kind-${k}`} /> {t(...KIND[k])}</label>)}</div>
          <p className="text-xs text-muted">{t("רק תובנות מעסקאות שעומדות בתנאי, ורק בלי אף סימון (פרטי לקוח, הבטחה, הנחה, מחיר, עובדה לא מאומתת). כל פרסום נרשם ביומן, ואפשר להסיר או לחזור לגרסה קודמת. אם העסקה משתנה – התובנה חוזרת לסקירה.", "Only insights from deals that meet the condition, and only without any flag (customer details, promise, discount, price, unverified fact). Every publish is logged, and you can remove it or go back to an earlier version. If the deal changes – the insight goes back to review.")}</p>
        </div>
      </Panel>

      <Panel title={t("תיעוד שיחות", "Call documentation")}>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.documentFromRecordings} disabled={!isOwner} onChange={(e) => void save({ documentFromRecordings: e.target.checked })} /> {t("לתעד שיחה שאין לה תמלול חי מתוך ההקלטה השמורה (עלות תמלול)", "Document a call without a live transcript from its saved recording (transcription cost)")}</label>
      </Panel>

      <Panel title={t("עסקאות אחרונות", "Recent deals")} bodyClassName="p-0">
        {!d.deals.length ? <p className="p-3 text-xs text-muted">{t("עדיין לא נסגרו עסקאות מאז שהלמידה הופעלה.", "No deals closed since learning was turned on.")}</p> : (
          <ul className="divide-y divide-line text-sm" data-testid="sc-deals">{d.deals.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1"><div className="truncate">{r.deal?.title ?? t("עסקה", "Deal")} · {r.deal?.contact.fullName}</div><div className="text-xs text-muted">{r.condition === "paid" ? t("תנאי: נסגרה ושולמה", "Condition: closed and paid") : t("תנאי: נסגרה", "Condition: closed")} · {t(`${r.callIds.length} שיחות מוקלטות`, `${r.callIds.length} recorded calls`)} · {formatDateTime(r.updatedAt)}{r.note ? ` · ${r.note}` : ""}</div></div>
              <Badge tone={(DL_STATUS[r.status] ?? DL_STATUS.queued)[2]}>{t(...((DL_STATUS[r.status] ?? DL_STATUS.queued).slice(0, 2) as [string, string]))}</Badge>
            </li>))}</ul>
        )}
      </Panel>
    </div>
  );
}
