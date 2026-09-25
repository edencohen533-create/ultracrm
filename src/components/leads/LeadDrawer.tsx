"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, MessageCircle, Pencil, Phone, PhoneMissed, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { formatDateTime, formatDuration, formatPhone, CALL_STATUS_LABEL } from "@/lib/client/format";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/crm/labels";
import { Button, Input, Spinner } from "@/components/ui";
import { ContactChat } from "@/components/contacts/ContactChat";

interface LeadDetails { id: string; status: string; source: string | null; createdAt: string; notes: string | null; ownerUserId: string | null; contact: { id: string; fullName: string } }
interface Call { id: string; createdAt: string; endedAt: string | null; answeredAt: string | null; direction: string; status: string; talkSeconds: number | null; telephonyResult: string | null; outcomeNote: string | null; recordingStatus: string; user: { fullName: string } }
interface Contact { id: string; fullName: string; phoneE164: string; email: string | null; customFields: Record<string, unknown> | null; notes: string | null; calls: Call[]; noteItems: { id: string; body: string; createdAt: string; author: { fullName: string } }[] }
const value = (fields: Record<string, unknown> | null, key: string) => { const v = fields?.[key]; return typeof v === "string" || typeof v === "number" ? String(v) : "—"; };
const tabs = { details: "פרטים", calls: "סיכומי שיחה", recordings: "הקלטות", missed: "שיחות שלא נענו", chat: "WhatsApp" };
export function LeadDrawer({ leadId, initialTab = "details", users, manager, messaging, canDial, onDial, onClose, onUpdated }: { leadId: string; initialTab?: keyof typeof tabs; users: { id: string; fullName: string }[]; manager: boolean; messaging: boolean; canDial: boolean; onDial: (contactId: string) => void; onClose: () => void; onUpdated: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<keyof typeof tabs>(initialTab);
  const [lead, setLead] = useState<LeadDetails | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", product: "", campaign: "", ad: "" });
  const active = useRef(true);
  const load = useCallback(async () => {
    try { const l = await api.get<LeadDetails>(`/api/leads/${leadId}`); const c = await api.get<Contact>(`/api/contacts/${l.contact.id}`); if (active.current) { setLead(l); setContact(c); setError(""); } }
    catch (e) { if (active.current) setError((e as Error).message); }
  }, [leadId]);
  useEffect(() => { active.current = true; dialog.current?.showModal(); void load(); const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { active.current = false; document.body.style.overflow = previous; }; }, [load]);
  async function updateLead(body: Record<string, unknown>) { setBusy(true); try { await api.patch(`/api/leads/${leadId}`, body); await load(); onUpdated(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function addNote() { if (!contact || !note.trim()) return; setBusy(true); try { await api.post("/api/notes", { contactId: contact.id, body: note.trim() }); setNote(""); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function save() { if (!contact) return; setBusy(true); try { await api.patch(`/api/contacts/${contact.id}`, { fullName: form.fullName, phone: form.phone, email: form.email, customFields: { ...contact.customFields, product: form.product, campaign: form.campaign, ad: form.ad } }); setEditing(false); await load(); onUpdated(); toast.success("הפרטים נשמרו"); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  const calls = (contact?.calls ?? []).filter(c => tab === "recordings" ? c.recordingStatus === "saved" : tab === "missed" ? Boolean(c.endedAt) && !c.answeredAt && !["failed", "cancelled"].includes(c.status) : true);
  return <dialog ref={dialog} className="lead-details-dialog" aria-label="פרטי ליד" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="lead-details-panel"><header><div><h2>{contact?.fullName ?? "פרטי ליד"}</h2>{contact && <Link href={`/contacts/${contact.id}?lead=${leadId}`} aria-label="פתח כרטיס מלא"><ExternalLink size={21}/></Link>}</div><button aria-label="סגור פרטי ליד" disabled={busy} onClick={onClose}><X size={25}/></button></header>
      <nav className="lead-detail-tabs" aria-label="לשוניות פרטי ליד">{Object.entries(tabs).filter(([key]) => key !== "chat" || messaging).map(([key,label]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key as keyof typeof tabs)}>{label}</button>)}</nav>
      <div className="lead-details-body">{error ? <div role="alert" className="lead-error">{error}<button onClick={load}>נסה שוב</button></div> : !contact || !lead ? <div className="p-12 flex justify-center"><Spinner/></div> : <>
        {tab === "details" ? <>
          <div className="lead-detail-actions"><button onClick={() => { setEditing(v => !v); setForm({ fullName: contact.fullName, phone: contact.phoneE164, email: contact.email ?? "", product: value(contact.customFields, "product").replace(/^—$/, ""), campaign: value(contact.customFields, "campaign").replace(/^—$/, ""), ad: value(contact.customFields, "ad").replace(/^—$/, "") }); }}><Pencil size={16}/>ערוך פרטים</button><div>{messaging && <button onClick={() => setTab("chat")}><MessageCircle size={16}/>WhatsApp</button>}<button disabled={!canDial} onClick={() => { onDial(contact.id); onClose(); }}><Phone size={15}/>חייג</button></div></div>
          {editing ? <form className="lead-edit-form" onSubmit={e => { e.preventDefault(); void save(); }}><Input label="שם" value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} required/><Input label="טלפון" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} required ltr/><Input label="אימייל" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} ltr/>{([['product','מוצר'],['campaign','קמפיין'],['ad','מודעה']] as const).map(([key,label]) => <Input key={key} label={label} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}/>)}<div className="flex gap-2"><Button type="submit" loading={busy}>שמור</Button><Button variant="ghost" type="button" onClick={() => setEditing(false)}>ביטול</Button></div></form> : <dl className="lead-details-grid"><div><dt>טלפון</dt><dd dir="ltr">{formatPhone(contact.phoneE164)}</dd></div><div><dt>אימייל</dt><dd dir="ltr">{contact.email ?? "—"}</dd></div><div><dt>מקור</dt><dd>{lead.source ?? "—"}</dd></div><div><dt>מוצר</dt><dd>{value(contact.customFields,"product")}</dd></div><div><dt>קמפיין</dt><dd>{value(contact.customFields,"campaign")}</dd></div><div><dt>מזהה צ׳אט</dt><dd>{value(contact.customFields,"chatId")}</dd></div><div><dt>נוצר</dt><dd>{formatDateTime(lead.createdAt)}</dd></div></dl>}
          <label className="lead-detail-field">סטטוס<select disabled={busy} value={lead.status} onChange={e => updateLead({ status: e.target.value })}>{LEAD_STATUSES.map(s => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</select></label>
          <label className="lead-detail-field">נציג מטפל<select disabled={busy || !manager} value={lead.ownerUserId ?? ""} onChange={e => updateLead({ ownerUserId: e.target.value || null })}><option value="">ללא שיוך</option>{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></label>
          <section className="lead-attribution"><h3>שיווק וייחוס</h3><dl className="lead-details-grid">{[['campaignId','מזהה קמפיין'],['adSet','Ad set'],['ad','מודעה'],['fbc','fbc'],['utm_source','UTM source'],['utm_campaign','UTM campaign']].map(([key,label]) => <div key={key}><dt>{label}</dt><dd>{value(contact.customFields,key)}</dd></div>)}</dl></section>
          <section className="lead-detail-notes"><h3>הערות ({contact.noteItems.length + (contact.notes ? 1 : 0) + (lead.notes ? 1 : 0)})</h3><form onSubmit={e => { e.preventDefault(); void addNote(); }}><input aria-label="הוסף הערה" placeholder="הוסף הערה..." value={note} maxLength={4000} onChange={e => setNote(e.target.value)}/><Button type="submit" loading={busy} disabled={!note.trim()}>הוסף</Button></form>{lead.notes && <article><p>{lead.notes}</p><small>הערות הליד</small></article>}{contact.notes && <article><p>{contact.notes}</p><small>הערות איש הקשר</small></article>}{contact.noteItems.map(n => <article key={n.id}><p>{n.body}</p><small>{n.author.fullName} · {formatDateTime(n.createdAt)}</small></article>)}</section>
        </> : tab === "chat" ? <ContactChat contactId={contact.id}/> : <div className="lead-call-history"><p className="text-xs text-muted mb-4">עד 50 השיחות האחרונות הזמינות לך</p>{calls.length ? calls.map(call => <article key={call.id}><header><strong>{tab === "missed" && <PhoneMissed size={16}/>} {call.user.fullName}</strong><span>{formatDateTime(call.createdAt)}</span></header><p>{call.direction === "inbound" ? "שיחה נכנסת" : "שיחה יוצאת"} · {CALL_STATUS_LABEL[call.status] ?? call.status} · {formatDuration(call.talkSeconds ?? 0)}</p>{call.outcomeNote && <p className="lead-call-note">{call.outcomeNote}</p>}{call.recordingStatus === "saved" && <audio controls preload="none" src={`/api/recordings/${call.id}`} onError={() => toast.error("ההקלטה אינה זמינה כרגע או שאין הרשאה לנגן אותה")}/>}{tab === "calls" && !call.outcomeNote && <p className="text-muted text-xs">לא נוסף סיכום לשיחה זו</p>}</article>) : <div className="lead-drawer-empty">{tab === "recordings" ? "אין הקלטות זמינות לליד זה" : tab === "missed" ? "אין שיחות שלא נענו" : "עדיין אין שיחות עם הליד"}</div>}</div>}
      </>}</div>
    </div>
  </dialog>;
}
