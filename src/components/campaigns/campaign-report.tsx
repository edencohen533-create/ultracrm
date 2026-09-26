"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CHANNEL_LABELS, recipientStatusLabels, deliveryStatusLabels, CAMPAIGN_BUCKET_LABELS, campaignBucket } from "@/lib/campaigns";

type Report = { id: string; name: string; channel: string; status: string; scheduledAt?: string | null; audienceExcluded?: number; statusReason: string | null; simulated: boolean; recipients: Record<string, number>; delivery: Record<string, number>; engagement: { opened: number; clicked: number; complained: number; hardBounce: number; softBounce: number; replies: number | null; unsubscribes: number }; cost: { actual: { amount: number; currency: string | null; messages: number } | null; estimate: { total: number | null; currency: string | null; known: boolean } | null }; availability: Record<string, string>; notes: string[] };
type Recipient = { id: string; status: string; error: string | null; attempts: number; contact: { name: string; phone: string }; identifier: string | null; deliveryStatus?: string | null; deliveryError?: string | null };
type Links = { links: Array<{ url: string; uniqueClicks: number | null }>; totalUniqueClicks: number | null; perLinkTracking: boolean; note: string };
const AVAIL: Record<string, string> = { real: "נתון מהספק", simulated: "הדמיה", estimated: "אומדן", partial: "חלקי", unavailable: "אין נתונים", signal: "אות מהספק" };
const pct = (n: number, d: number) => d ? `${(n / d * 100).toFixed(1)}%` : "—";

