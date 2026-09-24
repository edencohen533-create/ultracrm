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

type ChannelKey = "whatsapp" | "sms" | "email";
interface Campaign {
  id: string; name: string; status: string; channel: ChannelKey; scheduledAt: string | null; statusReason: string | null; lastTestAt: string | null; estimate: { total: number | null; units: number; currency: string | null; known: boolean; segments: number | null } | null;
  list: { name: string }; template: { name: string }; _count: { recipients: number }; counts: Record<string, number>;
}
interface Recipient { id: string; status: string; deliveryStatus: string | null; error: string | null; identifier: string | null; contact: { name: string; phone: string } }
interface ChannelTemplate { id: string; channel: string; name: string; category: string; body: string; subject: string | null }
interface Report { channel: ChannelKey; simulated: boolean; recipients: Record<string, number>; delivery: Record<string, number>; engagement: { opened: number; clicked: number; complained: number; hardBounce: number; softBounce: number; replies: number | null; unsubscribes: number }; cost: { actual: { amount: number; currency: string | null; messages: number } | null; estimate: { total: number | null; currency: string | null; known: boolean; units: number } | null }; availability: Record<string, string>; notes: string[] }
interface Props {
  initialCampaigns: Campaign[];
  lists: { id: string; name: string; segment?: unknown; members: { contactId: string }[]; _count: { members: number } }[];
  contacts: { id: string; name: string; phone: string; consentStatus: string }[];
  templates: { id: string; name: string; body: string; language?: string }[];
  channelTemplates: ChannelTemplate[];
  channels: { sms: { id: string; provider: string; simulated: boolean; sendingBlocked: boolean; status: string; senders: Array<{ value: string; type: string; inbound: boolean }>; testRecipients: string[]; unitPrice: number | null; currency: string | null; label: string } | null; email: { id: string; provider: string; simulated: boolean; sendingBlocked: boolean; status: string; domainStatus: string | null; sender: string; testRecipients: string[]; unitPrice: number | null; currency: string | null; label: string } | null };
  timezone: string;
  marketingWindow: { start: string; end: string; days: number[] };
  audienceOptions?: AudienceOptions;
  mock: boolean;
  senders?: { id: string; label: string; displayPhoneNumber: string | null; isDefault: boolean; sendingBlocked: boolean }[];
}
const selectClass = "w-full rounded-md border bg-background p-2 text-sm";
const AVAIL: Record<string, string> = { real: "נתון אמיתי", simulated: "הדמיה", estimated: "אומדן", partial: "חלקי", signal: "אות מהספק", unavailable: "לא זמין" };

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

