"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, CircleAlert, CircleX, X } from "lucide-react";
import { api, ApiClientError } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";

interface CheckRow { key: string; label: string; ok: boolean; blocking: boolean; detail: string }
interface Summary { trigger: string; external: string[]; audience: string; cost: string[]; running: string }

/**
 * "שמירה והפעלה": the server checks (permissions, package, connections, templates, lists, loops, double sends), what
 * the journey will do outside the system, the audience and cost, and what happens to runs already in progress.
 * Scope is explicit: only events from now on – existing contacts are not replayed. Publishing re-checks on the server.
 */
export function PublishDialog({ def, status, onClose, saveFirst, onPublished }: { def: unknown; status: string; onClose: () => void; saveFirst: () => Promise<string | null>; onPublished: (version: number, id: string) => void }) {
  const t = useT();
  const [data, setData] = useState<{ checks: CheckRow[]; summary: Summary | null } | null>(null);
  const [scope, setScope] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snap] = useState(def); // the definition as it was when the dialog opened
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { api.post<{ checks: CheckRow[]; summary: Summary | null }>("/api/sequences/checks", snap).then(setData).catch((e) => { toast.error((e as Error).message); onClose(); }); }, [snap]);
  const blocked = !data || data.checks.some((c) => c.blocking && !c.ok);
  async function go() {
    setBusy(true);
    try {
      const id = await saveFirst(); if (!id) return;
      const r = await api.post<{ version: number }>(`/api/sequences/${id}/publish`, { definition: snap });
      toast.success(t(`האוטומציה הופעלה (גרסה ${r.version})`, `Automation activated (version ${r.version})`));
      onPublished(r.version, id);
    } catch (e) {
      const d = e instanceof ApiClientError ? (e.details as { checks?: CheckRow[] } | undefined) : undefined;
      if (d?.checks) setData((x) => ({ checks: d.checks!, summary: x?.summary ?? null }));
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  }
  return (
    <div className="wz-modal" role="dialog" aria-modal="true" aria-labelledby="jr-pub-title" data-testid="journey-publish-dialog"><div className="wz-modal-box jr-dialog">
      <header><strong id="jr-pub-title">{status === "active" ? t("הפעלת גרסה חדשה", "Activate a new version") : t("שמירה והפעלה", "Save & activate")}</strong><button onClick={onClose} aria-label={t("סגור", "Close")}><X size={18} /></button></header>
      <div className="jr-dialog-body">
        {!data ? <p className="jr-hint">{t("בודק…", "Checking…")}</p> : <>
          <h4>{t("בדיקות לפני הפעלה", "Pre-activation checks")}</h4>
          <ul className="jr-checks" data-testid="journey-checks">{data.checks.map((c) => <li key={c.key} className={c.ok ? "ok" : c.blocking ? "bad" : "warn"} data-testid={`journey-check-${c.key.split(":")[0]}`} data-ok={c.ok}>{c.ok ? <Check size={15} /> : c.blocking ? <CircleX size={15} /> : <CircleAlert size={15} />}<span><b>{c.label}</b> – {c.detail}</span></li>)}</ul>
          {data.summary && <>
            <h4>{t("מה יקרה", "What will happen")}</h4>
            <dl className="jr-sum">
              <dt>{t("טריגר", "Trigger")}</dt><dd>{data.summary.trigger}</dd>
              <dt>{t("פעולות חיצוניות", "External actions")}</dt><dd data-testid="journey-external">{data.summary.external.length ? data.summary.external.join(" · ") : t("אין – רק פעולות בתוך המערכת", "None – in-system actions only")}</dd>
              <dt>{t("קהל", "Audience")}</dt><dd>{data.summary.audience}</dd>
              <dt>{t("עלות משוערת", "Estimated cost")}</dt><dd>{data.summary.cost.length ? data.summary.cost.join(" · ") : t("ללא עלות שליחה", "No sending cost")}</dd>
              <dt>{t("ריצות קיימות", "Runs in progress")}</dt><dd>{data.summary.running}</dd>
            </dl>
            <label className="jr-scope"><input type="checkbox" checked={scope} onChange={(e) => setScope(e.target.checked)} data-testid="journey-scope" /> {t("ברור לי: ההפעלה חלה רק על אירועים חדשים מרגע זה – אנשי קשר קיימים לא ייכנסו למסע רטרואקטיבית.", "Understood: activation applies only to new events from now on – existing contacts won't be entered retroactively.")}</label>
          </>}
        </>}
      </div>
      <div className="wz-modal-actions"><button className="wz-btn ghost" onClick={onClose}>{t("ביטול", "Cancel")}</button><button className="wz-btn primary" onClick={() => void go()} disabled={blocked || !scope || busy} data-testid="journey-publish-confirm">{busy ? t("מפעיל…", "Activating…") : blocked && data ? t("יש לתקן את הבדיקות שנכשלו", "Fix the failed checks") : t("אישור והפעלה", "Approve & activate")}</button></div>
    </div></div>
  );
}

interface SimStep { step: number; title: string; result: "done" | "skipped" | "stop"; why: string; at: string }