/** Campaign report: overview (metrics per channel + failures + links), recipients (search/filter), links. Zero ≠ unavailable. */
export function CampaignReport({ id }: { id: string }) {
  const [tab, setTab] = useState<"overview" | "recipients" | "links">("overview");
  const [report, setReport] = useState<Report | null>(null);
  const [links, setLinks] = useState<Links | null>(null);
  const [recipients, setRecipients] = useState<{ total: number; page: number; recipients: Recipient[] } | null>(null);
  const [rq, setRq] = useState(""); const [rs, setRs] = useState(""); const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetch(`/api/campaigns/${id}/report`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setReport(d); }).catch((e) => setError(e.message)); fetch(`/api/campaigns/${id}/links`).then((r) => r.json()).then(setLinks).catch(() => undefined); }, [id]);
  const loadRecipients = useCallback(() => { fetch(`/api/campaigns/${id}?page=${page}${rs ? `&status=${rs}` : ""}${rq.trim() ? `&q=${encodeURIComponent(rq.trim())}` : ""}`).then((r) => r.json()).then(setRecipients).catch(() => toast.error("לא ניתן לטעון נמענים")); }, [id, page, rs, rq]);
  useEffect(() => { if (tab === "recipients") { const t = setTimeout(loadRecipients, 300); return () => clearTimeout(t); } }, [tab, loadRecipients]);
  if (error) return <div className="p-8 text-bad">{error}</div>;
  if (!report) return <div className="p-8 text-muted">טוען דוח…</div>;
  // Contacts removed by an excluded audience at draft time are not recipients of this campaign.
  const excludedAtDraft = report.audienceExcluded ?? 0;
  const total = Object.values(report.recipients).reduce((a, b) => a + b, 0) - excludedAtDraft;
  const sent = report.recipients.SENT ?? 0; const failed = report.recipients.FAILED ?? 0; const unknown = report.recipients.UNKNOWN ?? 0; const skipped = Math.max(0, (report.recipients.SKIPPED ?? 0) - excludedAtDraft);
  const delivered = (report.delivery.DELIVERED ?? 0) + (report.delivery.READ ?? 0);
  const deliveryKnown = report.availability.delivery === "real" || report.availability.delivery === "simulated";
  const metric = (label: string, value: number | string | null, sub?: string, note?: string) => <div className="rep-metric" key={label}><span className="rep-sub">{sub ?? ""}</span><strong>{value === null ? "—" : value}</strong><span className="rep-label">{label}</span>{note && <span className="rep-note">{note}</span>}</div>;
  const failures = Object.entries(report.delivery).filter(([k]) => ["FAILED", "BOUNCED", "CANCELLED", "UNKNOWN"].includes(k));
  return (
    <div className="rep" data-testid="campaign-report">
      <header className="rep-head"><nav className="rep-crumbs"><Link href={`/campaigns/${report.channel}`}>קמפיינים</Link><span>›</span><span>{CHANNEL_LABELS[report.channel]}</span><span>›</span><strong>{report.name}</strong></nav><div className="rep-status">{(() => { const b = campaignBucket({ status: report.status, statusReason: report.statusReason, counts: report.recipients, scheduledAt: report.scheduledAt }); return <span className={`cmp-badge ${b}`}>{b === "cancelled" ? "בוטל" : CAMPAIGN_BUCKET_LABELS[b]}</span>; })()}{report.simulated && <span className="cmp-badge failed">הדמיה – לא נשלחו הודעות אמיתיות</span>}{report.statusReason && <span className="text-bad text-xs">{report.statusReason}</span>}</div></header>
      <div className="rep-tabs" role="tablist">{([["overview", "סקירה כללית"], ["recipients", "נמענים"], ["links", "קישורים"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)} data-testid={`report-tab-${k}`}>{l}</button>)}</div>
      {tab === "overview" && <div className="rep-body">
        <section className="rep-card"><h2>סיכום</h2><div className="rep-metrics">
          {metric("נמענים", total)}
          {metric("נשלחו", sent, pct(sent, total))}
          {metric("נמסרו", deliveryKnown ? delivered : null, deliveryKnown ? pct(delivered, sent) : "", deliveryKnown ? AVAIL[report.availability.delivery] : "אין דיווחי מסירה מהספק")}
          {metric("נכשלו", failed, pct(failed, total))}
          {unknown > 0 && metric("דורש בדיקה", unknown, pct(unknown, total), "תוצאה לא ודאית מהספק")}
          {metric("דולגו", skipped, pct(skipped, total), "הסרות, חסימות, הסכמה, תדירות")}
          {report.channel === "email" && metric("פתיחות", report.availability.opens === "signal" ? report.engagement.opened : null, report.availability.opens === "signal" ? pct(report.engagement.opened, sent) : "", report.availability.opens === "signal" ? "אות מהספק – פתיחה אינה הוכחה לקריאה" : "הספק לא מדווח פתיחות")}
          {report.channel === "email" && metric("הקלקות ייחודיות", report.availability.clicks !== "unavailable" ? report.engagement.clicked : null, report.availability.clicks !== "unavailable" ? pct(report.engagement.clicked, sent) : "", report.availability.clicks !== "unavailable" ? "מעקב קישורים של המערכת" : "אין מעקב הקלקות")}
          {report.channel !== "email" && metric("נקראו", report.availability.delivery === "unavailable" ? null : report.delivery.READ ?? 0, report.availability.delivery === "unavailable" ? "" : pct(report.delivery.READ ?? 0, sent), report.availability.delivery === "unavailable" ? "אין דיווח מהספק" : undefined)}
          {report.channel !== "email" && metric("תשובות", report.availability.replies === "real" ? report.engagement.replies : null, "", report.availability.replies === "real" ? "" : "אין נתונים")}
          {metric("הסרות", report.engagement.unsubscribes, pct(report.engagement.unsubscribes, sent))}
        </div></section>
        <section className="rep-card"><h2>ביצועי מכירות</h2><p className="rep-empty">אין מנגנון ייחוס הכנסות לקמפיין במערכת. הכנסות, עסקאות והמרות יוצגו רק כשיחובר ייחוס אמיתי (למשל קישורים עם מזהה קמפיין שמגיעים לעסקאות).</p></section>
        <div className="rep-grid">
          <section className="rep-card"><h2>כשלים</h2>{failures.length ? <ul className="rep-list">{failures.map(([k, v]) => <li key={k}><span>{deliveryStatusLabels[k] ?? k}</span><strong>{v}</strong></li>)}{report.engagement.hardBounce + report.engagement.softBounce > 0 && <li><span>Bounce קשה / רך</span><strong>{report.engagement.hardBounce} / {report.engagement.softBounce}</strong></li>}</ul> : <p className="rep-empty">אין כשלים מדווחים</p>}</section>
          <section className="rep-card"><h2>קישורים מובילים</h2>{links ? (links.links.length ? <ul className="rep-list">{links.links.slice(0, 5).map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer" dir="ltr">{l.url.length > 60 ? l.url.slice(0, 60) + "…" : l.url}</a><strong>{l.uniqueClicks ?? "—"}</strong></li>)}</ul> : <p className="rep-empty">אין קישורים בתוכן</p>) : null}{links && <p className="rep-note">{links.note}</p>}</section>
          <section className="rep-card"><h2>עלות</h2>{report.cost.actual ? <p><strong>{report.cost.actual.amount} {report.cost.actual.currency ?? ""}</strong> ({report.cost.actual.messages} הודעות, נתון מהספק)</p> : report.cost.estimate?.known && report.cost.estimate.total !== null ? <p>אומדן: <strong>{report.cost.estimate.total} {report.cost.estimate.currency ?? ""}</strong> (לפי מחיר יחידה ידני)</p> : <p className="rep-empty">אין נתוני עלות</p>}</section>
        </div>
        <ul className="rep-notes">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>}
      {tab === "recipients" && <div className="rep-body">
        <div className="rep-filters"><input className="cmp-input" placeholder="חיפוש לפי שם, טלפון או אימייל" value={rq} onChange={(e) => { setRq(e.target.value); setPage(1); }} aria-label="חיפוש נמענים" /><select className="cmp-input" value={rs} onChange={(e) => { setRs(e.target.value); setPage(1); }} aria-label="סינון לפי תוצאה"><option value="">כל התוצאות</option>{Object.entries(recipientStatusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        {!recipients ? <p className="rep-empty">טוען…</p> : <><table className="rep-table"><thead><tr><th>שם</th><th>יעד</th><th>תוצאה</th><th>מסירה</th><th>שגיאה</th></tr></thead><tbody>{recipients.recipients.map((r) => <tr key={r.id}><td>{r.contact.name}</td><td dir="ltr">{r.identifier ?? r.contact.phone}</td><td>{recipientStatusLabels[r.status] ?? r.status}</td><td>{r.deliveryStatus ? deliveryStatusLabels[r.deliveryStatus] ?? r.deliveryStatus : "—"}</td><td className="text-bad">{r.deliveryError ?? (r.status === "SKIPPED" || r.status === "FAILED" ? r.error : "") ?? ""}</td></tr>)}</tbody></table>
          <footer className="rep-pager"><span>{recipients.total} נמענים</span><div><button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ הקודם</button><button disabled={page * 100 >= recipients.total} onClick={() => setPage((p) => p + 1)}>הבא ›</button></div></footer></>}
      </div>}
      {tab === "links" && <div className="rep-body"><section className="rep-card"><h2>קישורים בתוכן</h2>{links?.links.length ? <ul className="rep-list">{links.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer" dir="ltr">{l.url}</a><strong>{l.uniqueClicks ?? "—"}</strong></li>)}</ul> : <p className="rep-empty">אין קישורים בתוכן</p>}<p className="rep-note">{links?.note}{links?.totalUniqueClicks != null ? ` סה״כ נמענים שהקליקו: ${links.totalUniqueClicks}.` : ""}</p></section></div>}
    </div>
  );
}
