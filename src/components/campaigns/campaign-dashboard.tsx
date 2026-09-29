"use client";

import { AudienceEditor, AudiencePreview, type AudienceOptions } from "./audience-editor";
import { audienceSchema, defaultAudience, type AudienceNode } from "@/lib/audiences";
import { parseCsv } from "@/lib/contact-csv";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { campaignStatusLabels, recipientStatusLabels, deliveryStatusLabels, renderTemplate, templateParameterKeys, CHANNEL_LABELS } from "@/lib/campaigns";
import { smsMetrics } from "@/lib/sms";
import { mergeTagsOf } from "@/lib/merge-tags";
import { useT } from "@/components/i18n/LangProvider";

type ChannelKey = "whatsapp" | "sms" | "email";
interface Campaign {
  id: string; name: string; status: string; channel: ChannelKey; scheduledAt: string | null; statusReason: string | null; lastTestAt: string | null; estimate: { total: number | null; units: number; currency: string | null; known: boolean; segments: number | null } | null;
  list: { name: string }; template: { name: string }; _count: { recipients: number }; counts: Record<string, number>;
}
interface Recipient { id: string; status: string; deliveryStatus: string | null; deliveryError?: string | null; errorCode?: string | null; retryable?: boolean; attempts?: number; error: string | null; identifier: string | null; contact: { name: string; phone: string } }
interface ChannelTemplate { id: string; channel: string; name: string; category: string; body: string; subject: string | null }
interface Report { channel: ChannelKey; simulated: boolean; recipients: Record<string, number>; delivery: Record<string, number>; engagement: { opened: number; clicked: number; complained: number; hardBounce: number; softBounce: number; replies: number | null; unsubscribes: number }; cost: { actual: { amount: number; currency: string | null; messages: number } | null; estimate: { total: number | null; currency: string | null; known: boolean; units: number } | null }; availability: Record<string, string>; notes: string[] }
interface Props {
  initialCampaigns: Campaign[];
  lists: { id: string; name: string; segment?: unknown; members: { contactId: string }[]; _count: { members: number } }[];
  contacts: { id: string; name: string; phone: string; consentStatus: string }[];
  templates: { id: string; name: string; body: string; language?: string; headerFormat?: string | null; headerMediaAssetId?: string | null; buttons?: unknown; status?: string }[];
  channelTemplates: ChannelTemplate[];
  channels: { sms: { id: string; provider: string; simulated: boolean; sendingBlocked: boolean; status: string; senders: Array<{ value: string; type: string; inbound: boolean }>; testRecipients: string[]; unitPrice: number | null; currency: string | null; label: string } | null; email: { id: string; provider: string; simulated: boolean; sendingBlocked: boolean; status: string; domainStatus: string | null; sender: string; testRecipients: string[]; unitPrice: number | null; currency: string | null; label: string } | null };
  timezone: string;
  marketingWindow: { start: string; end: string; days: number[] };
  audienceOptions?: AudienceOptions;
  mock: boolean;
  /** "audiences" = distribution lists + contacts import only; "campaigns" = one channel's campaigns only (with `fixedChannel`). */
  mode?: "all" | "audiences" | "campaigns";
  fixedChannel?: ChannelKey;
  senders?: { id: string; label: string; displayPhoneNumber: string | null; isDefault: boolean; sendingBlocked: boolean }[];
}
const selectClass = "w-full rounded-md border bg-background p-2 text-sm";
const AVAIL: Record<string, { he: string; en: string }> = { real: { he: "נתון אמיתי", en: "Real data" }, simulated: { he: "הדמיה", en: "Simulation" }, estimated: { he: "אומדן", en: "Estimate" }, partial: { he: "חלקי", en: "Partial" }, signal: { he: "אות מהספק", en: "Provider signal" }, unavailable: { he: "לא זמין", en: "Unavailable" } };

/** Convert a datetime-local value entered in the business timezone into an ISO instant. */
function zonedToIso(local: string, tz: string) {
  const [d, t] = local.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIf = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  return new Date(guess - (asIf - guess)).toISOString();
}

