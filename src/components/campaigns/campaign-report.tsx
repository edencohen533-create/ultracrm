"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/components/i18n/LangProvider";
import { CHANNEL_LABELS, recipientStatusLabels, deliveryStatusLabels, CAMPAIGN_BUCKET_LABELS, campaignBucket } from "@/lib/campaign-shared";

type Report = { id: string; name: string; channel: string; status: string; scheduledAt?: string | null; audienceExcluded?: number; statusReason: string | null; simulated: boolean; recipients: Record<string, number>; delivery: Record<string, number>; engagement: { opened: number; clicked: number; complained: number; hardBounce: number; softBounce: number; replies: number | null; unsubscribes: number }; cost: { actual: { amount: number; currency: string | null; messages: number } | null; estimate: { total: number | null; currency: string | null; known: boolean } | null }; availability: Record<string, string>; notes: string[] };
type Recipient = { id: string; status: string; error: string | null; attempts: number; contact: { name: string; phone: string }; identifier: string | null; deliveryStatus?: string | null; deliveryError?: string | null };
type Links = { links: Array<{ url: string; uniqueClicks: number | null }>; totalUniqueClicks: number | null; perLinkTracking: boolean; note: string };
const AVAIL: Record<string, { he: string; en: string }> = { real: { he: "נתון מהספק", en: "Provider data" }, simulated: { he: "הדמיה", en: "Simulation" }, estimated: { he: "אומדן", en: "Estimate" }, partial: { he: "חלקי", en: "Partial" }, unavailable: { he: "אין נתונים", en: "No data" }, signal: { he: "אות מהספק", en: "Provider signal" } };
const pct = (n: number, d: number) => d ? `${(n / d * 100).toFixed(1)}%` : "—";

