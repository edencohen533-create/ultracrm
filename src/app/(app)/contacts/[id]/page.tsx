"use client";

import { use, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, Input, Panel, Phone, Spinner, Textarea, cx } from "@/components/ui";
import { LEAD_STATUS_LABEL, MODE_LABEL, TELEPHONY_RESULT_LABEL, formatDateTime, formatDuration, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";

interface Full {
  id: string; fullName: string; phoneE164: string; email: string | null; company: string | null; city: string | null; source: string | null; notes: string | null; createdAt: string; isDnc: boolean; dncReason: string | null;
  owner: { id: string; fullName: string } | null;
  calls: Array<{ id: string; createdAt: string; answeredAt: string | null; endedAt: string | null; talkSeconds: number | null; telephonyResult: string | null; outcome: string | null; outcomeNote: string | null; callbackAt: string | null; recordingStatus: string; mode: string; fromE164: string; user: { fullName: string } }>;
  tasks: Array<{ id: string; dueAt: string; note: string | null; user: { fullName: string } }>;
  leads: Array<{ id: string; status: string; attempts: number; list: { id: string; name: string } }>;
}

export default function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { dial, state } = useDialer();
  const [c, setC] = useState<Full | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", company: "", city: "", source: "", notes: "" });

  const load = useCallback(async () => {
    try {
      const r = await api.get<Full>(`/api/contacts/${id}`);
      setC(r);
      setForm({ fullName: r.fullName, phone: r.phoneE164, email: r.email ?? "", company: r.company ?? "", city: r.city ?? "", source: r.source ?? "", notes: r.notes ?? "" });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id]);
  useEffect(() => { load(); }, [load, state?.wrapUpCall?.id, state?.activeCall?.id]);

  async function save() {
    try {
      await api.patch(`/api/contacts/${id}`, form);
      toast.success("נשמר");
      setEdit(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function toggleDnc() {
    if (!c) return;
    try {
      if (c.isDnc) await api.delete("/api/dnc", { phone: c.phoneE164 });
      else await api.post("/api/dnc", { phone: c.phoneE164, reason: "manual from contact card" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!c) return <div className="flex justify-center p-10"><Spinner /></div>;
  const canDial = !state?.activeCall && !state?.wrapUpCall && !c.isDnc;

  return (
    <div className="p-5 space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{c.fullName}</h1>
        <Phone value={formatPhone(c.phoneE164)} className="text-[#aab3ff]" />
        {c.isDnc && <Badge tone="bad">לא ליצור קשר{c.dncReason ? ` · ${c.dncReason}` : ""}</Badge>}
        <div className="ms-auto flex gap-2">
          <Button variant="secondary" size="sm" onClick={toggleDnc}>{c.isDnc ? "הסר מחסימה" : "חסום (DNC)"}</Button>
          {edit ? <><Button variant="ghost" size="sm" onClick={() => setEdit(false)}>ביטול</Button><Button size="sm" onClick={save}>שמור</Button></> : <Button variant="secondary" size="sm" onClick={() => setEdit(true)}>עריכה</Button>}
          <Button variant="good" size="sm" disabled={!canDial} onClick={() => dial({ mode: "manual", contactId: c.id })}>חייג</Button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Panel title="פרטים" className="md:col-span-1">
          {edit ? (
            <div className="space-y-2">
              <Input label="שם" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              <Input label="טלפון" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} ltr />
              <Input label="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
              <Input label="חברה" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              <Input label="עיר" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              <Input label="מקור" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
              <Textarea label="הערות קבועות" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          ) : (
            <dl className="text-sm space-y-2">
              {[["אימייל", c.email], ["חברה", c.company], ["עיר", c.city], ["מקור", c.source], ["נציג אחראי", c.owner?.fullName], ["נוצר", formatDateTime(c.createdAt)]].map(([k, v]) => (
                <div key={k as string} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className={cx(k === "אימייל" && "ltr")}>{v || "—"}</dd></div>
              ))}
              {c.notes && <p className="text-xs text-muted whitespace-pre-wrap border-t border-line pt-2">{c.notes}</p>}
            </dl>
          )}
          {c.leads.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs text-muted mb-1">רשימות חיוג</p>
              {c.leads.map((l) => <div key={l.id} className="flex justify-between text-xs py-1"><span>{l.list.name}</span><span className="text-muted">{LEAD_STATUS_LABEL[l.status]} · {l.attempts} ניסיונות</span></div>)}
            </div>
          )}
          {c.tasks.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs text-muted mb-1">משימות חזרה פתוחות</p>
              {c.tasks.map((t) => <div key={t.id} className="text-xs py-1">{formatDateTime(t.dueAt)} · {t.user.fullName}{t.note ? ` · ${t.note}` : ""}</div>)}
            </div>
          )}
        </Panel>

        <Panel title={`היסטוריית שיחות (${c.calls.length})`} className="md:col-span-2" bodyClassName="p-0">
          {c.calls.length === 0 ? <p className="p-4 text-sm text-muted">אין שיחות</p> : (
            <table className="w-full text-xs">
              <thead className="text-muted bg-white/3"><tr><th className="text-start px-3 h-8 font-medium">מועד</th><th className="text-start px-3 font-medium">נציג</th><th className="text-start px-3 font-medium">מצב</th><th className="text-start px-3 font-medium">טלפוניה</th><th className="text-start px-3 font-medium">משך</th><th className="text-start px-3 font-medium">תוצאה</th><th className="text-start px-3 font-medium">הקלטה</th></tr></thead>
              <tbody className="divide-y divide-line">
                {c.calls.map((k) => (
                  <>
                    <tr key={k.id}>
                      <td className="px-3 h-9 tabular">{formatDateTime(k.createdAt)}</td>
                      <td className="px-3">{k.user.fullName}</td>
                      <td className="px-3 text-muted">{MODE_LABEL[k.mode]}</td>
                      <td className="px-3"><Badge tone={k.answeredAt ? "good" : "neutral"}>{k.telephonyResult ? TELEPHONY_RESULT_LABEL[k.telephonyResult] : "—"}</Badge></td>
                      <td className="px-3 tabular">{k.answeredAt ? formatDuration(k.talkSeconds) : "—"}</td>
                      <td className="px-3">{OUTCOMES.find((o) => o.key === k.outcome)?.label ?? "—"}{k.callbackAt && <span className="text-muted"> · {formatDateTime(k.callbackAt)}</span>}</td>
                      <td className="px-3">{k.recordingStatus === "saved" ? <audio controls preload="none" src={`/api/recordings/${k.id}`} className="h-7 w-44" /> : "—"}</td>
                    </tr>
                    {k.outcomeNote && <tr key={k.id + "n"}><td colSpan={7} className="px-3 pb-2 text-muted whitespace-pre-wrap">{k.outcomeNote}</td></tr>}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
