"use client";

import { ContactBlockNotice } from "@/components/contacts/ContactBlockNotice";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useMe } from "@/lib/client/use-me";
import { Badge, Button, EmptyState, Input, Modal, Panel, Phone, Select, Spinner, Textarea, cx } from "@/components/ui";
import { formatDateTime, formatDuration, formatPhone, relativeTime, toLocalInputValue } from "@/lib/client/format";
import { DEAL_STAGE_LABEL } from "@/lib/crm/labels";
import { DealCloseModal } from "@/components/leads/DealCloseModal";
import { AttemptsCell, AttemptsModal, FollowUpBadge, FollowUpModal, fmtBiz, type FollowUpInfo } from "@/components/leads/LeadActions";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import type { TimelineItem } from "@/lib/crm/timeline";
import { ContactChat } from "@/components/contacts/ContactChat";
import { useT } from "@/components/i18n/LangProvider";

interface Card {
  id: string; fullName: string; phoneE164: string; email: string | null; company: string | null; city: string | null; source: string | null; notes: string | null; createdAt: string; lastActivityAt: string | null;
  consentStatus: string; consentAt: string | null; consentSource: string | null; consentEvidence: string | null; isBlocked: boolean; customFields: Record<string, unknown> | null;
  owner: { id: string; fullName: string } | null;
  phones: Array<{ id: string; e164: string; label: string | null }>;
  emails: Array<{ id: string; email: string; label: string | null }>;
  tags: Array<{ id: string; name: string; color: string }>;
  leads: Array<{ id: string; title: string | null; status: string; source: string | null; createdAt: string; owner: { fullName: string } | null }>;
  deals: Array<{ id: string; title: string; stage: string; status: string; amount: string; currency: string; createdAt: string; owner: { fullName: string } | null }>;
  queueLeads: Array<{ id: string; status: string; attempts: number; list: { id: string; name: string } }>;
  tasks: Array<{ id: string; title: string | null; type: string; dueAt: string; note: string | null; user: { fullName: string } }>;
  calls: Array<{ id: string; createdAt: string; direction: string; answeredAt: string | null; talkSeconds: number | null; telephonyResult: string | null; outcome: string | null; outcomeNote: string | null; recordingStatus: string; user: { fullName: string } }>;
  conversations: Array<{ id: string; channel: string; status: string; lastMessageAt: string | null; unreadCount: number; assignedAgent: { fullName: string } | null; providerCredential: { label: string | null; displayPhoneNumber: string | null; isActive: boolean } | null; messages: Array<{ body: string | null; direction: string; createdAt: string }> }>;
  noteItems: Array<{ id: string; body: string; createdAt: string; author: { fullName: string } }>;
  isDnc: boolean; dncReason: string | null;
  suppression: { marketingBlocked: boolean; fullyBlocked: boolean; doNotContact?: boolean; pendingReview?: boolean; active: Array<{ id: string; identifier: string; identifierType?: string; scope: string; source: string; reason: string | null; createdAt: string }>; history: Array<{ id: string; identifier: string; scope: string; source: string; reason: string | null; createdAt: string; revokedAt: string | null; revokeEvidence: string | null }> };
}

const KIND_ICON: Record<TimelineItem["kind"], string> = { call: "📞", message: "💬", note: "📝", task: "✅", lead: "⭐", deal: "💼", event: "⚡" };

