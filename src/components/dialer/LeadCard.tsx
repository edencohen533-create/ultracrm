"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Phone, Textarea, cx } from "@/components/ui";
import { TELEPHONY_RESULT_LABEL, formatDateTime, formatDuration, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";
import type { ContactLite, LeadDto } from "@/lib/client/types";

interface ContactFull extends ContactLite {
  owner: { id: string; fullName: string } | null;
  calls: Array<{ id: string; createdAt: string; answeredAt: string | null; talkSeconds: number | null; telephonyResult: string | null; outcome: string | null; outcomeNote: string | null; callbackAt: string | null; recordingStatus: string; user: { fullName: string } }>;
  tasks: Array<{ id: string; dueAt: string; note: string | null; user: { fullName: string } }>;
  leads: Array<{ id: string; status: string; list: { id: string; name: string } }>;
  isDnc: boolean;
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
  const [contact, setContact] = useState<ContactFull | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", company: "", city: "" });
  const [scriptOpen, setScriptOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(5);
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
    const t = setTimeout(() => api.put("/api/dialer/draft", { contactId, body: noteValue }).catch(() => toast.error("שמירת הטיוטה בשרת נכשלה; ההערה נשמרה בדפדפן הזה", { id: "draft-save-failed" })), 1200);
    return () => clearTimeout(t);
  }, [contactId, noteValue]);

  async function saveEdit() {
    if (!contact) return;
    try {
      await api.patch(`/api/contacts/${contact.id}`, form);
      toast.success("הפרטים נשמרו");
      setEditing(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!contactId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center text-muted p-8">
        <p className="text-base font-medium text-text">אין ליד פעיל</p>
        <p className="text-xs mt-1 max-w-xs">התחל סשן כדי למשוך ליד מהתור, או חייג ידנית מהלוח בצד.</p>
      </div>
    );
  }
  if (!contact) return <div className="p-6 text-muted text-sm">טוען כרטיס…</div>;

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
            <div className="flex items-center gap-3 mt-1 text-sm">
              <Phone value={formatPhone(contact.phoneE164)} className="text-[#aab3ff] text-base font-medium" />
              {contact.isDnc && <Badge tone="bad">לא ליצור קשר</Badge>}
              {lead && (
                <span className="text-xs text-muted">
                  ניסיון <span className="tabular text-text">{lead.attempts + (lead.status === "in_call" ? 0 : 1)}</span>
                  {lead.lastOutcome && <> · קודם: {outcomeLabel(lead.lastOutcome)}</>}
                </span>
              )}
            </div>
            {lead?.claimReason && (
              <p className="mt-1 text-xs text-[#aab3ff]" title={lead.claimScore != null ? `ציון תעדוף ${lead.claimScore}` : undefined}>
                למה עכשיו: {lead.claimReason}
              </p>
            )}
            {(contact.tags?.length ?? 0) > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">{contact.tags!.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {canEdit && !editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                עריכה
              </Button>
            )}
            {editing && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>ביטול</Button>
                <Button size="sm" onClick={saveEdit}>שמור</Button>
              </>
            )}
            <Link href={`/contacts/${contact.id}`} className="text-xs text-muted hover:text-text">כרטיס מלא ↗</Link>
          </div>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 mt-3 text-xs">
          <Field label="חברה">{editing ? <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="h-8" /> : contact.company || "—"}</Field>
          <Field label="עיר">{editing ? <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="h-8" /> : contact.city || "—"}</Field>
          <Field label="אימייל">{editing ? <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="h-8" ltr /> : <span className="ltr">{contact.email || "—"}</span>}</Field>
          <Field label="מקור">{contact.source || "—"}</Field>
          <Field label="נציג אחראי">{contact.owner?.fullName ?? "—"}</Field>
          <Field label="נוצר">{formatDateTime(contact.createdAt)}</Field>
          {lead && <Field label="רשימה">{lead.list.name}</Field>}
          {contact.leads.length > 1 && <Field label="רשימות נוספות">{contact.leads.filter((l) => l.id !== lead?.id).map((l) => l.list.name).join(", ")}</Field>}
        </dl>
        {contact.notes && (
          <p className="mt-3 text-xs text-muted bg-white/5 rounded-md p-2 whitespace-pre-wrap">
            <span className="text-text font-medium">הערות קבועות: </span>
            {contact.notes}
          </p>
        )}
        {contact.tasks.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {contact.tasks.map((t) => (
              <Badge key={t.id} tone="warn">חזרה מתוכננת {formatDateTime(t.dueAt)} · {t.user.fullName}</Badge>
            ))}
          </div>
        )}
      </div>

      <div className="p-4 border-b border-line">
        <Textarea
          label="הערות לשיחה (נשמר אוטומטית)"
          rows={4}
          value={noteValue}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="מה נאמר בשיחה, סיכומים, פרטים חשובים…"
          className="text-sm"
        />
      </div>

      {script && (
        <div className="border-b border-line">
          <button onClick={() => setScriptOpen((o) => !o)} className="w-full flex items-center justify-between px-4 h-10 text-sm hover:bg-white/5">
            <span className="font-medium">תסריט שיחה · {script.title}</span>
            <span className="text-muted text-xs">{scriptOpen ? "הסתר ▴" : "הצג ▾"}</span>
          </button>
          {scriptOpen && <div className="px-4 pb-4 text-sm whitespace-pre-wrap leading-relaxed text-text/90">{script.body}</div>}
        </div>
      )}

      <div className="p-4">
        <h3 className="text-sm font-semibold mb-2">היסטוריית התקשרות</h3>
        {contact.calls.length === 0 ? (
          <p className="text-xs text-muted">אין שיחות קודמות</p>
        ) : (
          <ul className="space-y-1.5">
            {contact.calls.slice(0, historyLimit).map((c) => (
              <li key={c.id} className="text-xs bg-white/4 rounded-md px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-muted tabular">{formatDateTime(c.createdAt)}</span>
                <span>{c.user.fullName}</span>
                <Badge tone={c.answeredAt ? "good" : "neutral"}>{c.telephonyResult ? TELEPHONY_RESULT_LABEL[c.telephonyResult] : "—"}</Badge>
                {c.answeredAt && <span className="tabular text-muted">{formatDuration(c.talkSeconds)}</span>}
                <span className={cx("font-medium", c.outcome === "sale" && "text-good", c.outcome === "dnc" && "text-bad")}>{outcomeLabel(c.outcome)}</span>
                {c.recordingStatus === "saved" && <a href={`/api/recordings/${c.id}`} target="_blank" className="text-[#aab3ff] hover:underline">הקלטה</a>}
                {c.outcomeNote && <span className="w-full text-muted whitespace-pre-wrap">{c.outcomeNote}</span>}
              </li>
            ))}
          </ul>
        )}
        {contact.calls.length > historyLimit && (
          <button onClick={() => setHistoryLimit((n) => n + 10)} className="mt-2 text-xs text-[#aab3ff] hover:underline">הצג עוד</button>
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
