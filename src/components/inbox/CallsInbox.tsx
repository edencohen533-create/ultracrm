"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, EmptyState, Phone, Select, Spinner, cx } from "@/components/ui";
import { TELEPHONY_RESULT_LABEL, formatDateTime, formatDuration, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";

interface Row { id: string; createdAt: string; answeredAt: string | null; talkSeconds: number | null; status: string; direction: string; telephonyResult: string | null; outcome: string | null; outcomeNote: string | null; toE164: string; recordingStatus: string; contact: { id: string; fullName: string } | null; user: { id: string; fullName: string } }

const outcomeLabel = (k: string | null) => OUTCOMES.find((o) => o.key === k)?.label ?? (k ?? "—");

/**
 * Phone calls that need the agent's attention (missed inbound, no-answer callbacks) plus recent calls.
 * Agents see their own calls (team scope for managers) through /api/calls; "חייג חזרה" starts a manual dial
 * in the lead workspace. Full history with filters stays in the managers' reports.
 */
export function CallsInbox() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { dial, state } = useDialer();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [view, setView] = useState<"missed" | "all">(params.get("missed") === "1" ? "missed" : "all");
  const [days, setDays] = useState("7");
  const load = useCallback(() => {
    const from = new Date(Date.now() - Number(days) * 86400_000).toISOString();
    api.get<{ items: Row[] }>(`/api/calls${qs({ from, limit: 100 })}`).then((r) => setRows(r.items)).catch((e) => toast.error(e.message));
  }, [days]);
  useEffect(() => { load(); }, [load]);
  const canDial = Boolean(state) && !state?.activeCall && !state?.wrapUpCall;
  const missed = (r: Row) => (r.direction === "inbound" && !r.answeredAt) || (r.direction === "outbound" && !r.answeredAt && r.outcome === null);
  const shown = (rows ?? []).filter((r) => (view === "missed" ? missed(r) : true));
  async function callBack(r: Row) {
    try {
      await dial(r.contact ? { mode: "manual", contactId: r.contact.id } : { mode: "manual", phone: r.toE164 });
      // The component lives inside the lead workspace (drawer); the embedded dialer opens there – no navigation needed.
      if (!pathname.startsWith("/leads") && !pathname.startsWith("/lists/")) router.push("/leads");
    } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <div className="p-4 space-y-3" data-testid="calls-inbox">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line overflow-hidden">
          {(["missed", "all"] as const).map((v) => <button key={v} onClick={() => setView(v)} className={cx("h-8 px-3 text-sm", view === v ? "bg-accent text-white" : "text-muted hover:text-text")}>{v === "missed" ? "דורשות מענה" : "כל השיחות"}</button>)}
        </div>
        <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-32"><option value="1">היום</option><option value="7">7 ימים</option><option value="30">30 ימים</option></Select>
        <Button size="sm" variant="ghost" onClick={load}>רענון</Button>
      </div>
      {!rows ? <div className="flex justify-center p-10"><Spinner /></div> : shown.length === 0 ? <EmptyState title={view === "missed" ? "אין שיחות שממתינות למענה" : "אין שיחות בטווח"} /> : (
        <ul className="divide-y divide-line bg-panel border border-line rounded-xl">
          {shown.map((r) => (
            <li key={r.id} className="px-3 py-2 flex flex-wrap items-center gap-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{r.contact ? <Link href={`/contacts/${r.contact.id}`} className="hover:underline">{r.contact.fullName}</Link> : <Phone value={formatPhone(r.toE164)} />}</p>
                <p className="text-xs text-muted tabular">{formatDateTime(r.createdAt)} · {r.direction === "inbound" ? "נכנסת" : "יוצאת"} · {r.user.fullName}{r.outcomeNote ? ` · ${r.outcomeNote}` : ""}</p>
              </div>
              <Badge tone={r.answeredAt ? "good" : missed(r) ? "warn" : "neutral"}>{r.telephonyResult ? TELEPHONY_RESULT_LABEL[r.telephonyResult] ?? r.telephonyResult : r.answeredAt ? "נענתה" : "לא נענתה"}</Badge>
              {r.answeredAt && <span className="text-xs tabular text-muted">{formatDuration(r.talkSeconds)}</span>}
              <span className="text-xs">{outcomeLabel(r.outcome)}</span>
              {r.recordingStatus === "saved" && <a href={`/api/recordings/${r.id}`} target="_blank" className="text-xs text-accent underline">הקלטה</a>}
              <Button size="sm" variant="good" disabled={!canDial} onClick={() => callBack(r)} data-testid="call-back">חייג חזרה</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
