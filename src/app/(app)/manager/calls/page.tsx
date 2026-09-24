"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Phone, Select, Spinner } from "@/components/ui";
import { MODE_LABEL, TELEPHONY_RESULT_LABEL, formatDateTime, formatDuration, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";

interface Row { id: string; createdAt: string; answeredAt: string | null; talkSeconds: number | null; status: string; telephonyResult: string | null; outcome: string | null; outcomeNote: string | null; recordingStatus: string; mode: string; toE164: string; fromE164: string; hangupCause: string | null; user: { id: string; fullName: string }; contact: { id: string; fullName: string } | null; list: { name: string } | null }

export default function CallsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [f, setF] = useState({ q: "", userId: "", outcome: "", telephonyResult: "", from: "", to: "" });
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);

  const load = useCallback(async (append = false, after?: string | null) => {
    setLoading(true);
    try {
      const r = await api.get<{ items: Row[]; nextCursor: string | null }>(`/api/calls${qs({ ...f, from: f.from ? new Date(f.from + "T00:00:00").toISOString() : "", to: f.to ? new Date(f.to + "T23:59:59").toISOString() : "", cursor: after ?? "", limit: 50 })}`);
      setRows((prev) => (append ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  }, [f]);
  useEffect(() => { const t = setTimeout(() => load(false, null), 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((u) => setUsers(u.items)).catch(() => undefined); }, []);

  return (
    <div className="p-5 space-y-4">
      <h1 className="text-lg font-semibold">היסטוריית שיחות</h1>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Input placeholder="שם / טלפון" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">כל הנציגים</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>
        <Select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}><option value="">כל התוצאות</option>{OUTCOMES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select>
        <Select value={f.telephonyResult} onChange={(e) => setF({ ...f, telephonyResult: e.target.value })}><option value="">טלפוניה: הכל</option>{Object.entries(TELEPHONY_RESULT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} ltr />
        <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} ltr />
      </div>
      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        {rows.length === 0 && !loading ? <EmptyState title="אין שיחות בטווח" /> : (
          <table className="w-full text-xs">
            <thead className="text-muted bg-white/3"><tr><th className="text-start px-3 h-9 font-medium">מועד</th><th className="text-start px-3 font-medium">נציג</th><th className="text-start px-3 font-medium">לקוח</th><th className="text-start px-3 font-medium">מצב</th><th className="text-start px-3 font-medium">טלפוניה</th><th className="text-start px-3 font-medium">משך</th><th className="text-start px-3 font-medium">תוצאה</th><th className="text-start px-3 font-medium">רשימה</th><th className="text-start px-3 font-medium">הקלטה</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-white/3">
                  <td className="px-3 h-10 tabular">{formatDateTime(r.createdAt)}</td>
                  <td className="px-3">{r.user.fullName}</td>
                  <td className="px-3">{r.contact ? <Link href={`/contacts/${r.contact.id}`} className="hover:underline">{r.contact.fullName}</Link> : "—"} <Phone value={formatPhone(r.toE164)} className="text-muted" /></td>
                  <td className="px-3 text-muted">{MODE_LABEL[r.mode]}</td>
                  <td className="px-3"><Badge tone={r.answeredAt ? "good" : "neutral"}>{r.telephonyResult ? TELEPHONY_RESULT_LABEL[r.telephonyResult] : r.status === "failed" ? "נכשלה" : "—"}</Badge>{r.hangupCause && <span className="text-muted ms-1 ltr">{r.hangupCause}</span>}</td>
                  <td className="px-3 tabular">{r.answeredAt ? formatDuration(r.talkSeconds) : "—"}</td>
                  <td className="px-3">{OUTCOMES.find((o) => o.key === r.outcome)?.label ?? "—"}{r.outcomeNote && <p className="text-muted truncate max-w-56" title={r.outcomeNote}>{r.outcomeNote}</p>}</td>
                  <td className="px-3 text-muted">{r.list?.name ?? "—"}</td>
                  <td className="px-3">{r.recordingStatus === "saved" ? <audio controls preload="none" src={`/api/recordings/${r.id}`} className="h-7 w-40" /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-center justify-center p-2 border-t border-line">
          {loading ? <Spinner className="w-4 h-4" /> : cursor ? <Button size="sm" variant="secondary" onClick={() => load(true, cursor)}>טען עוד</Button> : <span className="text-xs text-muted">{rows.length} שיחות</span>}
        </div>
      </div>
    </div>
  );
}
