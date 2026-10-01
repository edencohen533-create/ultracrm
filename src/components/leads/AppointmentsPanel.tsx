"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";

type Appt = { id: string; title: string; scheduledAt: string; status: "scheduled" | "attended" | "no_show" | "cancelled"; rescheduledCount: number };
const ST: Record<Appt["status"], [string, string, "info" | "good" | "warn" | "neutral"]> = { scheduled: ["נקבעה", "Scheduled", "info"], attended: ["התקיימה", "Attended", "good"], no_show: ["לא הגיע/ה", "No-show", "warn"], cancelled: ["בוטלה", "Cancelled", "neutral"] };

/** Meetings with the contact: schedule, reschedule (same meeting), mark attended / no-show / cancelled. */
export function AppointmentsPanel({ contactId, leadId }: { contactId: string; leadId?: string | null }) {
  const t = useT();
  const [items, setItems] = useState<Appt[] | null>(null);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const load = useCallback(async () => { try { setItems((await api.get<{ items: Appt[] }>(`/api/appointments?contactId=${contactId}`)).items); } catch { setItems([]); } }, [contactId]);
  useEffect(() => { void load(); }, [load]);
  async function create() {
    if (!when) return; setBusy(true);
    try { await api.post("/api/appointments", { contactId, leadId: leadId ?? null, scheduledAt: new Date(when).toISOString() }); setWhen(""); toast.success(t("הפגישה נקבעה", "Meeting scheduled")); void load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function patch(id: string, body: Record<string, unknown>, msg: string) { try { await api.patch(`/api/appointments/${id}`, body); toast.success(msg); setMoving(null); void load(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <section className="lead-detail-notes" data-testid="appointments">
      <h3>{t("פגישות", "Meetings")}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs">{t("מועד", "When")}<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-9 rounded-md border border-line px-2" data-testid="appt-when" /></label>
        <Button size="sm" onClick={() => void create()} disabled={!when} loading={busy} data-testid="appt-create">{t("קביעת פגישה", "Schedule")}</Button>
      </div>
      {items?.length ? <ul className="mt-2 space-y-2">{items.map((a) => (
        <li key={a.id} className="rounded-lg border border-line p-2 text-sm" data-testid="appt-row">
          <div className="flex flex-wrap items-center gap-2"><b>{formatDateTime(a.scheduledAt)}</b><Badge tone={ST[a.status][2]}>{t(ST[a.status][0], ST[a.status][1])}</Badge>{a.rescheduledCount > 0 && <span className="text-xs text-muted">{t(`נדחתה ${a.rescheduledCount} פעמים`, `Rescheduled ${a.rescheduledCount}×`)}</span>}</div>
          {a.status === "scheduled" && <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" variant="good" onClick={() => void patch(a.id, { status: "attended" }, t("סומן כהתקיימה", "Marked attended"))} data-testid="appt-attended">{t("התקיימה", "Attended")}</Button>
            <Button size="sm" variant="secondary" onClick={() => void patch(a.id, { status: "no_show" }, t("סומן", "Marked"))}>{t("לא הגיע/ה", "No-show")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMoving(a.id)}>{t("שינוי מועד", "Reschedule")}</Button>
            <Button size="sm" variant="ghost" onClick={() => void patch(a.id, { status: "cancelled" }, t("בוטלה", "Cancelled"))}>{t("ביטול", "Cancel")}</Button>
          </div>}
          {moving === a.id && <RescheduleRow onSave={(v) => void patch(a.id, { scheduledAt: new Date(v).toISOString() }, t("המועד עודכן – זו אותה פגישה", "Time updated – same meeting"))} />}
        </li>))}</ul> : items && <p className="text-xs text-muted mt-2">{t("אין פגישות", "No meetings")}</p>}
    </section>
  );
}
function RescheduleRow({ onSave }: { onSave: (v: string) => void }) {
  const t = useT(); const [v, setV] = useState("");
  return <div className="mt-2 flex items-end gap-2"><input type="datetime-local" value={v} onChange={(e) => setV(e.target.value)} className="h-9 rounded-md border border-line px-2" /><Button size="sm" disabled={!v} onClick={() => onSave(v)}>{t("שמירה", "Save")}</Button></div>;
}