/** Campaign report: overview (metrics per channel + failures + links), recipients (search/filter), links. Zero ≠ unavailable. */
export function CampaignReport({ id }: { id: string }) {
  const t = useT();
  const [tab, setTab] = useState<"overview" | "recipients" | "links">("overview");
  const [report, setReport] = useState<Report | null>(null);
  const [links, setLinks] = useState<Links | null>(null);
  const [recipients, setRecipients] = useState<{ total: number; page: number; recipients: Recipient[] } | null>(null);
  const [rq, setRq] = useState(""); const [rs, setRs] = useState(""); const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetch(`/api/campaigns/${id}/report`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setReport(d); }).catch((e) => setError(e.message)); fetch(`/api/campaigns/${id}/links`).then((r) => r.json()).then(setLinks).catch(() => undefined); }, [id]);
  const loadRecipients = useCallback(() => { fetch(`/api/campaigns/${id}?page=${page}${rs ? `&status=${rs}` : ""}${rq.trim() ? `&q=${encodeURIComponent(rq.trim())}` : ""}`).then((r) => r.json()).then(setRecipients).catch(() => toast.error(t("לא ניתן לטעון נמענים", "Could not load recipients"))); }, [id, page, rs, rq, t]);
  useEffect(() => { if (tab === "recipients") { const timer = setTimeout(loadRecipients, 300); return () => clearTimeout(timer); } }, [tab, loadRecipients]);
  if (error) return <div className="p-8 text-bad">{error}</div>;
  if (!report) return <div className="p-8 text-muted">{t("טוען דוח…", "Loading report…")}</div>;
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
      <header className="rep-head"><nav className="rep-crumbs"><Link href={`/campaigns/${report.channel}`}>{t("קמפיינים", "Campaigns")}</Link><span>›</span><span>{CHANNEL_LABELS[report.channel]}</span><span>›</span><strong>{report.name}</strong></nav><div className="rep-status">{(() => { const b = campaignBucket({ status: report.status, statusReason: report.statusReason, counts: report.recipients, scheduledAt: report.scheduledAt }); return <span className={`cmp-badge ${b}`}>{b === "cancelled" ? t("בוטל", "Cancelled") : CAMPAIGN_BUCKET_LABELS[b]}</span>; })()}{report.simulated && <span className="cmp-badge failed">{t("הדמיה – לא נשלחו הודעות אמיתיות", "Simulation – no real messages were sent")}</span>}{report.statusReason && <span className="text-bad text-xs">{report.statusReason}</span>}</div></header>
      <div className="rep-tabs" role="tablist">{([["overview", "סקירה כללית", "Overview"], ["recipients", "נמענים", "Recipients"], ["links", "קישורים", "Links"]] as const).map(([k, l, en]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)} data-testid={`report-tab-${k}`}>{t(l, en)}</button>)}</div>
      {tab === "overview" && <div className="rep-body">
        <section className="rep-card"><h2>{t("סיכום", "Summary")}</h2><div className="rep-metrics">
          {metric(t("נמענים", "Recipients"), total)}
          {metric(t("נשלחו", "Sent"), sent, pct(sent, total))}
          {metric(t("נמסרו", "Delivered"), deliveryKnown ? delivered : null, deliveryKnown ? pct(delivered, sent) : "", deliveryKnown ? (AVAIL[report.availability.delivery] ? t(AVAIL[report.availability.delivery].he, AVAIL[report.availability.delivery].en) : undefined) : t("אין דיווחי מסירה מהספק", "No delivery reports from provider"))}
          {metric(t("נכשלו", "Failed"), failed, pct(failed, total))}
          {unknown > 0 && metric(t("דורש בדיקה", "Needs review"), unknown, pct(unknown, total), t("תוצאה לא ודאית מהספק", "Uncertain result from provider"))}
          {metric(t("דולגו", "Skipped"), skipped, pct(skipped, total), t("הסרות, חסימות, הסכמה, תדירות", "Unsubscribes, blocks, consent, frequency"))}
          {report.channel === "email" && metric(t("פתיחות", "Opens"), report.availability.opens === "signal" ? report.engagement.opened : null, report.availability.opens === "signal" ? pct(report.engagement.opened, sent) : "", report.availability.opens === "signal" ? t("אות מהספק – פתיחה אינה הוכחה לקריאה", "Provider signal – an open is not proof of reading") : t("הספק לא מדווח פתיחות", "Provider does not report opens"))}
          {report.channel === "email" && metric(t("הקלקות ייחודיות", "Unique clicks"), report.availability.clicks !== "unavailable" ? report.engagement.clicked : null, report.availability.clicks !== "unavailable" ? pct(report.engagement.clicked, sent) : "", report.availability.clicks !== "unavailable" ? t("מעקב קישורים של המערכת", "System link tracking") : t("אין מעקב הקלקות", "No click tracking"))}
          {report.channel !== "email" && metric(t("נקראו", "Read"), report.availability.delivery === "unavailable" ? null : report.delivery.READ ?? 0, report.availability.delivery === "unavailable" ? "" : pct(report.delivery.READ ?? 0, sent), report.availability.delivery === "unavailable" ? t("אין דיווח מהספק", "No provider report") : undefined)}
          {report.channel !== "email" && metric(t("תשובות", "Replies"), report.availability.replies === "real" ? report.engagement.replies : null, "", report.availability.replies === "real" ? "" : t("אין נתונים", "No data"))}
          {metric(t("הסרות", "Unsubscribes"), report.engagement.unsubscribes, pct(report.engagement.unsubscribes, sent))}
        </div></section>
        <section className="rep-card"><h2>{t("ביצועי מכירות", "Sales performance")}</h2><p className="rep-empty">{t("אין מנגנון ייחוס הכנסות לקמפיין במערכת. הכנסות, עסקאות והמרות יוצגו רק כשיחובר ייחוס אמיתי (למשל קישורים עם מזהה קמפיין שמגיעים לעסקאות).", "The system has no revenue attribution for campaigns. Revenue, deals and conversions will only be shown once real attribution is connected (e.g. links with a campaign ID that lead to deals).")}</p></section>
        <div className="rep-grid">
          <section className="rep-card"><h2>{t("כשלים", "Failures")}</h2>{failures.length ? <ul className="rep-list">{failures.map(([k, v]) => <li key={k}><span>{deliveryStatusLabels[k] ?? k}</span><strong>{v}</strong></li>)}{report.engagement.hardBounce + report.engagement.softBounce > 0 && <li><span>{t("Bounce קשה / רך", "Hard / soft bounce")}</span><strong>{report.engagement.hardBounce} / {report.engagement.softBounce}</strong></li>}</ul> : <p className="rep-empty">{t("אין כשלים מדווחים", "No reported failures")}</p>}</section>
          <section className="rep-card"><h2>{t("קישורים מובילים", "Top links")}</h2>{links ? (links.links.length ? <ul className="rep-list">{links.links.slice(0, 5).map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer" dir="ltr">{l.url.length > 60 ? l.url.slice(0, 60) + "…" : l.url}</a><strong>{l.uniqueClicks ?? "—"}</strong></li>)}</ul> : <p className="rep-empty">{t("אין קישורים בתוכן", "No links in content")}</p>) : null}{links && <p className="rep-note">{links.note}</p>}</section>
          <section className="rep-card"><h2>{t("עלות", "Cost")}</h2>{report.cost.actual ? <p><strong>{report.cost.actual.amount} {report.cost.actual.currency ?? ""}</strong> ({t(`${report.cost.actual.messages} הודעות, נתון מהספק`, `${report.cost.actual.messages} messages, provider data`)})</p> : report.cost.estimate?.known && report.cost.estimate.total !== null ? <p>{t("אומדן:", "Estimate:")} <strong>{report.cost.estimate.total} {report.cost.estimate.currency ?? ""}</strong> {t("(לפי מחיר יחידה ידני)", "(based on manual unit price)")}</p> : <p className="rep-empty">{t("אין נתוני עלות", "No cost data")}</p>}</section>
        </div>
        <ul className="rep-notes">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>}
      {tab === "recipients" && <div className="rep-body">
        <div className="rep-filters"><input className="cmp-input" placeholder={t("חיפוש לפי שם, טלפון או אימייל", "Search by name, phone or email")} value={rq} onChange={(e) => { setRq(e.target.value); setPage(1); }} aria-label={t("חיפוש נמענים", "Search recipients")} /><select className="cmp-input" value={rs} onChange={(e) => { setRs(e.target.value); setPage(1); }} aria-label={t("סינון לפי תוצאה", "Filter by result")}><option value="">{t("כל התוצאות", "All results")}</option>{Object.entries(recipientStatusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        {!recipients ? <p className="rep-empty">{t("טוען…", "Loading…")}</p> : <><table className="rep-table"><thead><tr><th>{t("שם", "Name")}</th><th>{t("יעד", "Destination")}</th><th>{t("תוצאה", "Result")}</th><th>{t("מסירה", "Delivery")}</th><th>{t("שגיאה", "Error")}</th></tr></thead><tbody>{recipients.recipients.map((r) => <tr key={r.id}><td>{r.contact.name}</td><td dir="ltr">{r.identifier ?? r.contact.phone}</td><td>{recipientStatusLabels[r.status] ?? r.status}</td><td>{r.deliveryStatus ? deliveryStatusLabels[r.deliveryStatus] ?? r.deliveryStatus : "—"}</td><td className="text-bad">{r.deliveryError ?? (r.status === "SKIPPED" || r.status === "FAILED" ? r.error : "") ?? ""}</td></tr>)}</tbody></table>
          <footer className="rep-pager"><span>{t(`${recipients.total} נמענים`, `${recipients.total} recipients`)}</span><div><button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("‹ הקודם", "‹ Previous")}</button><button disabled={page * 100 >= recipients.total} onClick={() => setPage((p) => p + 1)}>{t("הבא ›", "Next ›")}</button></div></footer></>}
      </div>}
      {tab === "links" && <div className="rep-body"><section className="rep-card"><h2>{t("קישורים בתוכן", "Links in content")}</h2>{links?.links.length ? <ul className="rep-list">{links.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer" dir="ltr">{l.url}</a><strong>{l.uniqueClicks ?? "—"}</strong></li>)}</ul> : <p className="rep-empty">{t("אין קישורים בתוכן", "No links in content")}</p>}<p className="rep-note">{links?.note}{links?.totalUniqueClicks != null ? t(` סה״כ נמענים שהקליקו: ${links.totalUniqueClicks}.`, ` Total recipients who clicked: ${links.totalUniqueClicks}.`) : ""}</p></section></div>}
    </div>
  );
}
