"use client";

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
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import type { TimelineItem } from "@/lib/crm/timeline";
import { ContactChat } from "@/components/contacts/ContactChat";

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
  suppression: { marketingBlocked: boolean; fullyBlocked: boolean; active: Array<{ id: string; identifier: string; identifierType?: string; scope: string; source: string; reason: string | null; createdAt: string }>; history: Array<{ id: string; identifier: string; scope: string; source: string; reason: string | null; createdAt: string; revokedAt: string | null; revokeEvidence: string | null }> };
}

const KIND_ICON: Record<TimelineItem["kind"], string> = { call: "📞", message: "💬", note: "📝", task: "✅", lead: "⭐", deal: "💼", event: "⚡" };

export default function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { dial, state } = useDialer();
  const me = useMe();
  const statuses = useLeadStatuses();
  const [c, setC] = useState<Card | null>(null);
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
  const [showChat, setShowChat] = useState(search.get("tab") === "chat");

  const load = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([api.get<Card>(`/api/contacts/${id}`), api.get<{ items: TimelineItem[] }>(`/api/contacts/${id}/timeline`)]);
      setC(r);
      setTimeline(t.items);
      setNow(Date.now());
      setForm({ fullName: r.fullName, phone: r.phoneE164, email: r.email ?? "", company: r.company ?? "", city: r.city ?? "", source: r.source ?? "", notes: r.notes ?? "", ownerUserId: r.owner?.id ?? "" });
      setCustom(Object.entries(r.customFields ?? {}).map(([key, value]) => ({ key, value: value === null || value === undefined ? "" : String(value) })));
      const focus = (focusLeadId && r.leads.find((l) => l.id === focusLeadId)) || r.leads.find((l) => ["new", "contacted", "qualified"].includes(l.status)) || null;
      if (focus) {
        const full = await api.get<{ id: string; title: string | null; status: string; source: string | null; priority: number; notes: string | null; owner: { id: string } | null }>(`/api/leads/${focus.id}`);
        setLeadEdit({ id: full.id, title: full.title ?? "", status: full.status, source: full.source ?? "", priority: full.priority, ownerUserId: full.owner?.id ?? "", notes: full.notes ?? "" });
      } else setLeadEdit(null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id, focusLeadId]);
  useEffect(() => { load(); }, [load, state?.wrapUpCall?.id, state?.activeCall?.id]);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((r) => setUsers(r.items)).catch(() => undefined); }, []);

  async function save() {
    try {
      const keys = custom.map((f) => f.key.trim()).filter(Boolean);
      if (new Set(keys).size !== keys.length) throw new Error("שמות שדות מותאמים חייבים להיות ייחודיים");
      await api.patch(`/api/contacts/${id}`, { ...form, ownerUserId: form.ownerUserId || null, customFields: Object.fromEntries(custom.filter((f) => f.key.trim()).map((f) => [f.key.trim(), f.value])) });
      toast.success("נשמר");
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
    try { await api.post("/api/tasks", { contactId: id, title: task.title || undefined, note: task.note || undefined, dueAt: new Date(task.dueAt).toISOString(), userId: task.userId || undefined, type: "todo", requestKey: crypto.randomUUID() }); setTaskOpen(false); toast.success("המשימה נוצרה"); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function setTaskStatus(taskId: string, status: "done" | "cancelled") {
    try { await api.patch(`/api/tasks/${taskId}`, { status }); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function createLead() {
    try { await api.post("/api/leads", { contactId: id, title: lead.title || undefined, source: lead.source || undefined, ownerUserId: lead.ownerUserId || undefined }); setLeadOpen(false); toast.success("הליד נוצר – שיוך ומשימה נוצרים אוטומטית"); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function createDeal() {
    try { await api.post("/api/deals", { contactId: id, title: deal.title, amount: Number(deal.amount || 0), stage: deal.stage }); setDealOpen(false); toast.success("העסקה נוצרה"); load(); } catch (e) { toast.error((e as Error).message); }
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
    try { await api.patch(`/api/leads/${leadEdit.id}`, { title: leadEdit.title, status: leadEdit.status, source: leadEdit.source, priority: leadEdit.priority, notes: leadEdit.notes, ownerUserId: leadEdit.ownerUserId || null }); toast.success("הליד נשמר"); load(); } catch (e) { toast.error((e as Error).message); }
  }

  if (!c) return <div className="flex justify-center p-10"><Spinner /></div>;
  const canDial = Boolean(me?.modules.telephony) && Boolean(state) && !state?.activeCall && !state?.wrapUpCall && !c.isDnc && !c.suppression.fullyBlocked;
  const isManager = me?.user.role === "manager" || me?.user.role === "owner";
  const openLeads = c.leads.filter((l) => ["new", "contacted", "qualified"].includes(l.status));

  return (
    <div className="p-5 space-y-4 max-w-6xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{c.fullName}</h1>
        <Phone value={formatPhone(c.phoneE164)} className="text-accent underline" />
        {c.company && <span className="text-muted text-sm">{c.company}</span>}
        {c.suppression.fullyBlocked ? <Badge tone="bad">לא ליצור קשר</Badge> : c.suppression.marketingBlocked ? <Badge tone="bad">הוסר מדיוור שיווקי</Badge> : c.consentStatus === "OPTED_IN" ? <Badge tone="good">הסכמה לדיוור</Badge> : <Badge tone="neutral">ללא הסכמה לדיוור</Badge>}
        {c.isDnc && !c.suppression.fullyBlocked && <Badge tone="bad">DNC שיחות{c.dncReason ? ` · ${c.dncReason}` : ""}</Badge>}
        <div className="ms-auto flex flex-wrap gap-2">
          {edit ? <><Button variant="ghost" size="sm" onClick={() => setEdit(false)}>ביטול</Button><Button size="sm" onClick={save}>שמור</Button></> : <Button variant="secondary" size="sm" onClick={() => setEdit(true)}>עריכה</Button>}
          <Button variant="secondary" size="sm" onClick={() => setTaskOpen(true)}>+ משימה</Button>
          <Button variant="secondary" size="sm" onClick={() => { setLead({ title: "", source: c.source ?? "", ownerUserId: "" }); setLeadOpen(true); }}>+ ליד</Button>
          <Button variant="secondary" size="sm" onClick={() => { setDeal({ title: `עסקה – ${c.fullName}`, amount: "", stage: "new" }); setDealOpen(true); }}>+ עסקה</Button>
          {me?.modules.messaging && <Button variant="secondary" size="sm" disabled={c.suppression.fullyBlocked || c.isBlocked} onClick={() => setShowChat(true)} data-testid="card-whatsapp">שלח WhatsApp</Button>}
          {me?.modules.telephony && <Button variant="good" size="sm" disabled={!canDial} onClick={() => dial({ mode: "manual", contactId: c.id })}>חייג</Button>}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="space-y-4">
          <Panel title="פרטים">
            {edit ? (
              <div className="space-y-2">
                <Input label="שם" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                <Input label="טלפון ראשי" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} ltr />
                <Input label="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
                <Input label="חברה" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
                <Input label="עיר" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                <Input label="מקור" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
                {isManager && <Select label="נציג אחראי" value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}><option value="">ללא</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
                <Textarea label="הערות קבועות" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                <div className="border-t border-line pt-2 space-y-1">
                  <span className="text-xs text-muted">שדות מותאמים (זמינים כמשתנים {"{{custom.שם}}"} ובסינון קהלים)</span>
                  {custom.map((f, i) => <div key={i} className="flex gap-1"><Input placeholder="שם שדה" value={f.key} onChange={(e) => setCustom(custom.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} /><Input placeholder="ערך" value={f.value} onChange={(e) => setCustom(custom.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} /><Button variant="ghost" size="sm" onClick={() => setCustom(custom.filter((_, j) => j !== i))}>הסר</Button></div>)}
                  <Button variant="ghost" size="sm" disabled={custom.length >= 50} onClick={() => setCustom([...custom, { key: "", value: "" }])}>+ הוסף שדה</Button>
                </div>
              </div>
            ) : (
              <dl className="text-sm space-y-2">
                {[["אימייל", c.email], ["חברה", c.company], ["עיר", c.city], ["מקור", c.source], ["נציג אחראי", c.owner?.fullName], ["נוצר", formatDateTime(c.createdAt)], ["פעילות אחרונה", c.lastActivityAt ? relativeTime(c.lastActivityAt) : null]].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className={cx(k === "אימייל" && "ltr")}>{v || "—"}</dd></div>
                ))}
                {c.customFields && Object.keys(c.customFields).length > 0 && <div className="border-t border-line pt-2 space-y-1">{Object.entries(c.customFields).map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd>{v === null || v === undefined || v === "" ? "—" : String(v)}</dd></div>)}</div>}
                {c.notes && <p className="text-xs text-muted whitespace-pre-wrap border-t border-line pt-2">{c.notes}</p>}
              </dl>
            )}
            <div className="mt-3 border-t border-line pt-3">
              <div className="flex items-center justify-between"><p className="text-xs text-muted">טלפונים ואימיילים נוספים</p><Button size="sm" variant="ghost" onClick={() => setPhoneOpen(true)}>+ הוסף</Button></div>
              {c.phones.length === 0 && c.emails.length === 0 && <p className="text-xs text-muted">אין</p>}
              {c.phones.map((p) => <div key={p.id} className="flex items-center justify-between text-sm py-0.5"><span><Phone value={formatPhone(p.e164)} />{p.label && <span className="text-muted text-xs ms-2">{p.label}</span>}</span><button className="text-xs text-muted hover:text-bad" onClick={() => api.delete(`/api/contacts/${id}/phones`, { phoneId: p.id }).then(load).catch((e) => toast.error(e.message))}>הסר</button></div>)}
              {c.emails.map((e) => <div key={e.id} className="flex items-center justify-between text-sm py-0.5"><span className="ltr">{e.email}{e.label && <span className="text-muted text-xs ms-2">{e.label}</span>}</span><button className="text-xs text-muted hover:text-bad" onClick={() => api.delete(`/api/contacts/${id}/emails`, { emailId: e.id }).then(load).catch((err) => toast.error(err.message))}>הסר</button></div>)}
            </div>
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-xs text-muted mb-1">תגיות</p>
              <div className="flex flex-wrap gap-1 mb-2">{c.tags.map((t) => <span key={t.id} className="px-1.5 h-6 rounded text-[11px] inline-flex items-center gap-1" style={{ background: `${t.color}33`, color: t.color }}>{t.name}<button onClick={() => removeTag(t.id)} aria-label={`הסר תגית ${t.name}`}>×</button></span>)}</div>
              <div className="flex gap-1"><Input placeholder="תגית חדשה" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()} /><Button size="sm" variant="secondary" onClick={addTag} disabled={!tagInput.trim()}>הוסף</Button></div>
            </div>
            {c.queueLeads.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-xs text-muted mb-1">רשימות חיוג</p>
                {c.queueLeads.map((l) => <div key={l.id} className="flex justify-between text-xs py-0.5"><Link href={`/lists/${l.list.id}`} className="hover:underline">{l.list.name}</Link><span className="text-muted">{l.status} · {l.attempts} ניסיונות</span></div>)}
              </div>
            )}
          </Panel>

          <Panel title="דיוור והסכמה">
            <dl className="text-sm space-y-1">
              <div className="flex justify-between"><dt className="text-muted">סטטוס</dt><dd>{c.consentStatus === "OPTED_IN" ? "הסכמה" : c.consentStatus === "OPTED_OUT" ? "הוסר" : "לא ידוע"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">מקור / מועד</dt><dd>{c.consentSource ?? "—"} · {c.consentAt ? formatDateTime(c.consentAt) : "—"}</dd></div>
              {c.consentEvidence && <div className="flex justify-between gap-2"><dt className="text-muted">אסמכתה</dt><dd className="text-xs text-end">{c.consentEvidence}</dd></div>}
            </dl>
            {c.suppression.active.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {c.suppression.active.map((s) => <li key={s.id} className="flex items-center gap-2"><Badge tone="bad">{s.scope === "all" ? "לא ליצור קשר" : "שיווקי"}</Badge><span className="ltr">{s.identifier.includes("@") ? s.identifier : formatPhone(s.identifier)}</span><span className="text-muted">{s.source}{s.reason ? ` · ${s.reason}` : ""} · {formatDateTime(s.createdAt)}</span></li>)}
              </ul>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              {!c.suppression.marketingBlocked && <Button size="sm" variant="secondary" onClick={() => setSuppressOpen("marketing")}>הסר מדיוור שיווקי</Button>}
              {!c.suppression.fullyBlocked && <Button size="sm" variant="danger" onClick={() => setSuppressOpen("all")}>לא ליצור קשר (כל הערוצים)</Button>}
              {(c.suppression.marketingBlocked || c.suppression.fullyBlocked) && isManager && <Button size="sm" variant="secondary" onClick={() => setSuppressOpen("revoke")}>חזרה לדיוור (עם תיעוד הסכמה)</Button>}
            </div>
            <p className="text-[11px] text-muted mt-2">ההסרה חלה על כל הטלפונים והאימיילים של איש הקשר, בכל ערוץ, ואינה מתבטלת בייבוא או בהחלפת ספק.</p>
          </Panel>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {leadEdit && (
            <Panel title="הליד" actions={<div className="flex items-center gap-2"><Badge tone={leadEdit.status === "new" ? "info" : leadEdit.status === "qualified" ? "good" : ["lost", "unqualified"].includes(leadEdit.status) ? "bad" : "neutral"}>{statuses.label(leadEdit.status)}</Badge><Button size="sm" onClick={saveLead} data-testid="lead-save">שמור</Button></div>}>
              <div className="grid md:grid-cols-3 gap-2">
                <Input label="כותרת" value={leadEdit.title} onChange={(e) => setLeadEdit({ ...leadEdit, title: e.target.value })} />
                <Select label="סטטוס" value={leadEdit.status} onChange={(e) => setLeadEdit({ ...leadEdit, status: e.target.value })} data-testid="lead-status">{statuses.items.map((st) => <option key={st.key} value={st.key}>{st.label}</option>)}</Select>
                <Input label="מקור" value={leadEdit.source} onChange={(e) => setLeadEdit({ ...leadEdit, source: e.target.value })} />
                <Input label="עדיפות (0–100)" type="number" value={String(leadEdit.priority)} onChange={(e) => setLeadEdit({ ...leadEdit, priority: Number(e.target.value) })} />
                {isManager ? <Select label="נציג אחראי" value={leadEdit.ownerUserId} onChange={(e) => setLeadEdit({ ...leadEdit, ownerUserId: e.target.value })}><option value="">ללא</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select> : <Input label="נציג אחראי" value={users.find((u) => u.id === leadEdit.ownerUserId)?.fullName ?? "ללא"} disabled />}
                <Textarea label="הערות לליד" rows={2} value={leadEdit.notes} onChange={(e) => setLeadEdit({ ...leadEdit, notes: e.target.value })} className="md:col-span-3" />
              </div>
            </Panel>
          )}
          {showChat && me?.modules.messaging && (
            <Panel title="וואטסאפ" actions={<Button size="sm" variant="ghost" onClick={() => setShowChat(false)}>סגור</Button>} bodyClassName="p-0">
              <ContactChat contactId={id} />
            </Panel>
          )}
          <div className="grid md:grid-cols-2 gap-4">
            <Panel title={`לידים (${openLeads.length} פתוחים)`} actions={<Link href="/leads" className="text-xs text-accent underline hover:underline">הכול</Link>} bodyClassName="p-0">
              {c.leads.length === 0 ? <p className="p-4 text-xs text-muted">אין לידים</p> : <ul className="divide-y divide-line text-sm">{c.leads.slice(0, 5).map((l) => <li key={l.id} className="px-4 py-2 flex items-center gap-2"><Link href={`/contacts/${id}?lead=${l.id}`} className="hover:underline flex-1 min-w-0 truncate">{l.title ?? l.source ?? "ליד"}</Link><span className="text-xs text-muted">{l.owner?.fullName ?? "ללא נציג"}</span><Badge tone={l.status === "new" ? "info" : l.status === "qualified" ? "good" : ["lost", "unqualified"].includes(l.status) ? "bad" : "neutral"}>{statuses.label(l.status)}</Badge></li>)}</ul>}
            </Panel>
            <Panel title={`עסקאות (${c.deals.length})`} actions={<Link href="/deals" className="text-xs text-accent underline hover:underline">הכול</Link>} bodyClassName="p-0">
              {c.deals.length === 0 ? <p className="p-4 text-xs text-muted">אין עסקאות</p> : <ul className="divide-y divide-line text-sm">{c.deals.slice(0, 5).map((d) => <li key={d.id} className="px-4 py-2 flex items-center gap-2"><Link href={`/deals/${d.id}`} className="hover:underline flex-1 min-w-0 truncate">{d.title}</Link><span className="text-xs tabular">{Number(d.amount).toLocaleString("he-IL")} {d.currency}</span><Badge tone={d.stage === "won" ? "good" : d.stage === "lost" ? "bad" : "neutral"}>{DEAL_STAGE_LABEL[d.stage as keyof typeof DEAL_STAGE_LABEL]}</Badge></li>)}</ul>}
            </Panel>
          </div>

          <Panel title={`משימות פתוחות (${c.tasks.length})`} bodyClassName="p-0">
            {c.tasks.length === 0 ? <p className="p-4 text-xs text-muted">אין משימות פתוחות</p> : <ul className="divide-y divide-line text-sm">{c.tasks.map((t) => { const overdue = new Date(t.dueAt).getTime() < now; return <li key={t.id} className="px-4 py-2 flex items-center gap-3"><div className="flex-1 min-w-0"><p className="truncate">{t.title ?? (t.type === "callback" ? "חזרה טלפונית" : "משימה")}{t.note ? <span className="text-muted"> · {t.note}</span> : null}</p><p className={cx("text-xs tabular", overdue ? "text-bad" : "text-muted")}>{formatDateTime(t.dueAt)} · {t.user.fullName}</p></div><Button size="sm" variant="secondary" onClick={() => setTaskStatus(t.id, "done")}>בוצע</Button><Button size="sm" variant="ghost" onClick={() => setTaskStatus(t.id, "cancelled")}>בטל</Button></li>; })}</ul>}
          </Panel>

          {me?.modules.messaging && (
            <Panel title={`התכתבויות (${c.conversations.length})`} bodyClassName="p-0">
              {c.conversations.length === 0 ? <p className="p-4 text-xs text-muted">אין התכתבויות – לחץ &quot;שלח WhatsApp&quot; כדי לפתוח שיחה</p> : <ul className="divide-y divide-line text-sm">{c.conversations.map((v) => <li key={v.id} className="px-4 py-2 flex items-center gap-3"><Link href={`/inbox/${v.id}`} className="flex-1 min-w-0"><p className="truncate">{v.messages[0]?.body ?? "—"}</p><p className="text-xs text-muted">{v.channel === "whatsapp" ? "WhatsApp" : v.channel} · {v.providerCredential?.label ?? v.providerCredential?.displayPhoneNumber ?? "הדגמה"} · {v.assignedAgent?.fullName ?? "לא משויך"} · {v.lastMessageAt ? relativeTime(v.lastMessageAt) : ""}</p></Link>{v.unreadCount > 0 && <Badge tone="warn">{v.unreadCount}</Badge>}<Badge tone={v.status === "OPEN" ? "info" : "neutral"}>{v.status}</Badge></li>)}</ul>}
            </Panel>
          )}

          <Panel title="הערה חדשה">
            <div className="flex gap-2"><Textarea rows={2} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="הערה פנימית לכרטיס (לא נשלחת ללקוח)" /><Button onClick={addNote} disabled={!noteBody.trim()}>שמור</Button></div>
          </Panel>

          <Panel title="ציר פעילות" bodyClassName="p-0">
            {!timeline ? <div className="p-4"><Spinner /></div> : timeline.length === 0 ? <EmptyState title="אין פעילות עדיין" /> : (
              <ul className="divide-y divide-line">
                {timeline.map((it) => (
                  <li key={it.id} className="px-4 py-2 flex gap-3 text-sm">
                    <span className="shrink-0 w-6 text-center" aria-hidden>{KIND_ICON[it.kind]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{it.href ? <Link href={it.href} className="hover:underline">{it.title}</Link> : it.title}</p>
                      {it.body && <p className="text-xs text-muted whitespace-pre-wrap">{it.body}</p>}
                      {it.kind === "call" && it.meta?.recording ? <audio controls preload="none" src={String(it.meta.recording)} className="h-7 w-56 mt-1" /> : null}
                      {it.kind === "call" && typeof it.meta?.talkSeconds === "number" && it.meta.talkSeconds > 0 ? <p className="text-[11px] text-muted">משך: {formatDuration(it.meta.talkSeconds as number)}</p> : null}
                    </div>
                    <div className="text-xs text-muted text-end shrink-0 tabular"><p>{formatDateTime(it.at)}</p>{it.actor && <p>{it.actor}</p>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <Modal open={taskOpen} onClose={() => setTaskOpen(false)} title="משימה חדשה" footer={<><Button variant="ghost" onClick={() => setTaskOpen(false)}>ביטול</Button><Button onClick={createTask}>צור</Button></>}>
        <div className="space-y-2">
          <Input label="כותרת" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
          <Input label="מועד" type="datetime-local" value={task.dueAt} onChange={(e) => setTask({ ...task, dueAt: e.target.value })} ltr />
          {isManager && <Select label="נציג" value={task.userId} onChange={(e) => setTask({ ...task, userId: e.target.value })}><option value="">אני</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
          <Textarea label="הערה" rows={2} value={task.note} onChange={(e) => setTask({ ...task, note: e.target.value })} />
        </div>
      </Modal>
      <Modal open={leadOpen} onClose={() => setLeadOpen(false)} title="ליד חדש" footer={<><Button variant="ghost" onClick={() => setLeadOpen(false)}>ביטול</Button><Button onClick={createLead}>צור ליד</Button></>}>
        <div className="space-y-2">
          <Input label="כותרת (אופציונלי)" value={lead.title} onChange={(e) => setLead({ ...lead, title: e.target.value })} />
          <Input label="מקור" value={lead.source} onChange={(e) => setLead({ ...lead, source: e.target.value })} />
          {isManager && <Select label="נציג" value={lead.ownerUserId} onChange={(e) => setLead({ ...lead, ownerUserId: e.target.value })}><option value="">שיוך אוטומטי</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
          <p className="text-xs text-muted">ליד ללא נציג משויך אוטומטית ונוצרת משימת פנייה ראשונית.</p>
        </div>
      </Modal>
      <Modal open={dealOpen} onClose={() => setDealOpen(false)} title="עסקה חדשה" footer={<><Button variant="ghost" onClick={() => setDealOpen(false)}>ביטול</Button><Button onClick={createDeal} disabled={!deal.title}>צור עסקה</Button></>}>
        <div className="space-y-2">
          <Input label="כותרת" value={deal.title} onChange={(e) => setDeal({ ...deal, title: e.target.value })} />
          <Input label="סכום (₪)" type="number" value={deal.amount} onChange={(e) => setDeal({ ...deal, amount: e.target.value })} ltr />
          <Select label="שלב" value={deal.stage} onChange={(e) => setDeal({ ...deal, stage: e.target.value })}>{Object.entries(DEAL_STAGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </div>
      </Modal>
      <Modal open={phoneOpen} onClose={() => setPhoneOpen(false)} title="הוספת טלפון / אימייל" footer={<><Button variant="ghost" onClick={() => setPhoneOpen(false)}>ביטול</Button><Button onClick={addExtra} disabled={!extra.phone && !extra.email}>הוסף</Button></>}>
        <div className="space-y-2">
          <Input label="טלפון נוסף" value={extra.phone} onChange={(e) => setExtra({ ...extra, phone: e.target.value })} ltr />
          <Input label="אימייל נוסף" value={extra.email} onChange={(e) => setExtra({ ...extra, email: e.target.value })} ltr />
          <Input label="תווית" value={extra.label} onChange={(e) => setExtra({ ...extra, label: e.target.value })} />
          <p className="text-xs text-muted">מזהה ששייך לאיש קשר אחר יידחה (זיהוי כפילויות). הסרה קיימת מוחלת גם על המזהה החדש.</p>
        </div>
      </Modal>
      <Modal open={Boolean(suppressOpen)} onClose={() => setSuppressOpen(null)} title={suppressOpen === "revoke" ? "חזרה לדיוור – תיעוד הסכמה מחודשת" : suppressOpen === "all" ? "לא ליצור קשר" : "הסרה מדיוור שיווקי"} footer={<><Button variant="ghost" onClick={() => setSuppressOpen(null)}>ביטול</Button><Button variant={suppressOpen === "revoke" ? "primary" : "danger"} onClick={suppress} disabled={suppressOpen === "revoke" && suppressText.trim().length < 5}>אישור</Button></>}>
        {suppressOpen === "revoke" ? (
          <Textarea label="אסמכתה להסכמה מחודשת (חובה)" rows={3} value={suppressText} onChange={(e) => setSuppressText(e.target.value)} placeholder="למשל: הלקוח ביקש בשיחה מתאריך… לחזור לקבל עדכונים" />
        ) : (
          <><Textarea label="סיבה (אופציונלי)" rows={2} value={suppressText} onChange={(e) => setSuppressText(e.target.value)} /><p className="text-xs text-muted mt-2">{suppressOpen === "all" ? "חוסם הודעות שיווק ושירות בכל הערוצים וגם שיחות יוצאות (DNC). משימות חזרה פתוחות מבוטלות." : "חוסם דיוור שיווקי בכל הערוצים (WhatsApp / SMS / אימייל). הודעות שירות בחלון מענה פעיל ושיחות עדיין אפשריות."}</p></>
        )}
      </Modal>
    </div>
  );
}