export function CampaignDashboard({ initialCampaigns, lists, contacts, templates, channelTemplates, channels, timezone, marketingWindow, mock, senders = [], audienceOptions = { tags: [], agents: [], campaigns: [] }, mode = "all", fixedChannel }: Props) {
  const t = useT();
  const avail = (k: string) => AVAIL[k] ? t(AVAIL[k].he, AVAIL[k].en) : undefined;
  const router = useRouter();
  const [review, setReview] = useState<{ campaign: Campaign; action: string; eligible: number; totalQueued: number; audienceExcluded?: number; exclusions: Record<string, number>; blockers: string[]; samples: { name: string; body: string; subject?: string; phone: string }[]; sender: string; cost: { total: number | null; currency: string | null; known: boolean; units: number; segments: number | null } | null; sendWindow: { start: string; end: string; days: number[]; timezone: string; maxPerMinute: number } | null; simulated: boolean; timezone: string } | null>(null);
  const [campaignSearch, setCampaignSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"all" | ChannelKey>(fixedChannel ?? "all");
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [tab, setTab] = useState<"campaigns" | "lists">(mode === "audiences" ? "lists" : "campaigns");
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<ChannelKey>(fixedChannel ?? "whatsapp");
  const [name, setName] = useState("");
  const [providerCredentialId, setProviderCredentialId] = useState(senders.find((sender) => sender.isDefault)?.id || senders[0]?.id || "");
  const [senderId, setSenderId] = useState(channels.sms?.senders[0]?.value ?? "");
  const [segment, setSegment] = useState<AudienceNode | null>(null);
  const [excludedListIds, setExcludedListIds] = useState<string[]>([]);
  const [listId, setListId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [mediaUrl, setMediaUrl] = useState("");
  const [buttonParams, setButtonParams] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState<Record<string, string>>({});
  const [report, setReport] = useState<(Report & { name: string }) | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvMapping, setCsvMapping] = useState({ name: "name", phone: "phone", consentStatus: "consentStatus", consentEvidence: "consentEvidence" });
  const [csvPreview, setCsvPreview] = useState<{ valid: number; duplicateRows: number; errorCount: number; errors: { row: number; error: string }[]; samples: { name: string; phone: string; consentStatus: string }[] } | null>(null);
  const [csv, setCsv] = useState("");
  const [importName, setImportName] = useState("");
  const [listName, setListName] = useState("");
  const [editingList, setEditingList] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<{ id: string; name: string; total: number; page: number; recipients: Recipient[] } | null>(null);
  const segmentInvalid = !!segment && !audienceSchema.safeParse(segment).success;
  const waTemplate = templates.find((t) => t.id === templateId);
  const waHeader = (waTemplate?.headerFormat ?? "").toUpperCase();
  // An uploaded template image is sent by default – a link is then optional (overrides it).
  const waOwnImage = waHeader === "IMAGE" && waTemplate?.headerMediaAssetId ? `/api/media/${waTemplate.headerMediaAssetId}` : null;
  const waNeedsMedia = ["IMAGE", "VIDEO", "DOCUMENT"].includes(waHeader) && !waOwnImage;
  const waButtons = (Array.isArray(waTemplate?.buttons) ? waTemplate!.buttons : []) as Array<{ type: string; text: string; url?: string | null; dynamic?: boolean }>;
  const waDynamicButtons = waButtons.map((b, i) => ({ ...b, index: i })).filter((b) => b.type === "URL" && b.dynamic);
  const chTemplates = useMemo(() => channelTemplates.filter((t) => t.channel === channel), [channelTemplates, channel]);
  const chTemplate = chTemplates.find((t) => t.id === templateId);
  const filtered = contacts.filter((c) => `${c.name} ${c.phone}`.toLowerCase().includes(search.toLowerCase()));
  const channelReady = channel === "whatsapp" ? (mock || senders.some((s) => s.id === providerCredentialId && !s.sendingBlocked)) : channel === "sms" ? Boolean(channels.sms && !channels.sms.sendingBlocked && senderId) : Boolean(channels.email && !channels.email.sendingBlocked);
  const previewText = useMemo(() => {
    if (channel === "whatsapp") return waTemplate ? renderTemplate(waTemplate.body, variables).replaceAll("{name}", "ישראל") : t("בחר תבנית להצגת ההודעה", "Select a template to preview the message");
    if (!chTemplate) return t("בחר תבנית להצגת ההודעה", "Select a template to preview the message");
    const body = chTemplate.body.replace(/\{\{\s*(first_name|name)\s*(?:\|[^}]*)?\}\}/g, "ישראל").replace(/\{\{\s*([\w.]+)\s*\|([^}]*)\}\}/g, (_m, k: string, d: string) => variables[k] ?? d).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => variables[k] ?? `{{${k}}}`);
    const sender = channels.sms?.senders.find((s) => s.value === senderId);
    return channel === "sms" && chTemplate.category === "MARKETING" ? body + (sender?.inbound === false ? "\nלהסרה: https://…/u/…" : "\nלהסרה השיבו הסר") : body;
  }, [channel, waTemplate, chTemplate, variables, channels.sms, senderId, t]);
  const sms = channel === "sms" ? smsMetrics(previewText) : null;
  const extraTags = chTemplate ? mergeTagsOf(`${chTemplate.subject ?? ""} ${chTemplate.body}`).filter((t) => !["name", "first_name", "company", "city", "email", "phone", "unsubscribe_url"].includes(t.tag) && !t.tag.startsWith("custom.")) : [];

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/campaigns${campaignSearch.trim() ? `?q=${encodeURIComponent(campaignSearch.trim())}` : ""}`);
        if (response.ok) setCampaigns((await response.json()).campaigns);
      } catch { /* Keep the last successful snapshot during network interruptions. */ }
    }, 10000);
    return () => clearInterval(timer);
  }, [campaignSearch]);
  // Search also covers campaigns older than the latest 100 (server-side).
  useEffect(() => {
    const q = campaignSearch.trim();
    const timer = setTimeout(async () => { try { const r = await fetch(`/api/campaigns${q ? `?q=${encodeURIComponent(q)}` : ""}`); if (r.ok) setCampaigns((await r.json()).campaigns); } catch { /* ignore */ } }, 400);
    return () => clearTimeout(timer);
  }, [campaignSearch]);

  async function mutate(url: string, method: string, body: unknown) {
    setBusy(true);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : t("הפעולה נכשלה", "Action failed"));
      const refreshed = await fetch("/api/campaigns");
      if (refreshed.ok) setCampaigns((await refreshed.json()).campaigns);
      router.refresh();
      return true;
    } catch (error) { toast.error(error instanceof Error ? error.message : t("שגיאת תקשורת", "Network error")); return false; }
    finally { setBusy(false); }
  }
  async function showDetails(campaign: { id: string; name: string; total: number }, page = 1) {
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}?page=${page}`);
      if (!response.ok) throw new Error(t("לא ניתן לטעון את הנמענים", "Could not load recipients"));
      setDetail({ ...campaign, page, recipients: (await response.json()).recipients });
    } catch { toast.error(t("לא ניתן לטעון את הנמענים", "Could not load recipients")); }
  }
  async function showReport(campaign: Campaign) {
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/report`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setReport({ ...data, name: campaign.name });
    } catch (e) { toast.error((e as Error).message || t("לא ניתן לטעון דוח", "Could not load report")); }
  }
  async function action(campaign: Campaign, action: string, confirmed = false) {
    if (["start", "resume"].includes(action) && !confirmed) {
      setBusy(true);
      try {
        const response = await fetch(`/api/campaigns/${campaign.id}?preflight=1`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t("בדיקת הקמפיין נכשלה", "Campaign check failed"));
        setReview({ ...data, campaign, action });
      } catch (error) { toast.error(error instanceof Error ? error.message : t("בדיקת הקמפיין נכשלה", "Campaign check failed")); }
      finally { setBusy(false); }
      return;
    }
    const scheduledAt = action === "start" && schedule[campaign.id] ? zonedToIso(schedule[campaign.id], timezone) : undefined;
    if (await mutate(`/api/campaigns/${campaign.id}`, "PATCH", { action, scheduledAt, scheduledTimezone: scheduledAt ? timezone : undefined })) setReview(null);
  }
  async function retry(campaign: Campaign, r: Recipient) {
    const unknown = r.status === "UNKNOWN";
    if (unknown && !confirm(t("התוצאה לא ודאית: ייתכן שההודעה כבר נמסרה. נסה שוב רק אם בדקת אצל הספק שהיא לא נשלחה. לאשר?", "The result is uncertain: the message may already have been delivered. Only retry if you confirmed with the provider that it was not sent. Continue?"))) return;
    if (await mutate(`/api/campaigns/${campaign.id}`, "PATCH", { action: "retry_recipient", recipientId: r.id, confirmNotSent: unknown })) { toast.success(t("הנמען הוחזר לתור – ייבדק מחדש וישלח בסבב הבא", "Recipient returned to the queue – will be re-checked and sent in the next round")); if (detail) showDetails(detail, detail.page); }
  }
  async function sendTest(campaign: Campaign) {
    setBusy(true);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: testTo[campaign.id] ?? "" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("שליחת הבדיקה נכשלה", "Test send failed"));
      toast.success(data.data?.simulated ? t("הדמיה: הודעת בדיקה נשלחה", "Simulation: test message sent") : t("הודעת בדיקה נשלחה", "Test message sent"));
      const refreshed = await fetch("/api/campaigns"); if (refreshed.ok) setCampaigns((await refreshed.json()).campaigns);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const visible = campaigns.filter((c) => (channelFilter === "all" || c.channel === channelFilter) && `${c.name} ${c.list.name} ${c.template.name}`.toLowerCase().includes(campaignSearch.toLowerCase()));
  const estimateText = (e: Campaign["estimate"]) => !e ? null : e.known && e.total !== null ? t(`אומדן עלות: ${e.total} ${e.currency ?? ""} (${e.units} יחידות)`, `Estimated cost: ${e.total} ${e.currency ?? ""} (${e.units} units)`) : t(`עלות: לא ידועה (${e.units} יחידות – הגדר מחיר ליחידה בחיבור)`, `Cost: unknown (${e.units} units – set a unit price in the connection)`);

  return <div className="mx-auto max-w-6xl space-y-6 p-6" dir={t.dir}>
    {mode !== "all" && <nav className="campaigns-nav" aria-label={t("קמפיינים", "Campaigns")} data-testid="campaigns-nav">
      <div className="campaigns-tabs" role="tablist">{(["whatsapp", "email", "sms"] as ChannelKey[]).map((ch) => <a key={ch} role="tab" href={`/campaigns/${ch}`} aria-selected={mode === "campaigns" && fixedChannel === ch} className={mode === "campaigns" && fixedChannel === ch ? "active" : ""} data-testid={`campaigns-tab-${ch}`}>{CHANNEL_LABELS[ch]}</a>)}</div>
      <div className="campaigns-secondary"><a href="/audiences" className={mode === "audiences" ? "active" : ""} data-testid="campaigns-audiences">{t("קהלים ואנשי קשר", "Audiences & contacts")}</a><a href="/templates" data-testid="campaigns-templates">{t("תבניות", "Templates")}</a></div>
    </nav>}
    <div><h1 className="text-2xl font-bold">{mode === "audiences" ? t("קהלים ואנשי קשר", "Audiences & contacts") : fixedChannel ? t(`קמפיין ${CHANNEL_LABELS[fixedChannel]}`, `${CHANNEL_LABELS[fixedChannel]} campaign`) : t("קמפיינים ורשימות תפוצה", "Campaigns & distribution lists")}</h1><p className="mt-1 text-sm text-muted-foreground">{mode === "audiences" ? t("רשימות תפוצה, פילוחים וייבוא אנשי קשר – משמשים את כל הערוצים (WhatsApp, SMS ואימייל) עם אותה רשימת הסרה גלובלית.", "Distribution lists, segments and contact import – used by all channels (WhatsApp, SMS and email) with the same global unsubscribe list.") : t(`אותם אנשי קשר, אותה רשימת הסרה גלובלית, תזמון לפי אזור הזמן של העסק (${timezone}).`, `Same contacts, same global unsubscribe list, scheduling in the business time zone (${timezone}).`)}</p></div>
    {review && <section role="region" aria-label={t("סיכום לפני שליחה", "Pre-send summary")} className="space-y-3 rounded-xl border-2 p-5" data-testid="campaign-review"><h2 className="font-semibold">{t("סיכום לפני שליחה", "Pre-send summary")} — {review.campaign.name} · {CHANNEL_LABELS[review.campaign.channel]}</h2><p>{t(`${review.eligible} זכאים מתוך ${review.totalQueued} שטרם נשלחו. שולח: ${review.sender}`, `${review.eligible} eligible out of ${review.totalQueued} not yet sent. Sender: ${review.sender}`)}{review.simulated && <strong>{t(" · הדמיה – לא נשלחות הודעות אמיתיות", " · Simulation – no real messages are sent")}</strong>}</p>{!!review.audienceExcluded && <p>{t(`${review.audienceExcluded} הוחרגו בעת יצירת הטיוטה ונשמרו במצב דולג.`, `${review.audienceExcluded} were excluded when the draft was created and saved as skipped.`)}</p>}<p>{t("מועד:", "Time:")} {schedule[review.campaign.id] || t("מיידי", "Immediate")} · {t("אזור זמן העסק:", "Business time zone:")} {review.timezone}{review.sendWindow ? t(` · חלון שליחה ${review.sendWindow.start}–${review.sendWindow.end}`, ` · Send window ${review.sendWindow.start}–${review.sendWindow.end}`) + (review.sendWindow.maxPerMinute ? t(` · עד ${review.sendWindow.maxPerMinute} לדקה`, ` · up to ${review.sendWindow.maxPerMinute} per minute`) : "") : ""}</p><p>{t("הקהל הוקפא בעת יצירת הטיוטה. חסימות, הסרות והסכמה נבדקות שוב לפני כל שליחה. מגבלת תדירות משותפת לכל הערוצים.", "The audience was frozen when the draft was created. Blocks, unsubscribes and consent are re-checked before every send. The frequency cap is shared across all channels.")}</p>{review.cost && <p data-testid="review-cost">{review.cost.known && review.cost.total !== null ? t(`אומדן עלות: ${review.cost.total} ${review.cost.currency ?? ""} (${review.cost.units} יחידות${review.cost.segments ? `, ${review.cost.segments} מקטעים לנמען` : ""}) – אומדן בלבד לפי מחיר יחידה שהוגדר ידנית`, `Estimated cost: ${review.cost.total} ${review.cost.currency ?? ""} (${review.cost.units} units${review.cost.segments ? `, ${review.cost.segments} segments per recipient` : ""}) – estimate only, based on a manually set unit price`) : t(`עלות: לא ידועה – לא הוגדר מחיר יחידה בחיבור (${review.cost.units} יחידות)`, `Cost: unknown – no unit price set in the connection (${review.cost.units} units)`)}</p>}{Object.entries(review.exclusions).map(([reason, count]) => <p key={reason}>{reason}: {count}</p>)}{review.blockers.map((reason) => <p key={reason} role="alert" className="text-destructive">{reason}</p>)}{review.samples.map((sample, i) => <div key={i} className="whitespace-pre-wrap rounded bg-muted p-3"><strong>{sample.name}</strong> <span dir="ltr" className="text-xs text-muted-foreground">{sample.phone}</span>{sample.subject && <p className="font-medium">{t("נושא:", "Subject:")} {sample.subject}</p>}<p>{sample.body}</p></div>)}<Button disabled={busy || !!review.blockers.length || !review.eligible} onClick={() => action(review.campaign, review.action, true)}>{t("אשר והפעל", "Confirm & start")}</Button><Button variant="ghost" onClick={() => setReview(null)}>{t("סגור סיכום", "Close summary")}</Button></section>}
    {report && <section className="space-y-3 rounded-xl border-2 p-5" data-testid="campaign-report"><div className="flex items-center justify-between"><h2 className="font-semibold">{t("דוח", "Report")} — {report.name} · {CHANNEL_LABELS[report.channel]}{report.simulated && t(" · הדמיה", " · Simulation")}</h2><Button variant="ghost" onClick={() => setReport(null)}>{t("סגור", "Close")}</Button></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("נמענים", "Recipients")}</p>{Object.entries(report.recipients).map(([k, v]) => <p key={k}>{recipientStatusLabels[k] ?? k}: <b>{v}</b></p>)}</div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("מסירה", "Delivery")} ({avail(report.availability.delivery)})</p>{Object.entries(report.delivery).map(([k, v]) => <p key={k}>{deliveryStatusLabels[k] ?? k}: <b>{v}</b></p>)}{!Object.keys(report.delivery).length && <p>—</p>}</div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("תגובות והסרות", "Replies & unsubscribes")}</p><p>{t("תשובות:", "Replies:")} <b>{report.engagement.replies ?? t("לא זמין", "Unavailable")}</b> ({avail(report.availability.replies)})</p><p>{t("הסרות:", "Unsubscribes:")} <b>{report.engagement.unsubscribes}</b></p>{report.channel === "email" && <><p>{t("פתיחות:", "Opens:")} <b>{report.availability.opens === "unavailable" ? t("לא זמין", "Unavailable") : report.engagement.opened}</b> ({avail(report.availability.opens)})</p><p>{t("הקלקות:", "Clicks:")} <b>{report.availability.clicks === "unavailable" ? t("לא זמין", "Unavailable") : report.engagement.clicked}</b> ({avail(report.availability.clicks)})</p><p>{t("תלונות ספאם:", "Spam complaints:")} <b>{report.engagement.complained}</b> · {t("bounce קשיח/רך:", "Hard/soft bounce:")} <b>{report.engagement.hardBounce}/{report.engagement.softBounce}</b></p></>}</div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("עלות", "Cost")} ({avail(report.availability.cost)})</p>{report.cost.actual ? <p>{t("בפועל:", "Actual:")} <b>{report.cost.actual.amount} {report.cost.actual.currency ?? ""}</b> ({t(`${report.cost.actual.messages} הודעות`, `${report.cost.actual.messages} messages`)})</p> : null}{report.cost.estimate?.known && report.cost.estimate.total !== null ? <p>{t("אומדן:", "Estimate:")} {report.cost.estimate.total} {report.cost.estimate.currency ?? ""}</p> : !report.cost.actual ? <p>{t("לא זמין", "Unavailable")}</p> : null}</div>
      </div>
      <ul className="list-disc pe-5 text-xs text-muted-foreground">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </section>}
    {mock && channel === "whatsapp" && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">{t("מצב הדגמה פעיל ב-WhatsApp — הודעות מדומות בלבד. לשליחה אמיתית יש לחבר WhatsApp בהגדרות.", "WhatsApp demo mode is active — simulated messages only. Connect WhatsApp in Settings to send for real.")}</div>}
    {mode === "all" && <div className="flex gap-2"><Button variant={tab === "campaigns" ? "default" : "outline"} onClick={() => setTab("campaigns")}>{t("קמפיינים", "Campaigns")}</Button><Button variant={tab === "lists" ? "default" : "outline"} onClick={() => setTab("lists")}>{t("רשימות תפוצה", "Distribution lists")} ({lists.length})</Button></div>}
    {tab === "lists" ? <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-4 rounded-xl border p-5"><h2 className="font-semibold">{editingList ? t("עריכת רשימת תפוצה", "Edit distribution list") : t("רשימת תפוצה חדשה", "New distribution list")}</h2>
        <label className="block space-y-1"><span>{t("שם הרשימה", "List name")}</span><Input aria-label={t("שם רשימת תפוצה", "Distribution list name")} value={listName} onChange={(e) => setListName(e.target.value)} maxLength={120} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!segment} onChange={(event) => setSegment(event.target.checked ? defaultAudience() : null)} />{t("קהל שמור לפי תנאים", "Saved audience by conditions")}</label>
        <p className="text-xs text-muted-foreground">{t("תנאים מחושבים ביצירת טיוטת קמפיין. רשימת הנמענים מוקפאת בטיוטה; חסימות והסרות נבדקות שוב בכל שליחה. עד 10,000 נמענים בקמפיין.", "Conditions are evaluated when a campaign draft is created. The recipient list is frozen in the draft; blocks and unsubscribes are re-checked on every send. Up to 10,000 recipients per campaign.")}</p>
        {segmentInvalid && <p role="alert" className="text-sm text-destructive">{t("יש להשלים ערכים תקינים בכל התנאים. מותר לשמור עד 50 תנאים וקבוצות, בשלוש רמות, וטקסט עד 200 תווים.", "Fill in valid values for all conditions. Up to 50 conditions and groups, three levels deep, and text up to 200 characters.")}</p>}
        {segment ? <><AudienceEditor value={segment} onChange={setSegment} options={audienceOptions} /><AudiencePreview segment={segment} /></> : <>
        <Input aria-label={t("חיפוש אנשי קשר", "Search contacts")} placeholder={t("חיפוש לפי שם או טלפון", "Search by name or phone")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <p className="text-sm text-muted-foreground">{t(`${selected.length} נבחרו. רק נמענים עם הסכמה פעילה יקבלו הודעות. מוצגים עד 1,000 אנשי קשר.`, `${selected.length} selected. Only recipients with active consent will receive messages. Up to 1,000 contacts are shown.`)}</p>
        <Button variant="outline" onClick={() => setSelected([...new Set([...selected, ...filtered.filter((c) => c.consentStatus === "OPTED_IN").map((c) => c.id)])])}>{t("בחר את כל המסכימים בתוצאות", "Select all opted-in in results")}</Button>
        <div className="max-h-72 space-y-2 overflow-y-auto">{filtered.map((contact) => <label key={contact.id} className="flex items-center gap-3 rounded border p-2 text-sm"><input type="checkbox" checked={selected.includes(contact.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, contact.id] : selected.filter((id) => id !== contact.id))} /><span className="flex-1">{contact.name} <span dir="ltr" className="text-muted-foreground">{contact.phone}</span></span><span>{contact.consentStatus === "OPTED_IN" ? t("מאשר דיוור", "Opted in") : contact.consentStatus === "OPTED_OUT" ? t("הוסר מדיוור", "Opted out") : t("ללא הסכמה", "No consent")}</span></label>)}</div>
        </>}
        <div className="flex gap-2"><Button disabled={busy || !listName.trim() || (segment ? segmentInvalid : !selected.length)} onClick={async () => {
          if (await mutate(editingList ? `/api/distribution-lists/${editingList}` : "/api/distribution-lists", editingList ? "PUT" : "POST", { name: listName, contactIds: segment ? [] : selected, segment })) { setListName(""); setSelected([]); setSegment(null); setEditingList(null); toast.success(t("הרשימה נשמרה", "List saved")); }
        }}>{t("שמור רשימה", "Save list")}</Button>{editingList && <Button variant="outline" onClick={() => { setEditingList(null); setListName(""); setSelected([]); setSegment(null); }}>{t("ביטול עריכה", "Cancel editing")}</Button>}</div>
      </section>
      <section className="space-y-3"><div className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">{t("ייבוא רשימה מ־CSV", "Import list from CSV")}</h2><p className="text-sm text-muted-foreground">{t("עד 10,000 שורות, עם כותרות name,phone ועמודת consentStatus אופציונלית. הערך OPTED_IN מציין הסכמה קיימת לדיוור; ללא ערך, הנמען לא יקבל קמפיינים. פרטי אנשי קשר קיימים והסכמתם נשמרים.", "Up to 10,000 rows, with name,phone headers and an optional consentStatus column. OPTED_IN marks existing marketing consent; without a value, the recipient will not receive campaigns. Existing contact details and consent are preserved.")}</p><Input aria-label={t("שם הרשימה המיובאת", "Imported list name")} placeholder={t("שם הרשימה", "List name")} value={importName} onChange={(e) => setImportName(e.target.value)} maxLength={120} /><Input aria-label={t("קובץ אנשי קשר CSV", "Contacts CSV file")} type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; setCsv(""); setCsvPreview(null); setCsvHeaders([]); if (!file) return; if (file.size > 1000000) { toast.error(t("הקובץ גדול מדי (עד 1MB)", "File is too large (max 1MB)")); return; } try { const text = await file.text(); setCsv(text); setCsvHeaders(parseCsv(text)[0] ?? []); } catch { toast.error(t("קריאת הקובץ נכשלה", "Failed to read the file")); } }} /><pre dir="ltr" className="overflow-auto rounded bg-muted p-2 text-xs">{"name,phone,consentStatus\nישראל,0501234567,OPTED_IN"}</pre>{csvHeaders.length > 0 && <div className="space-y-2">{(["name", "phone", "consentStatus", "consentEvidence"] as const).map((key) => <label key={key} className="block">{t(`מיפוי ${key}`, `Map ${key}`)}<select aria-label={t(`עמודת ${key}`, `${key} column`)} className={selectClass} value={csvMapping[key]} onChange={(e) => { setCsvMapping({ ...csvMapping, [key]: e.target.value }); setCsvPreview(null); }}><option value="">{t("ללא עמודה", "No column")}</option>{csvHeaders.map((header, i) => <option key={i} value={header}>{header}</option>)}</select></label>)}<Button variant="outline" disabled={busy || !importName.trim()} onClick={async () => { setBusy(true); try { const response = await fetch("/api/distribution-lists/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: importName, csv, mapping: csvMapping, preview: true }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setCsvPreview(data); } catch (error) { toast.error(error instanceof Error ? error.message : t("הבדיקה נכשלה", "Check failed")); } finally { setBusy(false); } }}>{t("בדוק והצג תצוגה מקדימה", "Check & preview")}</Button></div>}{csvPreview && <div role="status" className="space-y-1 text-sm"><p>{t(`${csvPreview.valid} ייחודיים תקינים, ${csvPreview.duplicateRows} כפולים, ${csvPreview.errorCount} שגיאות. אין שינוי בהסכמת אנשי קשר קיימים.`, `${csvPreview.valid} valid unique, ${csvPreview.duplicateRows} duplicates, ${csvPreview.errorCount} errors. Existing contacts' consent is unchanged.`)}</p>{csvPreview.errors.map((error) => <p key={error.row}>{error.error}</p>)}{csvPreview.samples.map((sample) => <p key={sample.phone}>{sample.name} · <span dir="ltr">{sample.phone}</span> · {sample.consentStatus}</p>)}</div>}<Button disabled={busy || !importName.trim() || !csv || !csvPreview || !!csvPreview.errorCount} onClick={async () => { if (await mutate("/api/distribution-lists/import", "POST", { name: importName, csv, mapping: csvMapping })) { setImportName(""); setCsv(""); toast.success(t("הרשימה יובאה בהצלחה", "List imported successfully")); } }}>{t("ייבא רשימה", "Import list")}</Button></div><h2 className="font-semibold">{t("הרשימות שלי", "My lists")}</h2>{!lists.length && <p className="text-muted-foreground">{t("צור רשימה ראשונה כדי להתחיל.", "Create your first list to get started.")}</p>}{lists.map((list) => <div key={list.id} className="flex items-center justify-between rounded-xl border p-4"><div><p className="font-medium">{list.name}</p><p className="text-sm text-muted-foreground">{list.segment ? t("קהל דינמי לפי תנאים", "Dynamic audience by conditions") : t(`${list._count.members} אנשי קשר`, `${list._count.members} contacts`)}</p></div><Button variant="outline" onClick={() => { const parsed = list.segment ? audienceSchema.safeParse(list.segment) : null; if (parsed && !parsed.success) { toast.error(t("לא ניתן לקרוא את תנאי הקהל", "Could not read the audience conditions")); return; } setSegment(parsed?.success ? parsed.data : null); setEditingList(list.id); setListName(list.name); setSelected(list.members.map((m) => m.contactId)); }}>{t("עריכה", "Edit")}</Button></div>)}</section>
    </div> : <>
      <section className="grid gap-5 rounded-xl border p-5 lg:grid-cols-2">
        <div className="space-y-3"><h2 className="font-semibold">{t("קמפיין חדש", "New campaign")}</h2>
          {!fixedChannel && <div className="flex gap-2" role="tablist" aria-label={t("ערוץ", "Channel")}>{(["whatsapp", "sms", "email"] as ChannelKey[]).map((ch) => <Button key={ch} type="button" size="sm" variant={channel === ch ? "default" : "outline"} onClick={() => { setChannel(ch); setTemplateId(""); setVariables({}); }} data-testid={`channel-${ch}`}>{CHANNEL_LABELS[ch]}</Button>)}</div>}
          {channel === "sms" && !channels.sms && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{t("אין ספק SMS מחובר.", "No SMS provider connected.")} <a className="underline" href="/settings/sms">{t("חבר ספק בהגדרות", "Connect a provider in Settings")}</a>.</p>}
          {channel === "email" && !channels.email && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{t("אין ספק אימייל מחובר.", "No email provider connected.")} <a className="underline" href="/settings/email">{t("חבר ספק בהגדרות", "Connect a provider in Settings")}</a>.</p>}
          {channel === "email" && channels.email && !channels.email.simulated && channels.email.domainStatus !== "verified" && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{t(`הדומיין השולח טרם אומת (${channels.email.domainStatus ?? "לא הוגדר"}). שליחה אמיתית תיחסם עד לאימות.`, `The sending domain is not verified yet (${channels.email.domainStatus ?? "not set"}). Real sending is blocked until verification.`)}</p>}
          {(channel === "sms" ? channels.sms?.simulated : channel === "email" ? channels.email?.simulated : false) && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{t(`ספק ${CHANNEL_LABELS[channel]} במצב הדמיה – לא נשלחות הודעות אמיתיות.`, `${CHANNEL_LABELS[channel]} provider is in simulation mode – no real messages are sent.`)}</p>}
          <label className="block space-y-1"><span>{t("שם הקמפיין", "Campaign name")}</span><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
          <label className="block space-y-1"><span>{t("רשימת תפוצה", "Distribution list")}</span><select aria-label={t("רשימת תפוצה לקמפיין", "Campaign distribution list")} className={selectClass} value={listId} onChange={(e) => setListId(e.target.value)}><option value="">{t("בחר רשימה", "Select list")}</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name} ({list.segment ? t("תנאים שמורים", "Saved conditions") : list._count.members})</option>)}</select></label>
          <label className="block space-y-1"><span>{t("החרגת קהלים (בחירה מרובה)", "Exclude audiences (multi-select)")}</span><select multiple aria-label={t("קהלים להחרגה", "Audiences to exclude")} className={selectClass} value={excludedListIds} onChange={(event) => setExcludedListIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
          {listId && <AudiencePreview listId={listId} excludedListIds={excludedListIds} />}
          {channel === "whatsapp" && <label className="block space-y-1"><span>{t("מספר שולח", "Sender number")}</span><select aria-label={t("מספר שולח לקמפיין", "Campaign sender number")} className={selectClass} value={providerCredentialId} onChange={(event) => setProviderCredentialId(event.target.value)}>{mock ? <option value="">{t("הדגמה בלבד — לא נשלחות הודעות WhatsApp", "Demo only — no WhatsApp messages are sent")}</option> : senders.map((sender) => <option key={sender.id} value={sender.id} disabled={sender.sendingBlocked}>{sender.label}{sender.displayPhoneNumber ? ` · ${sender.displayPhoneNumber}` : ""}{sender.sendingBlocked ? t(" — חסום", " — blocked") : ""}</option>)}</select></label>}
          {channel === "sms" && channels.sms && <label className="block space-y-1"><span>{t("שולח מאושר", "Approved sender")}</span><select aria-label={t("שולח SMS", "SMS sender")} className={selectClass} value={senderId} onChange={(e) => setSenderId(e.target.value)}>{channels.sms.senders.map((s) => <option key={s.value} value={s.value}>{s.value}{s.type === "alphanumeric" ? t(" (אלפאנומרי – ללא תשובות)", " (alphanumeric – no replies)") : s.inbound ? t(" (קולט תשובות)", " (accepts replies)") : ""}</option>)}{!channels.sms.senders.length && <option value="">{t("אין שולח מאושר – בדוק את החיבור", "No approved sender – check the connection")}</option>}</select></label>}
          {channel === "email" && channels.email && <p className="text-sm">{t("שולח:", "Sender:")} <span dir="ltr">{channels.email.sender}</span></p>}
          <label className="block space-y-1"><span>{channel === "whatsapp" ? t("תבנית מאושרת", "Approved template") : t("תבנית", "Template")}</span><select className={selectClass} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVariables({}); }} data-testid="campaign-template"><option value="">{t("בחר תבנית", "Select template")}</option>{channel === "whatsapp" ? templates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}{tp.language ? ` (${tp.language})` : ""}</option>) : chTemplates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name} ({tp.category === "MARKETING" ? t("שיווקי", "Marketing") : t("שירות", "Service")})</option>)}</select></label>
          {channel === "whatsapp" && waTemplate && templateParameterKeys(waTemplate.body).map((key) => <label key={key} className="block space-y-1"><span>{t(`משתנה ${key}`, `Variable ${key}`)}</span><Input value={variables[key] ?? ""} onChange={(e) => setVariables({ ...variables, [key]: e.target.value })} placeholder={t("{name}, {{first_name|לקוח}}, {{company|-}}, {{custom.שדה|ברירת מחדל}}", "{name}, {{first_name|customer}}, {{company|-}}, {{custom.field|default}}")} maxLength={1024} /></label>)}
          {channel === "whatsapp" && waNeedsMedia && <label className="block space-y-1"><span>{t("קובץ מדיה לכותרת", "Header media file")} ({waHeader === "IMAGE" ? t("תמונה", "Image") : waHeader === "VIDEO" ? t("וידאו", "Video") : t("מסמך", "Document")}) – {t("קישור https ציבורי", "public https link")}</span><Input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} dir="ltr" placeholder="https://…" maxLength={2000} data-testid="campaign-media-url" /></label>}
          {channel === "whatsapp" && waDynamicButtons.map((b) => <label key={b.index} className="block space-y-1"><span>{t(`כפתור "${b.text}" – סיומת הקישור (${b.url})`, `Button "${b.text}" – link suffix (${b.url})`)}</span><Input value={buttonParams[String(b.index)] ?? ""} onChange={(e) => setButtonParams({ ...buttonParams, [String(b.index)]: e.target.value })} dir="ltr" maxLength={500} /></label>)}
          {channel !== "whatsapp" && extraTags.map(({ tag, fallback }) => <label key={tag} className="block space-y-1"><span>{t("ערך ל-", "Value for ")}{`{{${tag}}}`}{fallback !== null ? t(` (ברירת מחדל: ${fallback || "ריק"})`, ` (default: ${fallback || "empty"})`) : ""}</span><Input value={variables[tag] ?? ""} onChange={(e) => setVariables({ ...variables, [tag]: e.target.value })} maxLength={1024} /></label>)}
          <Button disabled={busy || !channelReady || !name.trim() || !listId || (channel === "whatsapp" ? !waTemplate || templateParameterKeys(waTemplate.body).some((key) => !variables[key]?.trim()) || (waNeedsMedia && !/^https:\/\//.test(mediaUrl)) || waDynamicButtons.some((b) => !buttonParams[String(b.index)]?.trim()) : !chTemplate || extraTags.some((t) => t.fallback === null && !variables[t.tag]?.trim()))} onClick={async () => { if (await mutate("/api/campaigns", "POST", { channel, name, listId, excludedListIds, templateId, variables: Object.fromEntries(Object.entries(variables).filter(([, v]) => v.trim())), providerCredentialId: channel === "whatsapp" ? (providerCredentialId || null) : (channel === "sms" ? channels.sms?.id : channels.email?.id) ?? null, senderId: channel === "sms" ? senderId || null : null, mediaUrl: channel === "whatsapp" && waNeedsMedia ? mediaUrl : null, buttonParams: channel === "whatsapp" && waDynamicButtons.length ? buttonParams : null })) { setName(""); toast.success(t("הטיוטה נשמרה. ניתן לשלוח בדיקה, להתחיל או לתזמן שליחה", "Draft saved. You can send a test, start, or schedule sending")); } }} data-testid="campaign-save">{t("שמור טיוטה", "Save draft")}</Button>
        </div>
        <div className="space-y-3"><h3 className="text-sm font-medium">{t("תצוגה מקדימה", "Preview")}</h3>{channel === "email" && chTemplate?.subject && <p className="text-sm"><b>{t("נושא:", "Subject:")}</b> {chTemplate.subject}</p>}<div className={`min-h-32 whitespace-pre-wrap rounded-xl p-4 ${channel === "whatsapp" ? "bg-emerald-50 text-emerald-950" : channel === "sms" ? "bg-sky-50 text-sky-950" : "bg-violet-50 text-violet-950"}`} data-testid="campaign-preview">{channel === "whatsapp" && waOwnImage && <div className="mb-2 rounded-lg border border-emerald-300 bg-white/60 p-2 text-xs"><img src={waOwnImage} alt="" className="max-h-40 rounded" /></div>}{channel === "whatsapp" && waNeedsMedia && <div className="mb-2 rounded-lg border border-emerald-300 bg-white/60 p-2 text-xs">{mediaUrl ? (waHeader === "IMAGE" ? <img src={mediaUrl} alt="" className="max-h-40 rounded" /> : <span dir="ltr">📎 {mediaUrl}</span>) : waHeader === "IMAGE" ? t("[כותרת תמונה – חסר קישור]", "[Image header – missing link]") : waHeader === "VIDEO" ? t("[כותרת וידאו – חסר קישור]", "[Video header – missing link]") : t("[כותרת מסמך – חסר קישור]", "[Document header – missing link]")}</div>}{previewText}{channel === "whatsapp" && waButtons.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{waButtons.map((b, i) => <span key={i} className="rounded-full border border-emerald-400 bg-white px-3 py-1 text-xs">{b.type === "URL" ? "🔗 " : b.type === "PHONE_NUMBER" ? "📞 " : ""}{b.text}{b.type === "URL" && b.dynamic ? ` → ${(b.url ?? "").replace(/\{\{\d+\}\}/, buttonParams[String(i)] || "…")}` : ""}</span>)}</div>}</div>
          {sms && chTemplate && <p className="text-xs text-muted-foreground" data-testid="sms-estimate">{t(`קידוד ${sms.encoding} · ${sms.length} תווים · ${sms.segments} מקטעים לנמען`, `${sms.encoding} encoding · ${sms.length} characters · ${sms.segments} segments per recipient`)}{channels.sms?.unitPrice != null ? t(` · אומדן ${(sms.segments * channels.sms.unitPrice).toFixed(4)} ${channels.sms.currency ?? ""} לנמען (מחיר יחידה ידני)`, ` · est. ${(sms.segments * channels.sms.unitPrice).toFixed(4)} ${channels.sms.currency ?? ""} per recipient (manual unit price)`) : t(" · מחיר לא ידוע – הגדר מחיר ליחידה בחיבור", " · price unknown – set a unit price in the connection")}</p>}
          {channel === "email" && chTemplate && <p className="text-xs text-muted-foreground">{channels.email?.unitPrice != null ? t(`אומדן ${channels.email.unitPrice} ${channels.email.currency ?? ""} לאימייל (מחיר יחידה ידני)`, `Est. ${channels.email.unitPrice} ${channels.email.currency ?? ""} per email (manual unit price)`) : t("מחיר לא ידוע – הגדר מחיר ליחידה בחיבור", "Price unknown – set a unit price in the connection")} · {t("קישור הסרה גלובלי מתווסף אוטומטית", "A global unsubscribe link is added automatically")}</p>}
          <p className="text-sm text-muted-foreground">{t("הנמענים נשמרים בעת יצירת הטיוטה. הסכמה, הסרות ומגבלת תדירות נבדקות מחדש בזמן השליחה. עצירה אינה מבטלת הודעה שכבר הועברה לספק.", "Recipients are saved when the draft is created. Consent, unsubscribes and the frequency cap are re-checked at send time. Stopping does not cancel a message already handed to the provider.")}</p>
          {channel !== "whatsapp" && <p className="text-xs text-muted-foreground">{t("בדיקת שליחה: לאחר שמירת הטיוטה, שלח לנמען בדיקה שהוגדר בחיבור", "Test send: after saving the draft, send to a test recipient configured in the connection")} ({(channel === "sms" ? channels.sms?.testRecipients : channels.email?.testRecipients)?.join(", ") || t("לא הוגדרו נמעני בדיקה", "no test recipients configured")}).</p>}
        </div>
      </section>
      <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{t("הקמפיינים שלי", "My campaigns")}</h2>{!fixedChannel && <div className="flex gap-1 ms-auto">{(["all", "whatsapp", "sms", "email"] as const).map((k) => <Button key={k} size="sm" variant={channelFilter === k ? "default" : "outline"} onClick={() => setChannelFilter(k)} data-testid={`filter-${k}`}>{k === "all" ? t("הכל", "All") : CHANNEL_LABELS[k]}</Button>)}</div>}</div>{!campaigns.length && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">{t("עדיין אין קמפיינים. בחר רשימה ותבנית כדי ליצור את הראשון.", "No campaigns yet. Choose a list and a template to create your first one.")}</p>}
        <Input aria-label={t("חיפוש בקמפיינים האחרונים", "Search recent campaigns")} placeholder={t("חיפוש בשם קמפיין, רשימה או תבנית (100 אחרונים)", "Search by campaign, list or template name (last 100)")} value={campaignSearch} onChange={(e) => setCampaignSearch(e.target.value)} />
        {visible.map((campaign) => <article key={campaign.id} className="space-y-3 rounded-xl border p-5" data-testid={`campaign-${campaign.id}`}>
          <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{campaign.name} <span className="rounded-full border px-2 py-0.5 text-xs">{CHANNEL_LABELS[campaign.channel]}</span></h3><p className="text-sm text-muted-foreground">{campaign.list.name} · {campaign.template.name} · {t(`${campaign._count.recipients} נמענים`, `${campaign._count.recipients} recipients`)}{campaign.lastTestAt ? t(` · בדיקה נשלחה ${new Date(campaign.lastTestAt).toLocaleString("he-IL")}`, ` · test sent ${new Date(campaign.lastTestAt).toLocaleString("en-GB")}`) : ""}</p>{estimateText(campaign.estimate) && <p className="text-xs text-muted-foreground">{estimateText(campaign.estimate)}</p>}</div><span className="rounded-full bg-secondary px-3 py-1 text-sm">{campaignStatusLabels[campaign.status]}</span></div>
          {campaign.statusReason && <p className="text-sm text-amber-700" role="alert">{campaign.statusReason}</p>}
          {campaign.scheduledAt && <p className="text-sm">{t("מועד שליחה:", "Send time:")} {new Date(campaign.scheduledAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL", { timeZone: timezone })} ({timezone})</p>}
          <div className="flex flex-wrap gap-4 text-sm">{Object.entries(campaign.counts).map(([status, count]) => <span key={status}>{recipientStatusLabels[status]}: <strong>{count}</strong></span>)}</div>
          <div className="flex flex-wrap items-center gap-2">
            {campaign.status === "DRAFT" && <><Input className="w-auto" type="datetime-local" aria-label={t(`מועד שליחה עבור ${campaign.name}`, `Send time for ${campaign.name}`)} value={schedule[campaign.id] ?? ""} onChange={(e) => setSchedule({ ...schedule, [campaign.id]: e.target.value })} /><Button disabled={busy} onClick={() => action(campaign, "start")}>{schedule[campaign.id] ? t("תזמן שליחה", "Schedule send") : t("התחל שליחה", "Start sending")}</Button></>}
            {campaign.status === "DRAFT" && <><Input className="w-48" dir="ltr" placeholder={campaign.channel === "whatsapp" ? t("מספר בדיקה מורשה", "Authorized test number") : t("נמען בדיקה", "Test recipient")} aria-label={t(`נמען בדיקה עבור ${campaign.name}`, `Test recipient for ${campaign.name}`)} value={testTo[campaign.id] ?? ""} onChange={(e) => setTestTo({ ...testTo, [campaign.id]: e.target.value })} /><Button variant="secondary" disabled={busy || !testTo[campaign.id]} onClick={() => sendTest(campaign)}>{t("שלח בדיקה", "Send test")}</Button></>}
            <a className="text-sm underline" href={`/api/campaigns/${campaign.id}/export`}>{t("ייצוא CSV", "Export CSV")}</a>
            {["RUNNING", "SCHEDULED"].includes(campaign.status) && <Button variant="outline" disabled={busy} onClick={() => action(campaign, "pause")}>{t("השהה", "Pause")}</Button>}
            {campaign.status === "PAUSED" && <Button disabled={busy} onClick={() => action(campaign, "resume")}>{t("המשך שליחה", "Resume sending")}</Button>}
            {!["CANCELLED", "COMPLETED"].includes(campaign.status) && <Button variant="outline" disabled={busy} onClick={() => action(campaign, "cancel")}>{t("בטל קמפיין", "Cancel campaign")}</Button>}
            <Button variant="outline" disabled={busy} onClick={async () => { if (await mutate(`/api/campaigns/${campaign.id}/duplicate`, "POST", {})) toast.success(t("נוצרה טיוטה חדשה לפי חברי הרשימה והתבנית הנוכחיים. יש לבדוק את הסיכום לפני הפעלה", "A new draft was created from the current list members and template. Review the summary before starting")); }}>{t("שכפל לטיוטה", "Duplicate as draft")}</Button>
            <Button variant="ghost" onClick={() => showDetails({ id: campaign.id, name: campaign.name, total: campaign._count.recipients })}>{t("פירוט נמענים", "Recipient details")}</Button>
            <Button variant="ghost" onClick={() => showReport(campaign)}>{t("דוח", "Report")}</Button>
          </div>
        </article>)}
      </div>
      {detail && <section className="space-y-3 rounded-xl border p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">{t("נמענים", "Recipients")} — {detail.name}</h2><Button variant="ghost" onClick={() => setDetail(null)}>{t("סגור", "Close")}</Button></div><div className="overflow-x-auto"><table className="w-full text-start text-sm"><thead><tr><th className="p-2 text-start">{t("שם", "Name")}</th><th className="p-2 text-start">{t("יעד", "Destination")}</th><th className="p-2 text-start">{t("מצב", "Status")}</th><th className="p-2 text-start">{t("ניסיונות", "Attempts")}</th><th className="p-2 text-start">{t("פירוט", "Details")}</th><th className="p-2 text-start"></th></tr></thead><tbody>{detail.recipients.map((r) => { const c = campaigns.find((x) => x.id === detail.id); return <tr key={r.id} className="border-t"><td className="p-2">{r.contact.name}</td><td className="p-2" dir="ltr">{r.identifier ?? r.contact.phone}</td><td className="p-2">{r.deliveryStatus ? deliveryStatusLabels[r.deliveryStatus] ?? r.deliveryStatus : recipientStatusLabels[r.status]}</td><td className="p-2">{r.attempts ?? 0}</td><td className="p-2">{r.deliveryError ?? r.error}{r.errorCode ? <span className="text-xs text-muted-foreground"> ({r.errorCode})</span> : null}</td><td className="p-2">{c && ["FAILED", "UNKNOWN"].includes(r.status) && <Button size="sm" variant="outline" disabled={busy} onClick={() => retry(c, r)} data-testid="retry-recipient">{r.status === "UNKNOWN" ? t("נסה שוב (לאחר בירור)", "Retry (after checking)") : t("נסה שוב", "Retry")}</Button>}</td></tr>; })}</tbody></table></div><div className="flex items-center gap-3"><Button variant="outline" disabled={detail.page <= 1} onClick={() => showDetails(detail, detail.page - 1)}>{t("הקודם", "Previous")}</Button><span>{t(`עמוד ${detail.page}`, `Page ${detail.page}`)}</span><Button variant="outline" disabled={detail.page * 100 >= detail.total} onClick={() => showDetails(detail, detail.page + 1)}>{t("הבא", "Next")}</Button><Button variant="ghost" onClick={() => showDetails(detail, detail.page)}>{t("רענון", "Refresh")}</Button></div></section>}
    </>}
  </div>;
}
