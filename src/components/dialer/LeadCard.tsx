"use client";

import { ContactBlockNotice, type BlockSummary } from "@/components/contacts/ContactBlockNotice";
import { CustomerBanner, type CustomerSummary } from "@/components/contacts/CustomerBanner";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Phone, Textarea, cx } from "@/components/ui";
import { TELEPHONY_RESULT_LABEL, formatDateTime, formatDuration, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";
import type { ContactLite, LeadDto } from "@/lib/client/types";
import { ContactTimeline } from "@/components/contacts/ContactTimeline";
import { ContactChat } from "@/components/contacts/ContactChat";
import { useMe } from "@/lib/client/use-me";
import { useDialer } from "@/components/telephony/DialerProvider";
import { AvailableNowTag } from "@/components/telephony/AvailableNowTag";
import { useT } from "@/components/i18n/LangProvider";

interface ContactFull extends ContactLite {
  owner: { id: string; fullName: string } | null;
  calls: Array<{ id: string; createdAt: string; answeredAt: string | null; talkSeconds: number | null; telephonyResult: string | null; outcome: string | null; outcomeNote: string | null; callbackAt: string | null; recordingStatus: string; user: { fullName: string } }>;
  tasks: Array<{ id: string; dueAt: string; note: string | null; user: { fullName: string } }>;
  /** CRM leads (pipeline) – not dial-list rows. */
  leads: Array<{ id: string; title: string | null; status: string }>;
  /** Dial-list rows (the queues this contact sits in). */
  queueLeads?: Array<{ id: string; status: string; list: { id: string; name: string } }>;
  isDnc: boolean;
  suppression?: BlockSummary;
  customer?: CustomerSummary | null;
}

const outcomeLabel = (k: string | null) => OUTCOMES.find((o) => o.key === k)?.label ?? k ?? "—";

export function LeadCard({
  contactId,
  lead,
  script,
  draft,
  noteValue,
  onNoteChange,
  canEdit,
  refreshKey,
}: {
  contactId: string | null;
  lead: LeadDto | null;
  script: { title: string; body: string } | null;
  draft: string | null;
  noteValue: string;
  onNoteChange: (v: string) => void;
  canEdit: boolean;
  refreshKey: number;
}) {
  const t = useT();
  const [contact, setContact] = useState<ContactFull | null>(null);
  const hotNow = useDialer().state?.hot?.find((h) => h.status === "active" && h.contactId === contactId) ?? null;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", company: "", city: "" });
  const [scriptOpen, setScriptOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(5);
  const [tab, setTab] = useState<"calls" | "timeline" | "chat">("calls");
  const me = useMe();
  const lastDraftContact = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!contactId) {
      setContact(null);
      return;
    }
    try {
      const c = await api.get<ContactFull>(`/api/contacts/${contactId}`);
      setContact(c);
      setForm({ fullName: c.fullName, email: c.email ?? "", company: c.company ?? "", city: c.city ?? "" });
    } catch {
      /* stale */
    }
  }, [contactId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Restore draft (server first, then localStorage) when the contact changes.
  useEffect(() => {
    if (!contactId || lastDraftContact.current === contactId) return;
    lastDraftContact.current = contactId;
    let local = "";
    try {
      local = localStorage.getItem(`dialer.note.${contactId}`) ?? "";
    } catch {
      /* ignore */
    }
    onNoteChange(draft || local || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  // Persist draft: localStorage immediately, server debounced.
  useEffect(() => {
    if (!contactId) return;
    try {
      localStorage.setItem(`dialer.note.${contactId}`, noteValue);
    } catch {
      /* ignore */
    }
    const tm = setTimeout(() => api.put("/api/dialer/draft", { contactId, body: noteValue }).catch(() => toast.error(t("שמירת הטיוטה בשרת נכשלה; ההערה נשמרה בדפדפן הזה", "Saving the draft to the server failed; the note was saved in this browser"), { id: "draft-save-failed" })), 1200);
    return () => clearTimeout(tm);
  }, [contactId, noteValue, t]);

  async function saveEdit() {
    if (!contact) return;
    try {
      await api.patch(`/api/contacts/${contact.id}`, form);
      toast.success(t("הפרטים נשמרו", "Details saved"));
      setEditing(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!contactId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center text-muted p-8">
        <p className="text-base font-medium text-text">{t("אין ליד פעיל", "No active lead")}</p>
        <p className="text-xs mt-1 max-w-xs">{t("התחל סשן כדי למשוך ליד מהתור, או חייג ידנית מהלוח בצד.", "Start a session to pull a lead from the queue, or dial manually from the side keypad.")}</p>
      </div>
    );
  }
  if (!contact) return <div className="p-6 text-muted text-sm">{t("טוען כרטיס…", "Loading card…")}</div>;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto">
      <div className="p-4 border-b border-line">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {editing ? (
              <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className="h-9 text-lg font-semibold" />
            ) : (
              <h2 className="text-xl font-semibold truncate">{contact.fullName}</h2>
            )}
            <CustomerBanner customer={contact.customer} className="mt-2" />
            {contact.suppression && <div className="mt-2"><ContactBlockNotice summary={contact.suppression} isDnc={contact.isDnc} /></div>}
            <div className="flex items-center gap-3 mt-1 text-sm">
              <Phone value={formatPhone(contact.phoneE164)} className="text-accent underline text-base font-medium" />
              {contact.isDnc && !contact.suppression && <Badge tone="bad">{t("לא ליצור קשר", "Do not contact")}</Badge>}
              {hotNow && <AvailableNowTag at={hotNow.requestedAt} text={hotNow.text} />}
              {lead && (
                <span className="text-xs text-muted">
                  {t("ניסיון", "Attempt")} <span className="tabular text-text">{lead.attempts + (lead.status === "in_call" ? 0 : 1)}</span>
                  {lead.lastOutcome && <> · {t("קודם:", "Previous:")} {outcomeLabel(lead.lastOutcome)}</>}
                </span>
              )}
            </div>
            {lead?.claimReason && (
              <p className="mt-1 text-xs text-accent underline" title={lead.claimScore != null ? t(`ציון תעדוף ${lead.claimScore}`, `Priority score ${lead.claimScore}`) : undefined}>
                {t("למה עכשיו:", "Why now:")} {lead.claimReason}
              </p>
            )}
            {(contact.tags?.length ?? 0) > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">{contact.tags!.map((tg) => { const name = typeof tg === "string" ? tg : (tg as { name: string }).name; return <Badge key={name} tone="neutral">{name}</Badge>; })}</div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {canEdit && !editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                {t("עריכה", "Edit")}
              </Button>
            )}
            {editing && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t("ביטול", "Cancel")}</Button>
                <Button size="sm" onClick={saveEdit}>{t("שמור", "Save")}</Button>
              </>
            )}
            <Link href={`/contacts/${contact.id}`} className="text-xs text-muted hover:text-text">{t("כרטיס מלא ↗", "Full card ↗")}</Link>
          </div>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 mt-3 text-xs">
          <Field label={t("חברה", "Company")}>{editing ? <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="h-8" /> : contact.company || "—"}</Field>
          <Field label={t("עיר", "City")}>{editing ? <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="h-8" /> : contact.city || "—"}</Field>
          <Field label={t("אימייל", "Email")}>{editing ? <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="h-8" ltr /> : <span className="ltr">{contact.email || "—"}</span>}</Field>
          <Field label={t("מקור", "Source")}>{contact.source || "—"}</Field>
          <Field label={t("נציג אחראי", "Owner")}>{contact.owner?.fullName ?? "—"}</Field>
          <Field label={t("נוצר", "Created")}>{formatDateTime(contact.createdAt)}</Field>
          {lead && <Field label={t("רשימה", "List")}>{lead.list?.name ?? "—"}</Field>}
          {(contact.queueLeads?.filter((l) => l.id !== lead?.id).length ?? 0) > 0 && <Field label={t("רשימות נוספות", "Other lists")}>{contact.queueLeads!.filter((l) => l.id !== lead?.id).map((l) => l.list?.name ?? "").filter(Boolean).join(", ")}</Field>}
        </dl>
        {contact.notes && (
          <p className="mt-3 text-xs text-muted bg-white/5 rounded-md p-2 whitespace-pre-wrap">
            <span className="text-text font-medium">{t("הערות קבועות: ", "Permanent notes: ")}</span>
            {contact.notes}
          </p>
        )}
        {contact.tasks.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {contact.tasks.map((tk) => (
              <Badge key={tk.id} tone="warn">{t("חזרה מתוכננת", "Scheduled callback")} {formatDateTime(tk.dueAt)} · {tk.user.fullName}</Badge>
            ))}
          </div>
        )}
      </div>

      <div className="p-4 border-b border-line">
        <Textarea
          label={t("הערות לשיחה (נשמר אוטומטית)", "Call notes (auto-saved)")}
          rows={4}
          value={noteValue}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder={t("מה נאמר בשיחה, סיכומים, פרטים חשובים…", "What was said, summaries, key details…")}
          className="text-sm"
        />
      </div>

      {script && (
        <div className="border-b border-line">
          <button onClick={() => setScriptOpen((o) => !o)} className="w-full flex items-center justify-between px-4 h-10 text-sm hover:bg-white/5">
            <span className="font-medium">{t("תסריט שיחה", "Call script")} · {script.title}</span>
            <span className="text-muted text-xs">{scriptOpen ? t("הסתר ▴", "Hide ▴") : t("הצג ▾", "Show ▾")}</span>
          </button>
          {scriptOpen && <div className="px-4 pb-4 text-sm whitespace-pre-wrap leading-relaxed text-text/90">{script.body}</div>}
        </div>
      )}

      <div className="flex items-center gap-1 px-4 pt-3" role="tablist" aria-label={t("מידע על הלקוח", "Customer information")}>
        {([["calls", t("היסטוריית התקשרות", "Contact history")], ["timeline", t("ציר פעילות", "Activity timeline")], ...(me?.modules.messaging ? [["chat", t("וואטסאפ", "WhatsApp")]] : [])] as Array<["calls" | "timeline" | "chat", string]>).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx("h-8 px-3 rounded-md text-xs", tab === k ? "bg-accent text-white" : "text-muted hover:text-text hover:bg-white/5")} data-testid={`leadcard-tab-${k}`}>{label}</button>
        ))}
      </div>
      {tab === "timeline" && <div className="p-2"><ContactTimeline contactId={contact.id} refreshKey={refreshKey} limit={40} /></div>}
      {tab === "chat" && <div className="p-2"><ContactChat contactId={contact.id} compact /></div>}
      <div className={cx("p-4", tab !== "calls" && "hidden")}>
        <h3 className="text-sm font-semibold mb-2">{t("היסטוריית התקשרות", "Contact history")}</h3>
        {contact.calls.length === 0 ? (
          <p className="text-xs text-muted">{t("אין שיחות קודמות", "No previous calls")}</p>
        ) : (
          <ul className="space-y-1.5">
            {contact.calls.slice(0, historyLimit).map((c) => (
              <li key={c.id} className="text-xs bg-white/4 rounded-md px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-muted tabular">{formatDateTime(c.createdAt)}</span>
                <span>{c.user.fullName}</span>
                <Badge tone={c.answeredAt ? "good" : "neutral"}>{c.telephonyResult ? TELEPHONY_RESULT_LABEL[c.telephonyResult] : "—"}</Badge>
                {c.answeredAt && <span className="tabular text-muted">{formatDuration(c.talkSeconds)}</span>}
                <span className={cx("font-medium", c.outcome === "sale" && "text-good", c.outcome === "dnc" && "text-bad")}>{outcomeLabel(c.outcome)}</span>
                {c.recordingStatus === "saved" && <a href={`/api/recordings/${c.id}`} target="_blank" className="text-accent underline hover:underline">{t("הקלטה", "Recording")}</a>}
                {c.outcomeNote && <span className="w-full text-muted whitespace-pre-wrap">{c.outcomeNote}</span>}
              </li>
            ))}
          </ul>
        )}
        {contact.calls.length > historyLimit && (
          <button onClick={() => setHistoryLimit((n) => n + 10)} className="mt-2 text-xs text-accent underline hover:underline">{t("הצג עוד", "Show more")}</button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}