/** Dry run: test data or a real contact (read-only). Explains why each condition held or not – nothing is sent. */
export function SimulateDialog({ def, onClose }: { def: unknown; onClose: () => void }) {
  const t = useT();
  const [src, setSrc] = useState<"data" | "contact">("data");
  const [tags, setTags] = useState(""); const [leadStatus, setLeadStatus] = useState(""); const [consent, setConsent] = useState<"OPTED_IN" | "UNKNOWN" | "OPTED_OUT">("OPTED_IN"); const [replied, setReplied] = useState(false);
  const [q, setQ] = useState(""); const [hits, setHits] = useState<Array<{ id: string; fullName: string; phoneE164: string | null }>>([]); const [contactId, setContactId] = useState("");
  const [res, setRes] = useState<{ steps: SimStep[]; contact: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (src !== "contact" || q.trim().length < 2) return; const h = setTimeout(() => { api.get<{ items: Array<{ id: string; fullName: string; phoneE164: string | null }> }>(`/api/contacts?q=${encodeURIComponent(q)}&limit=8`).then((r) => setHits(r.items)).catch(() => setHits([])); }, 300); return () => clearTimeout(h); }, [q, src]);
  async function run() {
    setBusy(true);
    try { setRes(await api.post("/api/sequences/simulate", src === "contact" ? { definition: def, contactId } : { definition: def, data: { tags: tags.split(",").map((x) => x.trim()).filter(Boolean), leadStatus: leadStatus || undefined, consent, replied } })); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="wz-modal" role="dialog" aria-modal="true" aria-labelledby="jr-sim-title" data-testid="journey-sim-dialog"><div className="wz-modal-box jr-dialog">
      <header><strong id="jr-sim-title">{t("סימולציה – שום דבר לא נשלח", "Simulation – nothing is sent")}</strong><button onClick={onClose} aria-label={t("סגור", "Close")}><X size={18} /></button></header>
      <div className="jr-dialog-body">
        <div className="jr-seg" role="radiogroup"><button role="radio" aria-checked={src === "data"} className={src === "data" ? "on" : ""} onClick={() => setSrc("data")}>{t("נתוני בדיקה", "Test data")}</button><button role="radio" aria-checked={src === "contact"} className={src === "contact" ? "on" : ""} onClick={() => setSrc("contact")} data-testid="sim-src-contact">{t("איש קשר קיים (קריאה בלבד)", "Existing contact (read-only)")}</button></div>
        {src === "data" ? <div className="jr-form flat">
          <label>{t("תגיות (מופרדות בפסיק)", "Tags (comma-separated)")}<input value={tags} onChange={(e) => setTags(e.target.value)} data-testid="sim-tags" /></label>
          <label>{t("סטטוס ליד", "Lead status")}<select value={leadStatus} onChange={(e) => setLeadStatus(e.target.value)} data-testid="sim-status"><option value="">{t("לא ידוע", "Unknown")}</option>{[["new", "חדש", "New"], ["contacted", "נוצר קשר", "Contacted"], ["follow_up", "פולואפ", "Follow-up"], ["qualified", "מתאים", "Qualified"], ["converted", "הומר", "Converted"], ["lost", "אבוד", "Lost"]].map(([k, he, en]) => <option key={k} value={k}>{t(he, en)}</option>)}</select></label>
          <label>{t("הסכמה לדיוור", "Marketing consent")}<select value={consent} onChange={(e) => setConsent(e.target.value as typeof consent)} data-testid="sim-consent"><option value="OPTED_IN">{t("נתן הסכמה", "Opted in")}</option><option value="UNKNOWN">{t("לא ידוע", "Unknown")}</option><option value="OPTED_OUT">{t("הסיר את עצמו", "Opted out")}</option></select></label>
          <label className="jr-check"><input type="checkbox" checked={replied} onChange={(e) => setReplied(e.target.checked)} data-testid="sim-replied" /> {t("הלקוח השיב", "The customer replied")}</label>
        </div> : <div className="jr-form flat">
          <label>{t("חיפוש איש קשר", "Find a contact")}<input value={q} onChange={(e) => { setQ(e.target.value); setContactId(""); }} data-testid="sim-contact-q" /></label>
          {hits.length > 0 && q.trim().length >= 2 && <ul className="jr-hits">{hits.map((h) => <li key={h.id}><button className={contactId === h.id ? "on" : ""} onClick={() => setContactId(h.id)}>{h.fullName} <span dir="ltr">{h.phoneE164}</span></button></li>)}</ul>}
        </div>}
        <button className="wz-btn primary small" onClick={() => void run()} disabled={busy || (src === "contact" && !contactId)} data-testid="sim-run">{busy ? t("מריץ…", "Running…") : t("הרצת סימולציה", "Run simulation")}</button>
        {res && <ol className="jr-sim" data-testid="sim-result">{res.steps.map((s) => <li key={s.step} className={s.result} data-testid={`sim-step-${s.step}`}><span className="jr-sim-at">{s.at}</span><b>{s.title}</b><span>{s.result === "done" ? t("✓ מתבצע", "✓ Runs") : s.result === "skipped" ? t("↷ מדולג", "↷ Skipped") : t("■ המסע נעצר", "■ Journey stops")}</span><p>{s.why}</p></li>)}</ol>}
      </div>
    </div></div>
  );
}
