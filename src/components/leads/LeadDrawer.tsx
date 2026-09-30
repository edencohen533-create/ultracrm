"use client";

import { CustomerBanner, type CustomerSummary } from "@/components/contacts/CustomerBanner";
import {LeadSalesContext} from "@/components/sales/LeadSalesContext";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, MessageCircle, Pencil, Phone, PhoneMissed, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { formatDateTime, formatDuration, formatPhone, CALL_STATUS_LABEL } from "@/lib/client/format";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import { Button, Input, Spinner } from "@/components/ui";
import { ContactChat } from "@/components/contacts/ContactChat";
import { DealCloseModal } from "@/components/leads/DealCloseModal";
import { MoveToCampaignModal } from "@/components/leads/MoveToCampaignModal";
import { AvailableNowTag } from "@/components/telephony/AvailableNowTag";
import { AttemptsCell, AttemptsModal, FollowUpBadge, FollowUpModal, TransferModal, type FollowUpInfo } from "@/components/leads/LeadActions";
import { useT } from "@/components/i18n/LangProvider";

interface LeadDetails { history?: Array<{ id: string; at: string; title: string; body: string | null; actor: string | null }>; reopenedAt?: string | null; availableNow?: { signalId: string; at: string; text: string } | null; id: string; status: string; attemptLimit?: number | null; closeReason?: string | null; source: string | null; createdAt: string; notes: string | null; ownerUserId: string | null; contact: { id: string; fullName: string }; attempts: number; lastAttemptAt: string | null; timezone: string; followUp: FollowUpInfo | null; needsSchedule: boolean; pendingTransfer: { to: string | null; at: string } | null }
interface CallDoc { summary: string; timeline: Array<{ from: string; to: string; title: string; details: string }>; customerNeeds: string[]; objections: string[]; agreements: string[]; nextSteps: string[]; sentiment: string | null; source: "ai" | "transcript" }
interface Call { id: string; createdAt: string; endedAt: string | null; answeredAt: string | null; direction: string; status: string; talkSeconds: number | null; telephonyResult: string | null; outcomeNote: string | null; recordingStatus: string; user: { fullName: string }; coachSession?: { documentation: CallDoc | null; documentationStatus?: string | null; documentationError?: string | null } | null }
interface Contact { customer?: CustomerSummary | null; id: string; fullName: string; phoneE164: string; email: string | null; customFields: Record<string, unknown> | null; notes: string | null; calls: Call[]; noteItems: { id: string; body: string; createdAt: string; author: { fullName: string } }[] }
const value = (fields: Record<string, unknown> | null, key: string) => { const v = fields?.[key]; return typeof v === "string" || typeof v === "number" ? String(v) : "—"; };
const tabs: Record<"details" | "calls" | "recordings" | "missed" | "chat", [string, string]> = { details: ["פרטים", "Details"], calls: ["סיכומי שיחה", "Call summaries"], recordings: ["הקלטות", "Recordings"], missed: ["שיחות שלא נענו", "Missed calls"], chat: ["WhatsApp", "WhatsApp"] };
export function LeadDrawer({ leadId, initialTab = "details", users, manager, canTransfer = manager, messaging, canDial, onDial, onClose, onUpdated }: { leadId: string; initialTab?: keyof typeof tabs; users: { id: string; fullName: string }[]; manager: boolean; canTransfer?: boolean; messaging: boolean; canDial: boolean; onDial: (contactId: string) => void; onClose: () => void; onUpdated: () => void }) {
  const statuses = useLeadStatuses();
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<keyof typeof tabs>(initialTab);
  const [lead, setLead] = useState<LeadDetails | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [modal, setModal] = useState<"followup" | "attempts" | "transfer" | "deal" | "move" | null>(null);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", product: "", campaign: "", ad: "" });
  const active = useRef(true);
  const load = useCallback(async () => {
    try { const l = await api.get<LeadDetails>(`/api/leads/${leadId}`); const c = await api.get<Contact>(`/api/contacts/${l.contact.id}`); if (active.current) { setLead(l); setContact(c); setError(""); } }
    catch (e) { if (active.current) setError((e as Error).message); }
  }, [leadId]);
  useEffect(() => { active.current = true; dialog.current?.showModal(); void load(); const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { active.current = false; document.body.style.overflow = previous; }; }, [load]);
  async function updateLead(body: Record<string, unknown>) { setBusy(true); try { await api.patch(`/api/leads/${leadId}`, body); await load(); onUpdated(); return true; } catch (e) { toast.error((e as Error).message); return false; } finally { setBusy(false); } }
  async function addNote() { if (!contact || !note.trim()) return; setBusy(true); try { await api.post("/api/notes", { contactId: contact.id, body: note.trim() }); setNote(""); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function save() { if (!contact) return; setBusy(true); try { await api.patch(`/api/contacts/${contact.id}`, { fullName: form.fullName, phone: form.phone, email: form.email, customFields: { ...contact.customFields, product: form.product, campaign: form.campaign, ad: form.ad } }); setEditing(false); await load(); onUpdated(); toast.success(t("הפרטים נשמרו", "Details saved")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  const calls = (contact?.calls ?? []).filter(c => tab === "recordings" ? c.recordingStatus === "saved" : tab === "missed" ? Boolean(c.endedAt) && !c.answeredAt && !["failed", "cancelled"].includes(c.status) : true);
  return <dialog ref={dialog} className="lead-details-dialog" aria-label={t("פרטי ליד", "Lead details")} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="lead-details-panel"><header><div><h2>{contact?.fullName ?? t("פרטי ליד", "Lead details")}</h2>{contact && <Link href={`/contacts/${contact.id}?lead=${leadId}`} aria-label={t("פתח כרטיס מלא", "Open full card")}><ExternalLink size={21}/></Link>}</div><button aria-label={t("סגור פרטי ליד", "Close lead details")} disabled={busy} onClick={onClose}><X size={25}/></button></header>
      <nav className="lead-detail-tabs" aria-label={t("לשוניות פרטי ליד", "Lead detail tabs")}>{Object.entries(tabs).filter(([key]) => key !== "chat" || messaging).map(([key,label]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key as keyof typeof tabs)}>{t(...label)}</button>)}</nav>
      {lead?.availableNow && <div className="px-4 pt-2"><AvailableNowTag at={lead.availableNow.at} text={lead.availableNow.text} /></div>}
      <div className="lead-details-body">{error ? <div role="alert" className="lead-error">{error}<button onClick={load}>{t("נסה שוב", "Try again")}</button></div> : !contact || !lead ? <div className="p-12 flex justify-center"><Spinner/></div> : <>
        {tab === "details" ? <>
          <div className="lead-detail-actions"><Link href={`/sales?leadId=${encodeURIComponent(leadId)}`}>הצעת מחיר</Link><button onClick={() => { setEditing(v => !v); setForm({ fullName: contact.fullName, phone: contact.phoneE164, email: contact.email ?? "", product: value(contact.customFields, "product").replace(/^—$/, ""), campaign: value(contact.customFields, "campaign").replace(/^—$/, ""), ad: value(contact.customFields, "ad").replace(/^—$/, "") }); }}><Pencil size={16}/>{t("ערוך פרטים", "Edit details")}</button><div>{messaging && <button onClick={() => setTab("chat")}><MessageCircle size={16}/>WhatsApp</button>}<button disabled={!canDial} onClick={() => { onDial(contact.id); onClose(); }}><Phone size={15}/>{t("חייג", "Call")}</button></div></div>
          <CustomerBanner customer={contact.customer} className="mb-3" /><LeadSalesContext leadId={leadId}/>{editing ? <form className="lead-edit-form" onSubmit={e => { e.preventDefault(); void save(); }}><Input label={t("שם", "Name")} value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} required/><Input label={t("טלפון", "Phone")} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} required ltr/><Input label={t("אימייל", "Email")} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} ltr/>{([['product','מוצר','Product'],['campaign','קמפיין','Campaign'],['ad','מודעה','Ad']] as const).map(([key,he,en]) => <Input key={key} label={t(he, en)} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}/>)}<div className="flex gap-2"><Button type="submit" loading={busy}>{t("שמור", "Save")}</Button><Button variant="ghost" type="button" onClick={() => setEditing(false)}>{t("ביטול", "Cancel")}</Button></div></form> : <dl className="lead-details-grid"><div><dt>{t("טלפון", "Phone")}</dt><dd dir="ltr">{formatPhone(contact.phoneE164)}</dd></div><div><dt>{t("אימייל", "Email")}</dt><dd dir="ltr">{contact.email ?? "—"}</dd></div><div><dt>{t("מקור", "Source")}</dt><dd>{lead.source ?? "—"}</dd></div><div><dt>{t("מוצר", "Product")}</dt><dd>{value(contact.customFields,"product")}</dd></div><div><dt>{t("קמפיין", "Campaign")}</dt><dd>{value(contact.customFields,"campaign")}</dd></div><div><dt>{t("מזהה צ׳אט", "Chat ID")}</dt><dd>{value(contact.customFields,"chatId")}</dd></div><div><dt>{t("נוצר", "Created")}</dt><dd>{formatDateTime(lead.createdAt)}</dd></div></dl>}
          {lead.pendingTransfer && <div role="status" className="lead-transfer-note" data-testid="lead-pending-transfer">⇄ {t(`הליד בשיחה פעילה – יועבר ל${lead.pendingTransfer.to ?? "נציג אחר"} מיד בסיום השיחה. עד אז לא ניתן לחייג אליו במקביל.`, `The lead is on an active call – it will be transferred to ${lead.pendingTransfer.to ?? "another agent"} as soon as the call ends. Until then it can't be dialed in parallel.`)}</div>}
          {lead.closeReason && <div role="status" className="lead-transfer-note" data-testid="lead-close-reason">{t("נסגר אוטומטית:", "Closed automatically:")} {lead.closeReason}</div>}<div className="lead-dial-summary" data-testid="lead-dial-summary"><div><span>{t("ניסיונות חיוג", "Dial attempts")}</span><AttemptsCell limit={lead.attemptLimit} count={lead.attempts} lastAt={lead.lastAttemptAt} tz={lead.timezone} onOpen={() => setModal("attempts")} /></div><div><span>{t("ניסיון אחרון", "Last attempt")}</span><b dir="ltr">{lead.lastAttemptAt ? formatDateTime(lead.lastAttemptAt) : "—"}</b></div><div><span>{t("פולואפ", "Follow-up")}</span><FollowUpBadge followUp={lead.followUp} needsSchedule={lead.needsSchedule} tz={lead.timezone} onClick={() => setModal("followup")} /><button className="lead-link" onClick={() => setModal("followup")} data-testid="lead-followup-edit">{lead.followUp ? t("ערוך", "Edit") : t("קבע פולואפ", "Set follow-up")}</button></div>{canTransfer && <div><button className="lead-transfer" onClick={() => setModal("transfer")} data-testid="lead-transfer-open">{t("העבר לנציג", "Transfer to agent")}</button></div>}</div>
          {lead.followUp?.note && <p className="text-xs text-muted">{t("הערה לשיחה:", "Call note:")} {lead.followUp.note}</p>}
          <label className="lead-detail-field">{t("סטטוס", "Status")}<select disabled={busy} value={lead.status} onChange={e => { if (e.target.value === "follow_up") setModal("followup"); else if (e.target.value === "converted") setModal("deal"); else { const v = e.target.value; void updateLead({ status: v }).then((ok) => { if (ok && v === "unqualified") setModal("move"); }); } }}>{statuses.items.filter(s => !s.hidden || s.key === lead.status).map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          <label className="lead-detail-field">{t("נציג מטפל", "Handling agent")}<select disabled={busy || !manager} value={lead.ownerUserId ?? ""} onChange={e => updateLead({ ownerUserId: e.target.value || null })}><option value="">{t("ללא שיוך", "Unassigned")}</option>{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></label>
          <section className="lead-attribution"><h3>{t("שיווק וייחוס", "Marketing & attribution")}</h3><dl className="lead-details-grid">{[['campaignId','מזהה קמפיין','Campaign ID'],['adSet','Ad set','Ad set'],['ad','מודעה','Ad'],['fbc','fbc','fbc'],['utm_source','UTM source','UTM source'],['utm_campaign','UTM campaign','UTM campaign']].map(([key,he,en]) => <div key={key}><dt>{t(he, en)}</dt><dd>{value(contact.customFields,key)}</dd></div>)}</dl></section>
          {lead.history && lead.history.length > 0 && <section className="lead-detail-notes" data-testid="lead-history"><h3>{t("היסטוריית הליד", "Lead history")}</h3>{lead.history.map(h => <article key={h.id}><p><b>{h.title}</b>{h.body ? <><br/>{h.body}</> : null}</p><small>{h.actor ? `${h.actor} · ` : ""}{formatDateTime(h.at)}</small></article>)}</section>}<section className="lead-detail-notes"><h3>{t("הערות", "Notes")} ({contact.noteItems.length + (contact.notes ? 1 : 0) + (lead.notes ? 1 : 0)})</h3><form onSubmit={e => { e.preventDefault(); void addNote(); }}><input aria-label={t("הוסף הערה", "Add note")} placeholder={t("הוסף הערה...", "Add a note...")} value={note} maxLength={4000} onChange={e => setNote(e.target.value)}/><Button type="submit" loading={busy} disabled={!note.trim()}>{t("הוסף", "Add")}</Button></form>{lead.notes && <article><p>{lead.notes}</p><small>{t("הערות הליד", "Lead notes")}</small></article>}{contact.notes && <article><p>{contact.notes}</p><small>{t("הערות איש הקשר", "Contact notes")}</small></article>}{contact.noteItems.map(n => <article key={n.id}><p>{n.body}</p><small>{n.author.fullName} · {formatDateTime(n.createdAt)}</small></article>)}</section>
        </> : tab === "chat" ? <ContactChat contactId={contact.id}/> : <div className="lead-call-history"><p className="text-xs text-muted mb-4">{t("עד 50 השיחות האחרונות הזמינות לך", "Up to the last 50 calls available to you")}</p>{calls.length ? calls.map(call => <article key={call.id}><header><strong>{tab === "missed" && <PhoneMissed size={16}/>} {call.user.fullName}</strong><span>{formatDateTime(call.createdAt)}</span></header><p>{call.direction === "inbound" ? t("שיחה נכנסת", "Inbound call") : t("שיחה יוצאת", "Outbound call")} · {CALL_STATUS_LABEL[call.status] ?? call.status} · {formatDuration(call.talkSeconds ?? 0)}</p>{call.outcomeNote && <p className="lead-call-note">{call.outcomeNote}</p>}{call.coachSession?.documentation ? <CallDocView doc={call.coachSession.documentation} /> : call.answeredAt && call.endedAt ? <DocStatus callId={call.id} status={call.coachSession?.documentationStatus ?? null} error={call.coachSession?.documentationError ?? null} /> : null}{call.recordingStatus === "saved" && <audio controls preload="none" src={`/api/recordings/${call.id}`} onError={() => toast.error(t("ההקלטה אינה זמינה כרגע או שאין הרשאה לנגן אותה", "The recording is unavailable right now or you don't have permission to play it"))}/>}{tab === "calls" && !call.outcomeNote && <p className="text-muted text-xs">{t("לא נוסף סיכום לשיחה זו", "No summary was added for this call")}</p>}</article>) : <div className="lead-drawer-empty">{tab === "recordings" ? t("אין הקלטות זמינות לליד זה", "No recordings available for this lead") : tab === "missed" ? t("אין שיחות שלא נענו", "No missed calls") : t("עדיין אין שיחות עם הליד", "No calls with this lead yet")}</div>}</div>}
      </>}</div>
    </div>
    {lead && contact && modal === "followup" && <FollowUpModal leadId={lead.id} name={contact.fullName} tz={lead.timezone} current={lead.followUp} onClose={() => setModal(null)} onSaved={() => { void load(); onUpdated(); }} />}
    {lead && contact && modal === "attempts" && <AttemptsModal leadId={lead.id} name={contact.fullName} tz={lead.timezone} onClose={() => setModal(null)} />}
    {lead && contact && modal === "move" && <MoveToCampaignModal leadId={lead.id} name={contact.fullName} onClose={() => setModal(null)} onDone={() => { void load(); onUpdated(); }} />}
    {lead && contact && modal === "deal" && <DealCloseModal contactId={contact.id} leadId={lead.id} name={contact.fullName} onClose={() => setModal(null)} onDone={() => { void load(); onUpdated(); }} />}
    {lead && modal === "transfer" && <TransferModal leadIds={[lead.id]} currentOwnerId={lead.ownerUserId} users={users} onClose={() => setModal(null)} onDone={() => { onUpdated(); onClose(); }} />}
  </dialog>;
}

/** An answered call without documentation yet: in progress, or failed with the reason and "נסה שוב" (never blocks). */
function DocStatus({ callId, status, error }: { callId: string; status: string | null; error: string | null }) {
  const t = useT();
  const [state, setState] = useState<{ status: string | null; error: string | null; doc?: boolean }>({ status, error });
  const [busy, setBusy] = useState(false);
  if (state.doc) return <p className="text-xs text-good" data-testid="doc-ready">{t("התיעוד נוצר – רעננו לצפייה.", "Documentation created – refresh to view.")}</p>;
  if (state.status !== "failed") return <p className="text-xs text-muted" data-testid="doc-pending">{t("תיעוד AI בהכנה…", "AI documentation in progress…")}</p>;
  return (
    <div role="status" className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-xs" data-testid="doc-failed">
      <span>{t("תיעוד ה-AI נכשל", "AI documentation failed")}{state.error ? `: ${state.error}` : ""}</span>
      <button type="button" className="underline" disabled={busy} data-testid="doc-retry" onClick={async () => {
        setBusy(true);
        try { const r = await api.post<{ status: string | null; error: string | null; documentedAt: string | null }>(`/api/calls/${callId}/documentation`, {}); setState({ status: r.status, error: r.error, doc: Boolean(r.documentedAt) }); }
        catch (e) { setState({ status: "failed", error: (e as Error).message }); }
        finally { setBusy(false); }
      }}>{busy ? t("מנסה שוב…", "Retrying…") : t("נסה שוב", "Try again")}</button>
    </div>
  );
}

/** "תיעוד AI" of a call: summary, the timeline through the whole call, and what came out of it. */
function CallDocView({ doc }: { doc: CallDoc }) {
  const t = useT();
  const list = (title: string, items: string[]) => items.length ? <div><b>{title}</b><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null;
  return (
    <details className="call-doc" open data-testid="call-doc">
      <summary>{doc.source === "ai" ? t("🤖 תיעוד AI של השיחה", "🤖 AI call documentation") : t("📝 תמלול השיחה לפי זמנים", "📝 Timed call transcript")}{doc.sentiment && <span className={`call-doc-mood ${doc.sentiment}`}>{doc.sentiment === "positive" ? t("חיובית", "Positive") : doc.sentiment === "negative" ? t("שלילית", "Negative") : t("ניטרלית", "Neutral")}</span>}</summary>
      <p className="call-doc-summary">{doc.summary}</p>
      {doc.timeline.length > 0 && <ol className="call-doc-timeline">{doc.timeline.map((step, i) => <li key={i}><span dir="ltr">{step.from}–{step.to}</span><div><b>{step.title}</b><p>{step.details}</p></div></li>)}</ol>}
      <div className="call-doc-lists">{list(t("צרכי הלקוח", "Customer needs"), doc.customerNeeds)}{list(t("התנגדויות", "Objections"), doc.objections)}{list(t("סוכם", "Agreed"), doc.agreements)}{list(t("הצעדים הבאים", "Next steps"), doc.nextSteps)}</div>
    </details>
  );
}
