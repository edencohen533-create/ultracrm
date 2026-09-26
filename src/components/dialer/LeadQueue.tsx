"use client";

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/client/api";
import { Badge, EmptyState, Input, Phone, Spinner, cx } from "@/components/ui";
import { LEAD_STATUS_LABEL, formatPhone, relativeTime } from "@/lib/client/format";

interface Row {
  id: string;
  status: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  priority: number;
  contact: { id: string; fullName: string; phoneE164: string; source: string | null };
  lockedBy: { id: string; fullName: string } | null;
}

const toneFor: Record<string, "neutral" | "good" | "warn" | "bad" | "info" | "accent"> = {
  pending: "neutral",
  locked: "info",
  in_call: "good",
  callback: "warn",
  completed: "good",
  exhausted: "bad",
  removed: "neutral",
  dnc: "bad",
};

export function LeadQueue({ listId, currentLeadId, refreshKey }: { listId: string; currentLeadId?: string | null; refreshKey: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("queue");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ items: Row[]; total: number }>(`/api/lists/${listId}/leads${qs({ q, status, sort, page, limit: 40 })}`);
      setRows(r.items);
      setTotal(r.total);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [listId, q, status, sort, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, refreshKey, q]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2 space-y-2 border-b border-line">
        <Input placeholder="חיפוש שם / טלפון" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="h-8 text-xs" />
        <div className="flex gap-2">
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-8 flex-1 px-2 rounded-md bg-bg border border-line text-xs">
            <option value="">כל הסטטוסים</option>
            {Object.entries(LEAD_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="h-8 flex-1 px-2 rounded-md bg-bg border border-line text-xs">
            <option value="queue">סדר תור</option>
            <option value="name">שם</option>
            <option value="attempts">ניסיונות</option>
            <option value="lastAttempt">ניסיון אחרון</option>
            <option value="nextAttempt">ניסיון הבא</option>
          </select>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {err ? (
          <p className="p-3 text-xs text-bad">{err}</p>
        ) : loading && rows.length === 0 ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="אין לידים תואמים" />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className={cx("px-3 py-2 text-xs", r.id === currentLeadId && "bg-accent/10 border-s-2 border-accent")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm truncate">{r.contact.fullName}</span>
                  <Badge tone={toneFor[r.status] ?? "neutral"}>{LEAD_STATUS_LABEL[r.status] ?? r.status}</Badge>
                </div>
                <div className="flex items-center justify-between gap-2 text-muted mt-0.5">
                  <Phone value={formatPhone(r.contact.phoneE164)} />
                  <span>{r.contact.source ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-muted mt-0.5">
                  <span>ניסיונות: <span className="tabular text-text">{r.attempts}</span></span>
                  <span>{r.lastAttemptAt ? `אחרון ${relativeTime(r.lastAttemptAt)}` : "טרם חויג"}</span>
                </div>
                {r.lockedBy && r.status !== "in_call" && r.id !== currentLeadId && <p className="text-[11px] text-info mt-0.5">בטיפול: {r.lockedBy.fullName}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between px-3 h-9 border-t border-line text-xs text-muted">
        <span className="tabular">{total} לידים</span>
        <div className="flex gap-1">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 disabled:opacity-30">‹ הקודם</button>
          <button disabled={page * 40 >= total} onClick={() => setPage((p) => p + 1)} className="px-2 disabled:opacity-30">הבא ›</button>
        </div>
      </div>
    </div>
  );
}