export default function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { dial, state } = useDialer();
  const me = useMe();
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const statuses = useLeadStatuses();
  const [c, setC] = useState<Card | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", company: "", city: "", source: "", notes: "", ownerUserId: "" });
  const [custom, setCustom] = useState<Array<{ key: string; value: string }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [tagInput, setTagInput] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const [task, setTask] = useState(() => ({ title: "", dueAt: toLocalInputValue(new Date(Date.now() + 3600_000)), userId: "", note: "" }));
  const [now, setNow] = useState(0);
  const [leadOpen, setLeadOpen] = useState(false);
  const [lead, setLead] = useState({ title: "", source: "", ownerUserId: "" });
  const [dealOpen, setDealOpen] = useState(false);
  const [deal, setDeal] = useState({ title: "", amount: "", stage: "new" });
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [extra, setExtra] = useState({ phone: "", email: "", label: "" });
  const [suppressOpen, setSuppressOpen] = useState<"marketing" | "all" | "revoke" | null>(null);
  const [suppressText, setSuppressText] = useState("");
  const search = useSearchParams();
  const focusLeadId = search.get("lead");
  const [leadEdit, setLeadEdit] = useState<{ id: string; title: string; status: string; source: string; priority: number; ownerUserId: string; notes: string } | null>(null);
  const [leadMeta, setLeadMeta] = useState<{ attempts: number; attemptLimit: number | null; closeReason: string | null; lastAttemptAt: string | null; timezone: string; followUp: FollowUpInfo | null; needsSchedule: boolean; pendingTransfer: { to: string | null } | null } | null>(null);
  const [leadModal, setLeadModal] = useState<"followup" | "attempts" | "deal" | null>(null);
  const [showChat, setShowChat] = useState(search.get("tab") === "chat");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [r, tl] = await Promise.all([api.get<Card>(`/api/contacts/${id}`), api.get<{ items: TimelineItem[] }>(`/api/contacts/${id}/timeline`)]);
      setC(r);
      setTimeline(tl.items);
      setNow(Date.now());
      const focus = (focusLeadId && r.leads.find((l) => l.id === focusLeadId)) || r.leads.find((l) => ["new", "contacted", "qualified", "follow_up"].includes(l.status)) || null;
      if (focus) {
        const full = await api.get<{ id: string; title: string | null; status: string; source: string | null; priority: number; notes: string | null; owner: { id: string } | null; attempts: number; attemptLimit?: number | null; closeReason?: string | null; lastAttemptAt: string | null; timezone: string; followUp: FollowUpInfo | null; needsSchedule: boolean; pendingTransfer: { to: string | null } | null }>(`/api/leads/${focus.id}`);
        setLeadMeta({ attempts: full.attempts, attemptLimit: full.attemptLimit ?? null, closeReason: full.closeReason ?? null, lastAttemptAt: full.lastAttemptAt, timezone: full.timezone, followUp: full.followUp, needsSchedule: full.needsSchedule, pendingTransfer: full.pendingTransfer });
        setLeadEdit({ id: full.id, title: full.title ?? "", status: full.status, source: full.source ?? "", priority: full.priority, ownerUserId: full.owner?.id ?? "", notes: full.notes ?? "" });
      } else setLeadEdit(null);
    } catch (e) {
      setC(null);
      setLoadError((e as Error).message);
    }
  }, [id, focusLeadId]);
  useEffect(() => { load(); }, [load, state?.wrapUpCall?.id, state?.activeCall?.id]);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((r) => setUsers(r.items)).catch(() => undefined); }, []);

  function beginEdit() {
    if (!c) return;
    // Initialize a draft only when opening the editor, not when call-state polling refreshes the card.
    setForm({ fullName: c.fullName, phone: c.phoneE164, email: c.email ?? "", company: c.company ?? "", city: c.city ?? "", source: c.source ?? "", notes: c.notes ?? "", ownerUserId: c.owner?.id ?? "" });
    setCustom(Object.entries(c.customFields ?? {}).map(([key, value]) => ({ key, value: value === null || value === undefined ? "" : String(value) })));
    setEdit(true);
  }
  async function save() {
    try {
      const keys = custom.map((f) => f.key.trim()).filter(Boolean);
      if (new Set(keys).size !== keys.length) throw new Error(t("שמות שדות מותאמים חייבים להיות ייחודיים", "Custom field names must be unique"));
      await api.patch(`/api/contacts/${id}`, { ...form, ownerUserId: form.ownerUserId || null, customFields: Object.fromEntries(custom.filter((f) => f.key.trim()).map((f) => [f.key.trim(), f.value])) });
      toast.success(t("נשמר", "Saved"));
      setEdit(false);
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function addTag() {
    if (!c || !tagInput.trim()) return;
    try { await api.patch(`/api/contacts/${id}`, { tagIds: c.tags.map((t) => t.id), tagNames: [tagInput.trim()] }); setTagInput(""); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function removeTag(tagId: string) {
    if (!c) return;
    try { await api.patch(`/api/contacts/${id}`, { tagIds: c.tags.filter((t) => t.id !== tagId).map((t) => t.id) }); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function addNote() {
    if (!noteBody.trim()) return;
    try { await api.post("/api/notes", { contactId: id, body: noteBody }); setNoteBody(""); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function createTask() {
    try { await api.post("/api/tasks", { contactId: id, title: task.title || undefined, note: task.note || undefined, dueAt: new Date(task.dueAt).toISOString(), userId: task.userId || undefined, type: "todo", requestKey: crypto.randomUUID() }); setTaskOpen(false); toast.success(t("המשימה נוצרה", "Task created")); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function setTaskStatus(taskId: string, status: "done" | "cancelled") {
    try { await api.patch(`/api/tasks/${taskId}`, { status }); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function createLead() {
    try { await api.post("/api/leads", { contactId: id, title: lead.title || undefined, source: lead.source || undefined, ownerUserId: lead.ownerUserId || undefined }); setLeadOpen(false); toast.success(t("הליד נוצר – שיוך ומשימה נוצרים אוטומטית", "Lead created – assignment and task are created automatically")); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function createDeal() {
    try { await api.post("/api/deals", { contactId: id, title: deal.title, amount: Number(deal.amount || 0), stage: deal.stage }); setDealOpen(false); toast.success(t("העסקה נוצרה", "Deal created")); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function addExtra() {
    try {
      if (extra.phone) await api.post(`/api/contacts/${id}/phones`, { phone: extra.phone, label: extra.label || undefined });
      if (extra.email) await api.post(`/api/contacts/${id}/emails`, { email: extra.email, label: extra.label || undefined });
      setPhoneOpen(false); setExtra({ phone: "", email: "", label: "" }); load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function suppress() {
    try {
      if (suppressOpen === "revoke") await api.delete(`/api/contacts/${id}/suppress`, { evidence: suppressText });
      else await api.post(`/api/contacts/${id}/suppress`, { scope: suppressOpen, reason: suppressText || undefined });
      setSuppressOpen(null); setSuppressText(""); load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function saveLead() {
    if (!leadEdit) return;
    try { await api.patch(`/api/leads/${leadEdit.id}`, { title: leadEdit.title, status: leadEdit.status, source: leadEdit.source, priority: leadEdit.priority, notes: leadEdit.notes, ownerUserId: leadEdit.ownerUserId || null }); toast.success(t("הליד נשמר", "Lead saved")); load(); } catch (e) { toast.error((e as Error).message); }
  }

  if (loadError) return <div className="p-5 space-y-3" role="alert"><p>{loadError}</p><Button onClick={load}>{t("נסה שוב", "Try again")}</Button><Link href="/contacts" className="ms-3 underline">{t("חזרה לאנשי קשר", "Back to contacts")}</Link></div>;
  if (!c) return <div className="flex justify-center p-10"><Spinner /></div>;
  const canDial = Boolean(me?.modules.telephony) && Boolean(state) && !state?.activeCall && !state?.wrapUpCall && !c.isDnc && !c.suppression.fullyBlocked && !c.suppression.doNotContact;
  const isManager = me?.user.role === "manager" || me?.user.role === "owner";
  const openLeads = c.leads.filter((l) => ["new", "contacted", "qualified", "follow_up"].includes(l.status));

  return (
    <div className="p-5 space-y-4 max-w-6xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{c.fullName}</h1>
        <Phone value={formatPhone(c.phoneE164)} className="text-accent underline" />
        {c.company && <span className="text-muted text-sm">{c.company}</span>}
        {c.suppression.fullyBlocked ? <Badge tone="bad">{t("לא ליצור קשר", "Do not contact")}</Badge> : c.suppression.marketingBlocked ? <Badge tone="bad">{t("הוסר מדיוור שיווקי", "Unsubscribed from marketing")}</Badge> : c.consentStatus === "OPTED_IN" ? <Badge tone="good">{t("הסכמה לדיוור", "Marketing consent")}</Badge> : <Badge tone="neutral">{t("ללא הסכמה לדיוור", "No marketing consent")}</Badge>}
        {(c.suppression.doNotContact || c.suppression.pendingReview) && <div className="basis-full"><ContactBlockNotice summary={c.suppression} isDnc={c.isDnc} /></div>}
        {c.isDnc && !c.suppression.fullyBlocked && <Badge tone="bad">{t("DNC שיחות", "DNC calls")}{c.dncReason ? ` · ${c.dncReason}` : ""}</Badge>}
        <div className="ms-auto flex flex-wrap gap-2">
          {edit ? <><Button variant="ghost" size="sm" onClick={() => setEdit(false)}>{t("ביטול", "Cancel")}</Button><Button size="sm" onClick={save}>{t("שמור", "Save")}</Button></> : <Button variant="secondary" size="sm" onClick={beginEdit}>{t("עריכה", "Edit")}</Button>}
          <Button variant="secondary" size="sm" onClick={() => setTaskOpen(true)}>{t("+ משימה", "+ Task")}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setLead({ title: "", source: c.source ?? "", ownerUserId: "" }); setLeadOpen(true); }}>{t("+ ליד", "+ Lead")}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setDeal({ title: t(`עסקה – ${c.fullName}`, `Deal – ${c.fullName}`), amount: "", stage: "new" }); setDealOpen(true); }}>{t("+ עסקה", "+ Deal")}</Button>
          {me?.modules.messaging && <Button variant="secondary" size="sm" disabled={c.suppression.fullyBlocked || c.isBlocked} onClick={() => setShowChat(true)} data-testid="card-whatsapp">{t("שלח WhatsApp", "Send WhatsApp")}</Button>}
          {me?.modules.telephony && <Button variant="good" size="sm" disabled={!canDial} onClick={() => dial({ mode: "manual", contactId: c.id })}>{t("חייג", "Call")}</Button>}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="space-y-4">
          <Panel title={t("פרטים", "Details")}>
            {edit ? (
              <div className="space-y-2">
                <Input label={t("שם", "Name")} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                <Input label={t("טלפון ראשי", "Primary phone")} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} ltr />
                <Input label={t("אימייל", "Email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
                <Input label={t("חברה", "Company")} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
                <Input label={t("עיר", "City")} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                <Input label={t("מקור", "Source")} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
                {isManager && <Select label={t("נציג אחראי", "Owner")} value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}><option value="">{t("ללא", "None")}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
                <Textarea label={t("הערות קבועות", "Permanent notes")} rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                <div className="border-t border-line pt-2 space-y-1">
                  <span className="text-xs text-muted">{t("שדות מותאמים (זמינים כמשתנים", "Custom fields (available as variables")} {t("{{custom.שם}}", "{{custom.name}}")} {t("ובסינון קהלים)", "and in audience filters)")}</span>
                  {custom.map((f, i) => <div key={i} className="flex gap-1"><Input placeholder={t("שם שדה", "Field name")} value={f.key} onChange={(e) => setCustom(custom.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} /><Input placeholder={t("ערך", "Value")} value={f.value} onChange={(e) => setCustom(custom.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} /><Button variant="ghost" size="sm" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>{t("הסר", "Remove")}</Button></div>)}
                  <Button variant="ghost" size="sm" disabled={custom.length >= 50} onClick={() => setCustom([...custom, { key: "", value: "" }])}>{t("+ הוסף שדה", "+ Add field")}</Button>
                </div>
              </div>
            ) : (
              <dl className="text-sm space-y-2">
                {[["אימייל", "Email", c.email], ["חברה", "Company", c.company], ["עיר", "City", c.city], ["מקור", "Source", c.source], ["נציג אחראי", "Owner", c.owner?.fullName], ["נוצר", "Created", formatDateTime(c.createdAt)], ["פעילות אחרונה", "Last activity", c.lastActivityAt ? relativeTime(c.lastActivityAt) : null]].map(([k, en, v]) => (
                  <div key={k as string} className="flex justify-between gap-3"><dt className="text-muted">{t(k as string, en as string)}</dt><dd className={cx(k === "אימייל" && "ltr")}>{v || "—"}</dd></div>
                ))}
                {c.customFields && Object.keys(c.customFields).length > 0 && <div className="border-t border-line pt-2 space-y-1">{Object.entries(c.customFields).map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd>{v === null || v === undefined || v === "" ? "—" : String(v)}</dd></div>)}</div>}
                {c.notes && <p className="text-xs text-muted whitespace-pre-wrap border-t border-line pt-2">{c.notes}</p>}
              </dl>
            )}
            <div className="mt-3 border-t border-line pt-3">
              <div className="flex items-center justify-between"><p className="text-xs text-muted">{t("טלפונים ואימיילים נוספים", "Additional phones and emails")}</p><Button size="sm" variant="ghost" onClick={() => setPhoneOpen(true)}>{t("+ הוסף", "+ Add")}</Button></div>
              {c.phones.length === 0 && c.emails.length === 0 && <p className="text-xs text-muted">{t("אין", "None")}</p>}
              {c.phones.map((p) => <div key={p.id} className="flex items-center justify-between text-sm py-0.5"><span><Phone value={formatPhone(p.e164)} />{p.label && <span className="text-muted text-xs ms-2">{p.label}</span>}</span><button className="text-xs text-muted hover:text-bad" onClick={() => api.delete(`/api/contacts/${id}/phones`, { phoneId: p.id }).then(load).catch((e) => toast.error(e.message))}>{t("הסר", "Remove")}</button></div>)}
              {c.emails.map((e) => <div key={e.id} className="flex items-center justify-between text-sm py-0.5"><span className="ltr">{e.email}{e.label && <span className="text-muted text-xs ms-2">{e.label}</span>}</span><button className="text-xs text-muted hover:text-bad" onClick={() => api.delete(`/api/contacts/${id}/emails`, { emailId: e.id }).then(load).catch((err) => toast.error(err.message))}>{t("הסר", "Remove")}</button></div>)}
            </div>
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-xs text-muted mb-1">{t("תגיות", "Tags")}</p>
              <div className="flex flex-wrap gap-1 mb-2">{c.tags.map((tg) => <span key={tg.id} className="px-1.5 h-6 rounded text-[11px] inline-flex items-center gap-1" style={{ background: `${tg.color}33`, color: tg.color }}>{tg.name}<button onClick={() => removeTag(tg.id)} aria-label={t(`הסר תגית ${tg.name}`, `Remove tag ${tg.name}`)}>×</button></span>)}</div>
              <div className="flex gap-1"><Input placeholder={t("תגית חדשה", "New tag")} value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()} /><Button size="sm" variant="secondary" onClick={addTag} disabled={!tagInput.trim()}>{t("הוסף", "Add")}</Button></div>
            </div>
            {c.queueLeads.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-xs text-muted mb-1">{t("רשימות חיוג", "Dial lists")}</p>
                {c.queueLeads.map((l) => <div key={l.id} className="flex justify-between text-xs py-0.5"><Link href={`/lists/${l.list.id}`} className="hover:underline">{l.list.name}</Link><span className="text-muted">{l.status} · {l.attempts} {t("ניסיונות", "attempts")}</span></div>)}
              </div>
            )}
          </Panel>

          <Panel title={t("דיוור והסכמה", "Marketing & consent")}>
            <dl className="text-sm space-y-1">
              <div className="flex justify-between"><dt className="text-muted">{t("סטטוס", "Status")}</dt><dd>{c.consentStatus === "OPTED_IN" ? t("הסכמה", "Consent") : c.consentStatus === "OPTED_OUT" ? t("הוסר", "Opted out") : t("לא ידוע", "Unknown")}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">{t("מקור / מועד", "Source / date")}</dt><dd>{c.consentSource ?? "—"} · {c.consentAt ? formatDateTime(c.consentAt) : "—"}</dd></div>
              {c.consentEvidence && <div className="flex justify-between gap-2"><dt className="text-muted">{t("אסמכתה", "Evidence")}</dt><dd className="text-xs text-end">{c.consentEvidence}</dd></div>}
            </dl>
            {c.suppression.active.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {c.suppression.active.map((s) => <li key={s.id} className="flex items-center gap-2"><Badge tone="bad">{s.scope === "all" ? t("לא ליצור קשר", "Do not contact") : t("שיווקי", "Marketing")}</Badge><span className="ltr">{s.identifier.includes("@") ? s.identifier : formatPhone(s.identifier)}</span><span className="text-muted">{s.source}{s.reason ? ` · ${s.reason}` : ""} · {formatDateTime(s.createdAt)}</span></li>)}
              </ul>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              {!c.suppression.marketingBlocked && <Button size="sm" variant="secondary" onClick={() => setSuppressOpen("marketing")}>{t("הסר מדיוור שיווקי", "Unsubscribe from marketing")}</Button>}
              {!c.suppression.fullyBlocked && <Button size="sm" variant="danger" onClick={() => setSuppressOpen("all")}>{t("לא ליצור קשר (כל הערוצים)", "Do not contact (all channels)")}</Button>}
              {(c.suppression.marketingBlocked || c.suppression.fullyBlocked) && isManager && <Button size="sm" variant="secondary" onClick={() => setSuppressOpen("revoke")}>{t("חזרה לדיוור (עם תיעוד הסכמה)", "Resubscribe (with consent record)")}</Button>}
            </div>
            <p className="text-[11px] text-muted mt-2">{t("ההסרה חלה על כל הטלפונים והאימיילים של איש הקשר, בכל ערוץ, ואינה מתבטלת בייבוא או בהחלפת ספק.", "The removal applies to all of the contact's phones and emails, on every channel, and isn't undone by an import or a provider change.")}</p>
          </Panel>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {leadEdit && (
            <Panel title={t("הליד", "Lead")} actions={<div className="flex items-center gap-2"><Badge tone={leadEdit.status === "new" ? "info" : leadEdit.status === "qualified" ? "good" : ["lost", "unqualified"].includes(leadEdit.status) ? "bad" : "neutral"}>{statuses.label(leadEdit.status)}</Badge><Button size="sm" onClick={saveLead} data-testid="lead-save">{t("שמור", "Save")}</Button></div>}>
              <div className="grid md:grid-cols-3 gap-2">
                {leadMeta?.closeReason && <div role="status" className="md:col-span-3 lead-transfer-note" data-testid="lead-close-reason">{t("נסגר אוטומטית:", "Closed automatically:")} {leadMeta.closeReason}</div>}
                {leadMeta && <div className="md:col-span-3 lead-dial-summary" data-testid="lead-dial-summary">
                  {leadMeta.pendingTransfer && <div className="lead-transfer-note">⇄ {t(`הליד בשיחה פעילה – יועבר ל${leadMeta.pendingTransfer.to ?? "נציג אחר"} בסיום השיחה`, `The lead is on an active call – it will be transferred to ${leadMeta.pendingTransfer.to ?? "another agent"} when the call ends`)}</div>}
                  <div><span>{t("ניסיונות חיוג", "Dial attempts")}</span><AttemptsCell limit={leadMeta.attemptLimit} count={leadMeta.attempts} lastAt={leadMeta.lastAttemptAt} tz={leadMeta.timezone} onOpen={() => setLeadModal("attempts")} /></div>
                  <div><span>{t("ניסיון אחרון", "Last attempt")}</span><b dir="ltr">{leadMeta.lastAttemptAt ? fmtBiz(leadMeta.timezone, leadMeta.lastAttemptAt, loc) : "—"}</b></div>
                  <div><span>{t("פולואפ", "Follow-up")}</span><FollowUpBadge followUp={leadMeta.followUp} needsSchedule={leadMeta.needsSchedule} tz={leadMeta.timezone} onClick={() => setLeadModal("followup")} /><button className="lead-link" onClick={() => setLeadModal("followup")}>{leadMeta.followUp ? t("ערוך", "Edit") : t("קבע פולואפ", "Set follow-up")}</button></div>
                </div>}
                {leadModal === "followup" && <FollowUpModal leadId={leadEdit.id} name={c.fullName} tz={leadMeta?.timezone} current={leadMeta?.followUp} onClose={() => setLeadModal(null)} onSaved={() => load()} />}
                {leadModal === "deal" && <DealCloseModal contactId={c.id} leadId={leadEdit.id} name={c.fullName} onClose={() => setLeadModal(null)} onDone={() => load()} />}
                {leadModal === "attempts" && <AttemptsModal leadId={leadEdit.id} name={c.fullName} tz={leadMeta?.timezone} onClose={() => setLeadModal(null)} />}
                <Input label={t("כותרת", "Title")} value={leadEdit.title} onChange={(e) => setLeadEdit({ ...leadEdit, title: e.target.value })} />
                <Select label={t("סטטוס", "Status")} value={leadEdit.status} onChange={(e) => { if (e.target.value === "follow_up" && leadEdit.status !== "follow_up") setLeadModal("followup"); else if (e.target.value === "converted" && leadEdit.status !== "converted") setLeadModal("deal"); else setLeadEdit({ ...leadEdit, status: e.target.value }); }} data-testid="lead-status">{statuses.items.filter((st) => !st.hidden || st.key === leadEdit.status).map((st) => <option key={st.key} value={st.key}>{st.label}</option>)}</Select>
                <Input label={t("מקור", "Source")} value={leadEdit.source} onChange={(e) => setLeadEdit({ ...leadEdit, source: e.target.value })} />
                <Input label={t("עדיפות (0–100)", "Priority (0–100)")} type="number" value={String(leadEdit.priority)} onChange={(e) => setLeadEdit({ ...leadEdit, priority: Number(e.target.value) })} />
                {isManager ? <Select label={t("נציג אחראי", "Owner")} value={leadEdit.ownerUserId} onChange={(e) => setLeadEdit({ ...leadEdit, ownerUserId: e.target.value })}><option value="">{t("ללא", "None")}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select> : <Input label={t("נציג אחראי", "Owner")} value={users.find((u) => u.id === leadEdit.ownerUserId)?.fullName ?? t("ללא", "None")} disabled />}
                <Textarea label={t("הערות לליד", "Lead notes")} rows={2} value={leadEdit.notes} onChange={(e) => setLeadEdit({ ...leadEdit, notes: e.target.value })} className="md:col-span-3" />
              </div>
            </Panel>
          )}
          {showChat && me?.modules.messaging && (
            <Panel title={t("וואטסאפ", "WhatsApp")} actions={<Button size="sm" variant="ghost" onClick={() => setShowChat(false)}>{t("סגור", "Close")}</Button>} bodyClassName="p-0">
              <ContactChat contactId={id} />
            </Panel>
          )}
          <div className="grid md:grid-cols-2 gap-4">
            <Panel title={t(`לידים (${openLeads.length} פתוחים)`, `Leads (${openLeads.length} open)`)} actions={<Link href="/leads" className="text-xs text-accent underline hover:underline">{t("הכול", "All")}</Link>} bodyClassName="p-0">
              {c.leads.length === 0 ? <p className="p-4 text-xs text-muted">{t("אין לידים", "No leads")}</p> : <ul className="divide-y divide-line text-sm">{c.leads.slice(0, 5).map((l) => <li key={l.id} className="px-4 py-2 flex items-center gap-2"><Link href={`/contacts/${id}?lead=${l.id}`} className="hover:underline flex-1 min-w-0 truncate">{l.title ?? l.source ?? t("ליד", "Lead")}</Link><span className="text-xs text-muted">{l.owner?.fullName ?? t("ללא נציג", "No agent")}</span><Badge tone={l.status === "new" ? "info" : l.status === "qualified" ? "good" : ["lost", "unqualified"].includes(l.status) ? "bad" : "neutral"}>{statuses.label(l.status)}</Badge></li>)}</ul>}
            </Panel>
            <Panel title={`${t("עסקאות", "Deals")} (${c.deals.length})`} actions={<Link href="/leads?status=converted" className="text-xs text-accent underline hover:underline">{t("הכול", "All")}</Link>} bodyClassName="p-0">
              {c.deals.length === 0 ? <p className="p-4 text-xs text-muted">{t("אין עסקאות", "No deals")}</p> : <ul className="divide-y divide-line text-sm">{c.deals.slice(0, 5).map((d) => <li key={d.id} className="px-4 py-2 flex items-center gap-2"><Link href={`/deals/${d.id}`} className="hover:underline flex-1 min-w-0 truncate">{d.title}</Link><span className="text-xs tabular">{Number(d.amount).toLocaleString(loc)} {d.currency}</span><Badge tone={d.stage === "won" ? "good" : d.stage === "lost" ? "bad" : "neutral"}>{DEAL_STAGE_LABEL[d.stage as keyof typeof DEAL_STAGE_LABEL]}</Badge></li>)}</ul>}
            </Panel>
          </div>

          <Panel title={`${t("משימות פתוחות", "Open tasks")} (${c.tasks.length})`} bodyClassName="p-0">
            {c.tasks.length === 0 ? <p className="p-4 text-xs text-muted">{t("אין משימות פתוחות", "No open tasks")}</p> : <ul className="divide-y divide-line text-sm">{c.tasks.map((tk) => { const overdue = new Date(tk.dueAt).getTime() < now; return <li key={tk.id} className="px-4 py-2 flex items-center gap-3"><div className="flex-1 min-w-0"><p className="truncate">{tk.title ?? (tk.type === "callback" ? t("חזרה טלפונית", "Callback") : t("משימה", "Task"))}{tk.note ? <span className="text-muted"> · {tk.note}</span> : null}</p><p className={cx("text-xs tabular", overdue ? "text-bad" : "text-muted")}>{formatDateTime(tk.dueAt)} · {tk.user.fullName}</p></div><Button size="sm" variant="secondary" onClick={() => setTaskStatus(tk.id, "done")}>{t("בוצע", "Done")}</Button><Button size="sm" variant="ghost" onClick={() => setTaskStatus(tk.id, "cancelled")}>{t("בטל", "Cancel")}</Button></li>; })}</ul>}
          </Panel>

          {me?.modules.messaging && (
            <Panel title={`${t("התכתבויות", "Conversations")} (${c.conversations.length})`} bodyClassName="p-0">
              {c.conversations.length === 0 ? <p className="p-4 text-xs text-muted">{t("אין התכתבויות – לחץ \"שלח WhatsApp\" כדי לפתוח שיחה", "No conversations – click \"Send WhatsApp\" to start one")}</p> : <ul className="divide-y divide-line text-sm">{c.conversations.map((v) => <li key={v.id} className="px-4 py-2 flex items-center gap-3"><Link href={`/inbox/${v.id}`} className="flex-1 min-w-0"><p className="truncate">{v.messages[0]?.body ?? "—"}</p><p className="text-xs text-muted">{v.channel === "whatsapp" ? "WhatsApp" : v.channel} · {v.providerCredential?.label ?? v.providerCredential?.displayPhoneNumber ?? t("הדגמה", "Demo")} · {v.assignedAgent?.fullName ?? t("לא משויך", "Unassigned")} · {v.lastMessageAt ? relativeTime(v.lastMessageAt) : ""}</p></Link>{v.unreadCount > 0 && <Badge tone="warn">{v.unreadCount}</Badge>}<Badge tone={v.status === "OPEN" ? "info" : "neutral"}>{v.status}</Badge></li>)}</ul>}
            </Panel>
          )}

          <Panel title={t("הערה חדשה", "New note")}>
            <div className="flex gap-2"><Textarea rows={2} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder={t("הערה פנימית לכרטיס (לא נשלחת ללקוח)", "Internal note on the card (not sent to the customer)")} /><Button onClick={addNote} disabled={!noteBody.trim()}>{t("שמור", "Save")}</Button></div>
          </Panel>

          <Panel title={t("ציר פעילות", "Activity timeline")} bodyClassName="p-0">
            {!timeline ? <div className="p-4"><Spinner /></div> : timeline.length === 0 ? <EmptyState title={t("אין פעילות עדיין", "No activity yet")} /> : (
              <ul className="divide-y divide-line">
                {timeline.map((it) => (
                  <li key={it.id} className="px-4 py-2 flex gap-3 text-sm">
                    <span className="shrink-0 w-6 text-center" aria-hidden>{KIND_ICON[it.kind]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{it.href ? <Link href={it.href} className="hover:underline">{it.title}</Link> : it.title}</p>
                      {it.body && <p className="text-xs text-muted whitespace-pre-wrap">{it.body}</p>}
                      {it.kind === "call" && it.meta?.recording ? <audio controls preload="none" src={String(it.meta.recording)} className="h-7 w-56 mt-1" /> : null}
                      {it.kind === "call" && typeof it.meta?.talkSeconds === "number" && it.meta.talkSeconds > 0 ? <p className="text-[11px] text-muted">{t("משך:", "Duration:")} {formatDuration(it.meta.talkSeconds as number)}</p> : null}
                    </div>
                    <div className="text-xs text-muted text-end shrink-0 tabular"><p>{formatDateTime(it.at)}</p>{it.actor && <p>{it.actor}</p>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <Modal open={taskOpen} onClose={() => setTaskOpen(false)} title={t("משימה חדשה", "New task")} footer={<><Button variant="ghost" onClick={() => setTaskOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={createTask}>{t("צור", "Create")}</Button></>}>
        <div className="space-y-2">
          <Input label={t("כותרת", "Title")} value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
          <Input label={t("מועד", "Due")} type="datetime-local" value={task.dueAt} onChange={(e) => setTask({ ...task, dueAt: e.target.value })} ltr />
          {isManager && <Select label={t("נציג", "Agent")} value={task.userId} onChange={(e) => setTask({ ...task, userId: e.target.value })}><option value="">{t("אני", "Me")}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
          <Textarea label={t("הערה", "Note")} rows={2} value={task.note} onChange={(e) => setTask({ ...task, note: e.target.value })} />
        </div>
      </Modal>
      <Modal open={leadOpen} onClose={() => setLeadOpen(false)} title={t("ליד חדש", "New lead")} footer={<><Button variant="ghost" onClick={() => setLeadOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={createLead}>{t("צור ליד", "Create lead")}</Button></>}>
        <div className="space-y-2">
          <Input label={t("כותרת (אופציונלי)", "Title (optional)")} value={lead.title} onChange={(e) => setLead({ ...lead, title: e.target.value })} />
          <Input label={t("מקור", "Source")} value={lead.source} onChange={(e) => setLead({ ...lead, source: e.target.value })} />
          {isManager && <Select label={t("נציג", "Agent")} value={lead.ownerUserId} onChange={(e) => setLead({ ...lead, ownerUserId: e.target.value })}><option value="">{t("שיוך אוטומטי", "Automatic assignment")}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
          <p className="text-xs text-muted">{t("ליד ללא נציג משויך אוטומטית ונוצרת משימת פנייה ראשונית.", "A lead without an agent is assigned automatically and a first-contact task is created.")}</p>
        </div>
      </Modal>
      <Modal open={dealOpen} onClose={() => setDealOpen(false)} title={t("עסקה חדשה", "New deal")} footer={<><Button variant="ghost" onClick={() => setDealOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={createDeal} disabled={!deal.title}>{t("צור עסקה", "Create deal")}</Button></>}>
        <div className="space-y-2">
          <Input label={t("כותרת", "Title")} value={deal.title} onChange={(e) => setDeal({ ...deal, title: e.target.value })} />
          <Input label={t("סכום (₪)", "Amount (₪)")} type="number" value={deal.amount} onChange={(e) => setDeal({ ...deal, amount: e.target.value })} ltr />
          <Select label={t("שלב", "Stage")} value={deal.stage} onChange={(e) => setDeal({ ...deal, stage: e.target.value })}>{Object.entries(DEAL_STAGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </div>
      </Modal>
      <Modal open={phoneOpen} onClose={() => setPhoneOpen(false)} title={t("הוספת טלפון / אימייל", "Add phone / email")} footer={<><Button variant="ghost" onClick={() => setPhoneOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={addExtra} disabled={!extra.phone && !extra.email}>{t("הוסף", "Add")}</Button></>}>
        <div className="space-y-2">
          <Input label={t("טלפון נוסף", "Additional phone")} value={extra.phone} onChange={(e) => setExtra({ ...extra, phone: e.target.value })} ltr />
          <Input label={t("אימייל נוסף", "Additional email")} value={extra.email} onChange={(e) => setExtra({ ...extra, email: e.target.value })} ltr />
          <Input label={t("תווית", "Label")} value={extra.label} onChange={(e) => setExtra({ ...extra, label: e.target.value })} />
          <p className="text-xs text-muted">{t("מזהה ששייך לאיש קשר אחר יידחה (זיהוי כפילויות). הסרה קיימת מוחלת גם על המזהה החדש.", "An identifier that belongs to another contact will be rejected (duplicate detection). An existing removal also applies to the new identifier.")}</p>
        </div>
      </Modal>
      <Modal open={Boolean(suppressOpen)} onClose={() => setSuppressOpen(null)} title={suppressOpen === "revoke" ? t("חזרה לדיוור – תיעוד הסכמה מחודשת", "Resubscribe – record renewed consent") : suppressOpen === "all" ? t("לא ליצור קשר", "Do not contact") : t("הסרה מדיוור שיווקי", "Unsubscribe from marketing")} footer={<><Button variant="ghost" onClick={() => setSuppressOpen(null)}>{t("ביטול", "Cancel")}</Button><Button variant={suppressOpen === "revoke" ? "primary" : "danger"} onClick={suppress} disabled={suppressOpen === "revoke" && suppressText.trim().length < 5}>{t("אישור", "Confirm")}</Button></>}>
        {suppressOpen === "revoke" ? (
          <Textarea label={t("אסמכתה להסכמה מחודשת (חובה)", "Evidence of renewed consent (required)")} rows={3} value={suppressText} onChange={(e) => setSuppressText(e.target.value)} placeholder={t("למשל: הלקוח ביקש בשיחה מתאריך… לחזור לקבל עדכונים", "e.g. The customer asked on a call on… to receive updates again")} />
        ) : (
          <><Textarea label={t("סיבה (אופציונלי)", "Reason (optional)")} rows={2} value={suppressText} onChange={(e) => setSuppressText(e.target.value)} /><p className="text-xs text-muted mt-2">{suppressOpen === "all" ? t("חוסם הודעות שיווק ושירות בכל הערוצים וגם שיחות יוצאות (DNC). משימות חזרה פתוחות מבוטלות.", "Blocks marketing and service messages on all channels and outbound calls too (DNC). Open callback tasks are cancelled.") : t("חוסם דיוור שיווקי בכל הערוצים (WhatsApp / SMS / אימייל). הודעות שירות בחלון מענה פעיל ושיחות עדיין אפשריות.", "Blocks marketing on all channels (WhatsApp / SMS / email). Service messages within an active reply window and calls are still possible.")}</p></>
        )}
      </Modal>
    </div>
  );
}