export function CampaignDashboard({ initialCampaigns, lists, contacts, templates, channelTemplates, channels, timezone, marketingWindow, mock, senders = [], audienceOptions = { tags: [], agents: [], campaigns: [] } }: Props) {
  const router = useRouter();
  const [review, setReview] = useState<{ campaign: Campaign; action: string; eligible: number; totalQueued: number; audienceExcluded?: number; exclusions: Record<string, number>; blockers: string[]; samples: { name: string; body: string; subject?: string; phone: string }[]; sender: string; cost: { total: number | null; currency: string | null; known: boolean; units: number; segments: number | null } | null; sendWindow: { start: string; end: string; days: number[]; timezone: string; maxPerMinute: number } | null; simulated: boolean; timezone: string } | null>(null);
  const [campaignSearch, setCampaignSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"all" | ChannelKey>("all");
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [tab, setTab] = useState<"campaigns" | "lists">("campaigns");
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<ChannelKey>("whatsapp");
  const [name, setName] = useState("");
  const [providerCredentialId, setProviderCredentialId] = useState(senders.find((sender) => sender.isDefault)?.id || senders[0]?.id || "");
  const [senderId, setSenderId] = useState(channels.sms?.senders[0]?.value ?? "");
  const [segment, setSegment] = useState<AudienceNode | null>(null);
  const [excludedListIds, setExcludedListIds] = useState<string[]>([]);
  const [listId, setListId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState<Record<string, string>>({});
  const [report, setReport] = useState<(Report & { name: string }) | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvMapping, setCsvMapping] = useState({ name: "name", phone: "phone", consentStatus: "consentStatus" });
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
  const chTemplates = useMemo(() => channelTemplates.filter((t) => t.channel === channel), [channelTemplates, channel]);
  const chTemplate = chTemplates.find((t) => t.id === templateId);
  const filtered = contacts.filter((c) => `${c.name} ${c.phone}`.toLowerCase().includes(search.toLowerCase()));
  const channelReady = channel === "whatsapp" ? (mock || senders.some((s) => s.id === providerCredentialId && !s.sendingBlocked)) : channel === "sms" ? Boolean(channels.sms && !channels.sms.sendingBlocked && senderId) : Boolean(channels.email && !channels.email.sendingBlocked);
  const previewText = useMemo(() => {
    if (channel === "whatsapp") return waTemplate ? renderTemplate(waTemplate.body, variables).replaceAll("{name}", "ישראל") : "בחר תבנית להצגת ההודעה";
    if (!chTemplate) return "בחר תבנית להצגת ההודעה";
    const body = chTemplate.body.replace(/\{\{\s*(first_name|name)\s*(?:\|[^}]*)?\}\}/g, "ישראל").replace(/\{\{\s*([\w.]+)\s*\|([^}]*)\}\}/g, (_m, k: string, d: string) => variables[k] ?? d).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => variables[k] ?? `{{${k}}}`);
    const sender = channels.sms?.senders.find((s) => s.value === senderId);
    return channel === "sms" && chTemplate.category === "MARKETING" ? body + (sender?.inbound === false ? "\nלהסרה: https://…/u/…" : "\nלהסרה השיבו הסר") : body;
  }, [channel, waTemplate, chTemplate, variables, channels.sms, senderId]);
  const sms = channel === "sms" ? smsMetrics(previewText) : null;
  const extraTags = chTemplate ? mergeTagsOf(`${chTemplate.subject ?? ""} ${chTemplate.body}`).filter((t) => !["name", "first_name", "company", "city", "email", "phone", "unsubscribe_url"].includes(t.tag) && !t.tag.startsWith("custom.")) : [];

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/campaigns");
        if (response.ok) setCampaigns((await response.json()).campaigns);
      } catch { /* Keep the last successful snapshot during network interruptions. */ }
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  async function mutate(url: string, method: string, body: unknown) {
    setBusy(true);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "הפעולה נכשלה");
      const refreshed = await fetch("/api/campaigns");
      if (refreshed.ok) setCampaigns((await refreshed.json()).campaigns);
      router.refresh();
      return true;
    } catch (error) { toast.error(error instanceof Error ? error.message : "שגיאת תקשורת"); return false; }
    finally { setBusy(false); }
  }
  async function showDetails(campaign: { id: string; name: string; total: number }, page = 1) {
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}?page=${page}`);
      if (!response.ok) throw new Error("לא ניתן לטעון את הנמענים");
      setDetail({ ...campaign, page, recipients: (await response.json()).recipients });
    } catch { toast.error("לא ניתן לטעון את הנמענים"); }
  }
  async function showReport(campaign: Campaign) {
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/report`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setReport({ ...data, name: campaign.name });
    } catch (e) { toast.error((e as Error).message || "לא ניתן לטעון דוח"); }
  }
  async function action(campaign: Campaign, action: string, confirmed = false) {
    if (["start", "resume"].includes(action) && !confirmed) {
      setBusy(true);
      try {
        const response = await fetch(`/api/campaigns/${campaign.id}?preflight=1`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "בדיקת הקמפיין נכשלה");
        setReview({ ...data, campaign, action });
      } catch (error) { toast.error(error instanceof Error ? error.message : "בדיקת הקמפיין נכשלה"); }
      finally { setBusy(false); }
      return;
    }
    const scheduledAt = action === "start" && schedule[campaign.id] ? zonedToIso(schedule[campaign.id], timezone) : undefined;
    if (await mutate(`/api/campaigns/${campaign.id}`, "PATCH", { action, scheduledAt, scheduledTimezone: scheduledAt ? timezone : undefined })) setReview(null);
  }
  async function sendTest(campaign: Campaign) {
    setBusy(true);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: testTo[campaign.id] ?? "" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "שליחת הבדיקה נכשלה");
      toast.success(`${data.data?.simulated ? "הדמיה: " : ""}הודעת בדיקה נשלחה`);
      const refreshed = await fetch("/api/campaigns"); if (refreshed.ok) setCampaigns((await refreshed.json()).campaigns);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const visible = campaigns.filter((c) => (channelFilter === "all" || c.channel === channelFilter) && `${c.name} ${c.list.name} ${c.template.name}`.toLowerCase().includes(campaignSearch.toLowerCase()));
  const estimateText = (e: Campaign["estimate"]) => !e ? null : e.known && e.total !== null ? `אומדן עלות: ${e.total} ${e.currency ?? ""} (${e.units} יחידות)` : `עלות: לא ידועה (${e.units} יחידות – הגדר מחיר ליחידה בחיבור)`;

  return <div className="mx-auto max-w-6xl space-y-6 p-6" dir="rtl">
    <div><h1 className="text-2xl font-bold">קמפיינים ורשימות תפוצה</h1><p className="mt-1 text-sm text-muted-foreground">WhatsApp, SMS ואימייל – אותם אנשי קשר, אותה רשימת הסרה גלובלית, תזמון לפי אזור הזמן של העסק ({timezone}).</p></div>
    {review && <section role="region" aria-label="סיכום לפני שליחה" className="space-y-3 rounded-xl border-2 p-5" data-testid="campaign-review"><h2 className="font-semibold">סיכום לפני שליחה — {review.campaign.name} · {CHANNEL_LABELS[review.campaign.channel]}</h2><p>{review.eligible} זכאים מתוך {review.totalQueued} שטרם נשלחו. שולח: {review.sender}{review.simulated && <strong> · הדמיה – לא נשלחות הודעות אמיתיות</strong>}</p>{!!review.audienceExcluded && <p>{review.audienceExcluded} הוחרגו בעת יצירת הטיוטה ונשמרו במצב דולג.</p>}<p>מועד: {schedule[review.campaign.id] || "מיידי"} · אזור זמן העסק: {review.timezone}{review.sendWindow ? ` · חלון שליחה ${review.sendWindow.start}–${review.sendWindow.end}${review.sendWindow.maxPerMinute ? ` · עד ${review.sendWindow.maxPerMinute} לדקה` : ""}` : ""}</p><p>הקהל הוקפא בעת יצירת הטיוטה. חסימות, הסרות והסכמה נבדקות שוב לפני כל שליחה. מגבלת תדירות משותפת לכל הערוצים.</p>{review.cost && <p data-testid="review-cost">{review.cost.known && review.cost.total !== null ? `אומדן עלות: ${review.cost.total} ${review.cost.currency ?? ""} (${review.cost.units} יחידות${review.cost.segments ? `, ${review.cost.segments} מקטעים לנמען` : ""}) – אומדן בלבד לפי מחיר יחידה שהוגדר ידנית` : `עלות: לא ידועה – לא הוגדר מחיר יחידה בחיבור (${review.cost.units} יחידות)`}</p>}{Object.entries(review.exclusions).map(([reason, count]) => <p key={reason}>{reason}: {count}</p>)}{review.blockers.map((reason) => <p key={reason} role="alert" className="text-destructive">{reason}</p>)}{review.samples.map((sample, i) => <div key={i} className="whitespace-pre-wrap rounded bg-muted p-3"><strong>{sample.name}</strong> <span dir="ltr" className="text-xs text-muted-foreground">{sample.phone}</span>{sample.subject && <p className="font-medium">נושא: {sample.subject}</p>}<p>{sample.body}</p></div>)}<Button disabled={busy || !!review.blockers.length || !review.eligible} onClick={() => action(review.campaign, review.action, true)}>אשר והפעל</Button><Button variant="ghost" onClick={() => setReview(null)}>סגור סיכום</Button></section>}
    {report && <section className="space-y-3 rounded-xl border-2 p-5" data-testid="campaign-report"><div className="flex items-center justify-between"><h2 className="font-semibold">דוח — {report.name} · {CHANNEL_LABELS[report.channel]}{report.simulated && " · הדמיה"}</h2><Button variant="ghost" onClick={() => setReport(null)}>סגור</Button></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">נמענים</p>{Object.entries(report.recipients).map(([k, v]) => <p key={k}>{recipientStatusLabels[k] ?? k}: <b>{v}</b></p>)}</div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">מסירה ({AVAIL[report.availability.delivery]})</p>{Object.entries(report.delivery).map(([k, v]) => <p key={k}>{deliveryStatusLabels[k] ?? k}: <b>{v}</b></p>)}{!Object.keys(report.delivery).length && <p>—</p>}</div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">תגובות והסרות</p><p>תשובות: <b>{report.engagement.replies ?? "לא זמין"}</b> ({AVAIL[report.availability.replies]})</p><p>הסרות: <b>{report.engagement.unsubscribes}</b></p>{report.channel === "email" && <><p>פתיחות: <b>{report.availability.opens === "unavailable" ? "לא זמין" : report.engagement.opened}</b> ({AVAIL[report.availability.opens]})</p><p>הקלקות: <b>{report.availability.clicks === "unavailable" ? "לא זמין" : report.engagement.clicked}</b> ({AVAIL[report.availability.clicks]})</p><p>תלונות ספאם: <b>{report.engagement.complained}</b> · bounce קשיח/רך: <b>{report.engagement.hardBounce}/{report.engagement.softBounce}</b></p></>}</div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">עלות ({AVAIL[report.availability.cost]})</p>{report.cost.actual ? <p>בפועל: <b>{report.cost.actual.amount} {report.cost.actual.currency ?? ""}</b> ({report.cost.actual.messages} הודעות)</p> : null}{report.cost.estimate?.known && report.cost.estimate.total !== null ? <p>אומדן: {report.cost.estimate.total} {report.cost.estimate.currency ?? ""}</p> : !report.cost.actual ? <p>לא זמין</p> : null}</div>
      </div>
      <ul className="list-disc pe-5 text-xs text-muted-foreground">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </section>}
    {mock && channel === "whatsapp" && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">מצב הדגמה פעיל ב-WhatsApp — הודעות מדומות בלבד. לשליחה אמיתית יש לחבר WhatsApp בהגדרות.</div>}
    <div className="flex gap-2"><Button variant={tab === "campaigns" ? "default" : "outline"} onClick={() => setTab("campaigns")}>קמפיינים</Button><Button variant={tab === "lists" ? "default" : "outline"} onClick={() => setTab("lists")}>רשימות תפוצה ({lists.length})</Button></div>
    {tab === "lists" ? <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-4 rounded-xl border p-5"><h2 className="font-semibold">{editingList ? "עריכת רשימת תפוצה" : "רשימת תפוצה חדשה"}</h2>
        <label className="block space-y-1"><span>שם הרשימה</span><Input aria-label="שם רשימת תפוצה" value={listName} onChange={(e) => setListName(e.target.value)} maxLength={120} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!segment} onChange={(event) => setSegment(event.target.checked ? defaultAudience() : null)} />קהל שמור לפי תנאים</label>
        <p className="text-xs text-muted-foreground">תנאים מחושבים ביצירת טיוטת קמפיין. רשימת הנמענים מוקפאת בטיוטה; חסימות והסרות נבדקות שוב בכל שליחה. עד 10,000 נמענים בקמפיין.</p>
        {segmentInvalid && <p role="alert" className="text-sm text-destructive">יש להשלים ערכים תקינים בכל התנאים. מותר לשמור עד 50 תנאים וקבוצות, בשלוש רמות, וטקסט עד 200 תווים.</p>}
        {segment ? <><AudienceEditor value={segment} onChange={setSegment} options={audienceOptions} /><AudiencePreview segment={segment} /></> : <>
        <Input aria-label="חיפוש אנשי קשר" placeholder="חיפוש לפי שם או טלפון" value={search} onChange={(e) => setSearch(e.target.value)} />
        <p className="text-sm text-muted-foreground">{selected.length} נבחרו. רק נמענים עם הסכמה פעילה יקבלו הודעות. מוצגים עד 1,000 אנשי קשר.</p>
        <Button variant="outline" onClick={() => setSelected([...new Set([...selected, ...filtered.filter((c) => c.consentStatus === "OPTED_IN").map((c) => c.id)])])}>בחר את כל המסכימים בתוצאות</Button>
        <div className="max-h-72 space-y-2 overflow-y-auto">{filtered.map((contact) => <label key={contact.id} className="flex items-center gap-3 rounded border p-2 text-sm"><input type="checkbox" checked={selected.includes(contact.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, contact.id] : selected.filter((id) => id !== contact.id))} /><span className="flex-1">{contact.name} <span dir="ltr" className="text-muted-foreground">{contact.phone}</span></span><span>{contact.consentStatus === "OPTED_IN" ? "מאשר דיוור" : contact.consentStatus === "OPTED_OUT" ? "הוסר מדיוור" : "ללא הסכמה"}</span></label>)}</div>
        </>}
        <div className="flex gap-2"><Button disabled={busy || !listName.trim() || (segment ? segmentInvalid : !selected.length)} onClick={async () => {
          if (await mutate(editingList ? `/api/distribution-lists/${editingList}` : "/api/distribution-lists", editingList ? "PUT" : "POST", { name: listName, contactIds: segment ? [] : selected, segment })) { setListName(""); setSelected([]); setSegment(null); setEditingList(null); toast.success("הרשימה נשמרה"); }
        }}>שמור רשימה</Button>{editingList && <Button variant="outline" onClick={() => { setEditingList(null); setListName(""); setSelected([]); setSegment(null); }}>ביטול עריכה</Button>}</div>
      </section>
      <section className="space-y-3"><div className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">ייבוא רשימה מ־CSV</h2><p className="text-sm text-muted-foreground">עד 10,000 שורות, עם כותרות name,phone ועמודת consentStatus אופציונלית. הערך OPTED_IN מציין הסכמה קיימת לדיוור; ללא ערך, הנמען לא יקבל קמפיינים. פרטי אנשי קשר קיימים והסכמתם נשמרים.</p><Input aria-label="שם הרשימה המיובאת" placeholder="שם הרשימה" value={importName} onChange={(e) => setImportName(e.target.value)} maxLength={120} /><Input aria-label="קובץ אנשי קשר CSV" type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; setCsv(""); setCsvPreview(null); setCsvHeaders([]); if (!file) return; if (file.size > 1000000) { toast.error("הקובץ גדול מדי (עד 1MB)"); return; } try { const text = await file.text(); setCsv(text); setCsvHeaders(parseCsv(text)[0] ?? []); } catch { toast.error("קריאת הקובץ נכשלה"); } }} /><pre dir="ltr" className="overflow-auto rounded bg-muted p-2 text-xs">{"name,phone,consentStatus\nישראל,0501234567,OPTED_IN"}</pre>{csvHeaders.length > 0 && <div className="space-y-2">{(["name", "phone", "consentStatus"] as const).map((key) => <label key={key} className="block">מיפוי {key}<select aria-label={`עמודת ${key}`} className={selectClass} value={csvMapping[key]} onChange={(e) => { setCsvMapping({ ...csvMapping, [key]: e.target.value }); setCsvPreview(null); }}><option value="">ללא עמודה</option>{csvHeaders.map((header, i) => <option key={i} value={header}>{header}</option>)}</select></label>)}<Button variant="outline" disabled={busy || !importName.trim()} onClick={async () => { setBusy(true); try { const response = await fetch("/api/distribution-lists/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: importName, csv, mapping: csvMapping, preview: true }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setCsvPreview(data); } catch (error) { toast.error(error instanceof Error ? error.message : "הבדיקה נכשלה"); } finally { setBusy(false); } }}>בדוק והצג תצוגה מקדימה</Button></div>}{csvPreview && <div role="status" className="space-y-1 text-sm"><p>{csvPreview.valid} ייחודיים תקינים, {csvPreview.duplicateRows} כפולים, {csvPreview.errorCount} שגיאות. אין שינוי בהסכמת אנשי קשר קיימים.</p>{csvPreview.errors.map((error) => <p key={error.row}>{error.error}</p>)}{csvPreview.samples.map((sample) => <p key={sample.phone}>{sample.name} · <span dir="ltr">{sample.phone}</span> · {sample.consentStatus}</p>)}</div>}<Button disabled={busy || !importName.trim() || !csv || !csvPreview || !!csvPreview.errorCount} onClick={async () => { if (await mutate("/api/distribution-lists/import", "POST", { name: importName, csv, mapping: csvMapping })) { setImportName(""); setCsv(""); toast.success("הרשימה יובאה בהצלחה"); } }}>ייבא רשימה</Button></div><h2 className="font-semibold">הרשימות שלי</h2>{!lists.length && <p className="text-muted-foreground">צור רשימה ראשונה כדי להתחיל.</p>}{lists.map((list) => <div key={list.id} className="flex items-center justify-between rounded-xl border p-4"><div><p className="font-medium">{list.name}</p><p className="text-sm text-muted-foreground">{list.segment ? "קהל דינמי לפי תנאים" : `${list._count.members} אנשי קשר`}</p></div><Button variant="outline" onClick={() => { const parsed = list.segment ? audienceSchema.safeParse(list.segment) : null; if (parsed && !parsed.success) { toast.error("לא ניתן לקרוא את תנאי הקהל"); return; } setSegment(parsed?.success ? parsed.data : null); setEditingList(list.id); setListName(list.name); setSelected(list.members.map((m) => m.contactId)); }}>עריכה</Button></div>)}</section>
    </div> : <>
      <section className="grid gap-5 rounded-xl border p-5 lg:grid-cols-2">
        <div className="space-y-3"><h2 className="font-semibold">קמפיין חדש</h2>
          <div className="flex gap-2" role="tablist" aria-label="ערוץ">{(["whatsapp", "sms", "email"] as ChannelKey[]).map((ch) => <Button key={ch} type="button" size="sm" variant={channel === ch ? "default" : "outline"} onClick={() => { setChannel(ch); setTemplateId(""); setVariables({}); }} data-testid={`channel-${ch}`}>{CHANNEL_LABELS[ch]}</Button>)}</div>
          {channel === "sms" && !channels.sms && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">אין ספק SMS מחובר. <a className="underline" href="/settings/sms">חבר ספק בהגדרות</a>.</p>}
          {channel === "email" && !channels.email && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">אין ספק אימייל מחובר. <a className="underline" href="/settings/email">חבר ספק בהגדרות</a>.</p>}
          {channel === "email" && channels.email && !channels.email.simulated && channels.email.domainStatus !== "verified" && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">הדומיין השולח טרם אומת ({channels.email.domainStatus ?? "לא הוגדר"}). שליחה אמיתית תיחסם עד לאימות.</p>}
          {(channel === "sms" ? channels.sms?.simulated : channel === "email" ? channels.email?.simulated : false) && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">ספק {CHANNEL_LABELS[channel]} במצב הדמיה – לא נשלחות הודעות אמיתיות.</p>}
          <label className="block space-y-1"><span>שם הקמפיין</span><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
          <label className="block space-y-1"><span>רשימת תפוצה</span><select aria-label="רשימת תפוצה לקמפיין" className={selectClass} value={listId} onChange={(e) => setListId(e.target.value)}><option value="">בחר רשימה</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name} ({list.segment ? "תנאים שמורים" : list._count.members})</option>)}</select></label>
          <label className="block space-y-1"><span>החרגת קהלים (בחירה מרובה)</span><select multiple aria-label="קהלים להחרגה" className={selectClass} value={excludedListIds} onChange={(event) => setExcludedListIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
          {listId && <AudiencePreview listId={listId} excludedListIds={excludedListIds} />}
          {channel === "whatsapp" && <label className="block space-y-1"><span>מספר שולח</span><select aria-label="מספר שולח לקמפיין" className={selectClass} value={providerCredentialId} onChange={(event) => setProviderCredentialId(event.target.value)}>{mock ? <option value="">הדגמה בלבד — לא נשלחות הודעות WhatsApp</option> : senders.map((sender) => <option key={sender.id} value={sender.id} disabled={sender.sendingBlocked}>{sender.label}{sender.displayPhoneNumber ? ` · ${sender.displayPhoneNumber}` : ""}{sender.sendingBlocked ? " — חסום" : ""}</option>)}</select></label>}
          {channel === "sms" && channels.sms && <label className="block space-y-1"><span>שולח מאושר</span><select aria-label="שולח SMS" className={selectClass} value={senderId} onChange={(e) => setSenderId(e.target.value)}>{channels.sms.senders.map((s) => <option key={s.value} value={s.value}>{s.value}{s.type === "alphanumeric" ? " (אלפאנומרי – ללא תשובות)" : s.inbound ? " (קולט תשובות)" : ""}</option>)}{!channels.sms.senders.length && <option value="">אין שולח מאושר – בדוק את החיבור</option>}</select></label>}
          {channel === "email" && channels.email && <p className="text-sm">שולח: <span dir="ltr">{channels.email.sender}</span></p>}
          <label className="block space-y-1"><span>תבנית {channel === "whatsapp" ? "מאושרת" : ""}</span><select className={selectClass} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setVariables({}); }} data-testid="campaign-template"><option value="">בחר תבנית</option>{channel === "whatsapp" ? templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.language ? ` (${t.language})` : ""}</option>) : chTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category === "MARKETING" ? "שיווקי" : "שירות"})</option>)}</select></label>
          {channel === "whatsapp" && waTemplate && templateParameterKeys(waTemplate.body).map((key) => <label key={key} className="block space-y-1"><span>משתנה {key}</span><Input value={variables[key] ?? ""} onChange={(e) => setVariables({ ...variables, [key]: e.target.value })} placeholder="השתמש ב־{name} לשם הנמען" maxLength={1024} /></label>)}
          {channel !== "whatsapp" && extraTags.map(({ tag, fallback }) => <label key={tag} className="block space-y-1"><span>ערך ל-{`{{${tag}}}`}{fallback !== null ? ` (ברירת מחדל: ${fallback || "ריק"})` : ""}</span><Input value={variables[tag] ?? ""} onChange={(e) => setVariables({ ...variables, [tag]: e.target.value })} maxLength={1024} /></label>)}
          <Button disabled={busy || !channelReady || !name.trim() || !listId || (channel === "whatsapp" ? !waTemplate || templateParameterKeys(waTemplate.body).some((key) => !variables[key]?.trim()) : !chTemplate || extraTags.some((t) => t.fallback === null && !variables[t.tag]?.trim()))} onClick={async () => { if (await mutate("/api/campaigns", "POST", { channel, name, listId, excludedListIds, templateId, variables: Object.fromEntries(Object.entries(variables).filter(([, v]) => v.trim())), providerCredentialId: channel === "whatsapp" ? (providerCredentialId || null) : (channel === "sms" ? channels.sms?.id : channels.email?.id) ?? null, senderId: channel === "sms" ? senderId || null : null })) { setName(""); toast.success("הטיוטה נשמרה. ניתן לשלוח בדיקה, להתחיל או לתזמן שליחה"); } }} data-testid="campaign-save">שמור טיוטה</Button>
        </div>
        <div className="space-y-3"><h3 className="text-sm font-medium">תצוגה מקדימה</h3>{channel === "email" && chTemplate?.subject && <p className="text-sm"><b>נושא:</b> {chTemplate.subject}</p>}<div className={`min-h-32 whitespace-pre-wrap rounded-xl p-4 ${channel === "whatsapp" ? "bg-emerald-50 text-emerald-950" : channel === "sms" ? "bg-sky-50 text-sky-950" : "bg-violet-50 text-violet-950"}`} data-testid="campaign-preview">{previewText}</div>
          {sms && chTemplate && <p className="text-xs text-muted-foreground" data-testid="sms-estimate">קידוד {sms.encoding} · {sms.length} תווים · {sms.segments} מקטעים לנמען{channels.sms?.unitPrice != null ? ` · אומדן ${(sms.segments * channels.sms.unitPrice).toFixed(4)} ${channels.sms.currency ?? ""} לנמען (מחיר יחידה ידני)` : " · מחיר לא ידוע – הגדר מחיר ליחידה בחיבור"}</p>}
          {channel === "email" && chTemplate && <p className="text-xs text-muted-foreground">{channels.email?.unitPrice != null ? `אומדן ${channels.email.unitPrice} ${channels.email.currency ?? ""} לאימייל (מחיר יחידה ידני)` : "מחיר לא ידוע – הגדר מחיר ליחידה בחיבור"} · קישור הסרה גלובלי מתווסף אוטומטית</p>}
          <p className="text-sm text-muted-foreground">הנמענים נשמרים בעת יצירת הטיוטה. הסכמה, הסרות ומגבלת תדירות נבדקות מחדש בזמן השליחה. עצירה אינה מבטלת הודעה שכבר הועברה לספק.</p>
          {channel !== "whatsapp" && <p className="text-xs text-muted-foreground">בדיקת שליחה: לאחר שמירת הטיוטה, שלח לנמען בדיקה שהוגדר בחיבור ({(channel === "sms" ? channels.sms?.testRecipients : channels.email?.testRecipients)?.join(", ") || "לא הוגדרו נמעני בדיקה"}).</p>}
        </div>
      </section>
      <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">הקמפיינים שלי</h2><div className="flex gap-1 ms-auto">{(["all", "whatsapp", "sms", "email"] as const).map((k) => <Button key={k} size="sm" variant={channelFilter === k ? "default" : "outline"} onClick={() => setChannelFilter(k)} data-testid={`filter-${k}`}>{k === "all" ? "הכל" : CHANNEL_LABELS[k]}</Button>)}</div></div>{!campaigns.length && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">עדיין אין קמפיינים. בחר רשימה ותבנית כדי ליצור את הראשון.</p>}
        <Input aria-label="חיפוש בקמפיינים האחרונים" placeholder="חיפוש בשם קמפיין, רשימה או תבנית (100 אחרונים)" value={campaignSearch} onChange={(e) => setCampaignSearch(e.target.value)} />
        {visible.map((campaign) => <article key={campaign.id} className="space-y-3 rounded-xl border p-5" data-testid={`campaign-${campaign.id}`}>
          <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{campaign.name} <span className="rounded-full border px-2 py-0.5 text-xs">{CHANNEL_LABELS[campaign.channel]}</span></h3><p className="text-sm text-muted-foreground">{campaign.list.name} · {campaign.template.name} · {campaign._count.recipients} נמענים{campaign.lastTestAt ? ` · בדיקה נשלחה ${new Date(campaign.lastTestAt).toLocaleString("he-IL")}` : ""}</p>{estimateText(campaign.estimate) && <p className="text-xs text-muted-foreground">{estimateText(campaign.estimate)}</p>}</div><span className="rounded-full bg-secondary px-3 py-1 text-sm">{campaignStatusLabels[campaign.status]}</span></div>
          {campaign.statusReason && <p className="text-sm text-amber-700" role="alert">{campaign.statusReason}</p>}
          {campaign.scheduledAt && <p className="text-sm">מועד שליחה: {new Date(campaign.scheduledAt).toLocaleString("he-IL", { timeZone: timezone })} ({timezone})</p>}
          <div className="flex flex-wrap gap-4 text-sm">{Object.entries(campaign.counts).map(([status, count]) => <span key={status}>{recipientStatusLabels[status]}: <strong>{count}</strong></span>)}</div>
          <div className="flex flex-wrap items-center gap-2">
            {campaign.status === "DRAFT" && <><Input className="w-auto" type="datetime-local" aria-label={`מועד שליחה עבור ${campaign.name}`} value={schedule[campaign.id] ?? ""} onChange={(e) => setSchedule({ ...schedule, [campaign.id]: e.target.value })} /><Button disabled={busy} onClick={() => action(campaign, "start")}>{schedule[campaign.id] ? "תזמן שליחה" : "התחל שליחה"}</Button></>}
            {campaign.status === "DRAFT" && campaign.channel !== "whatsapp" && <><Input className="w-48" dir="ltr" placeholder="נמען בדיקה" aria-label={`נמען בדיקה עבור ${campaign.name}`} value={testTo[campaign.id] ?? ""} onChange={(e) => setTestTo({ ...testTo, [campaign.id]: e.target.value })} /><Button variant="secondary" disabled={busy || !testTo[campaign.id]} onClick={() => sendTest(campaign)}>שלח בדיקה</Button></>}
            {["RUNNING", "SCHEDULED"].includes(campaign.status) && <Button variant="outline" disabled={busy} onClick={() => action(campaign, "pause")}>השהה</Button>}
            {campaign.status === "PAUSED" && <Button disabled={busy} onClick={() => action(campaign, "resume")}>המשך שליחה</Button>}
            {!["CANCELLED", "COMPLETED"].includes(campaign.status) && <Button variant="outline" disabled={busy} onClick={() => action(campaign, "cancel")}>בטל קמפיין</Button>}
            <Button variant="outline" disabled={busy} onClick={async () => { if (await mutate(`/api/campaigns/${campaign.id}/duplicate`, "POST", {})) toast.success("נוצרה טיוטה חדשה לפי חברי הרשימה והתבנית הנוכחיים. יש לבדוק את הסיכום לפני הפעלה"); }}>שכפל לטיוטה</Button>
            <Button variant="ghost" onClick={() => showDetails({ id: campaign.id, name: campaign.name, total: campaign._count.recipients })}>פירוט נמענים</Button>
            <Button variant="ghost" onClick={() => showReport(campaign)}>דוח</Button>
          </div>
        </article>)}
      </div>
      {detail && <section className="space-y-3 rounded-xl border p-5"><div className="flex items-center justify-between"><h2 className="font-semibold">נמענים — {detail.name}</h2><Button variant="ghost" onClick={() => setDetail(null)}>סגור</Button></div><div className="overflow-x-auto"><table className="w-full text-start text-sm"><thead><tr><th className="p-2 text-start">שם</th><th className="p-2 text-start">יעד</th><th className="p-2 text-start">מצב</th><th className="p-2 text-start">פירוט</th></tr></thead><tbody>{detail.recipients.map((r) => <tr key={r.id} className="border-t"><td className="p-2">{r.contact.name}</td><td className="p-2" dir="ltr">{r.identifier ?? r.contact.phone}</td><td className="p-2">{r.deliveryStatus ? deliveryStatusLabels[r.deliveryStatus] ?? r.deliveryStatus : recipientStatusLabels[r.status]}</td><td className="p-2">{r.error}</td></tr>)}</tbody></table></div><div className="flex items-center gap-3"><Button variant="outline" disabled={detail.page <= 1} onClick={() => showDetails(detail, detail.page - 1)}>הקודם</Button><span>עמוד {detail.page}</span><Button variant="outline" disabled={detail.page * 100 >= detail.total} onClick={() => showDetails(detail, detail.page + 1)}>הבא</Button><Button variant="ghost" onClick={() => showDetails(detail, detail.page)}>רענון</Button></div></section>}
    </>}
  </div>;
}
