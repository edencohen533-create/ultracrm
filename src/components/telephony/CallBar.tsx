"use client";

/** Persistent call strip shown on every page while a call is alive or waiting for an outcome. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useDialer } from "./DialerProvider";
import { Badge, Button, Phone, cx } from "@/components/ui";
import { CALL_STATUS_LABEL, formatDuration, formatPhone } from "@/lib/client/format";

export function useTicker(active: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, [active]);
}

export function callElapsed(call: { answeredAt: string | null; createdAt: string; endedAt: string | null }) {
  const start = call.answeredAt ? new Date(call.answeredAt).getTime() : new Date(call.createdAt).getTime();
  const end = call.endedAt ? new Date(call.endedAt).getTime() : Date.now();
  return Math.max(0, Math.round((end - start) / 1000));
}

export function CallBar() {
  const { state, hangup, phone, busy, acceptInbound, rejectInbound } = useDialer();
  const pathname = usePathname();
  const call = state?.activeCall;
  const wrap = state?.wrapUpCall;
  useTicker(Boolean(call));
  // The dialer workspace (with its own call panel and outcome form) is rendered inside /leads while a call/session is live.
  if (pathname === "/leads" || pathname === "/dialer" || pathname.startsWith("/lists/")) return null;
  if (!call && !wrap) return null;

  if (call) {
    const answered = call.status === "answered";
    return (
      <div className={cx("sticky top-0 z-40 flex flex-wrap items-center gap-2 px-3 py-2 min-h-12 border-b border-line", answered ? "bg-[#ecf9ef]" : "bg-panel-2")}>
        <span className={cx("w-2.5 h-2.5 rounded-full", answered ? "bg-good pulse-good" : "bg-warn animate-pulse")} />
        <span className="font-semibold truncate">{call.contact?.fullName ?? "שיחה"}</span>
        <Phone value={formatPhone(call.toE164)} className="text-muted whitespace-nowrap" />
        <Badge tone={answered ? "good" : "warn"}>{CALL_STATUS_LABEL[call.status]}</Badge>
        {answered && <span className="tabular font-mono text-sm">{formatDuration(callElapsed(call))}</span>}
        {state?.telephony.simulation && <Badge tone="warn">הדמיה</Badge>}
        {call.direction === "inbound" && !call.answeredAt && <Badge tone="info">שיחה נכנסת</Badge>}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {call.direction === "inbound" && !call.answeredAt && (
            <>
              <Button size="sm" variant="good" onClick={acceptInbound} loading={busy === "accept"}>קבל</Button>
              <Button size="sm" variant="danger" onClick={rejectInbound} loading={busy === "reject"}>דחה</Button>
            </>
          )}
          <Button size="sm" variant={phone.muted ? "warn" : "secondary"} onClick={phone.toggleMute} disabled={!answered}>
            {phone.muted ? "בטל השתקה" : "השתק"}
          </Button>
          <Button size="sm" variant="danger" onClick={hangup} loading={busy === "hangup"}>
            נתק
          </Button>
          <Link href="/leads" className="text-xs text-accent underline hover:underline">
            למסך החיוג
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center gap-2 px-3 py-2 min-h-12 border-b border-line bg-[#fff5df]">
      <span className="w-2.5 h-2.5 rounded-full bg-warn" />
      <span className="font-medium">שיחה עם {wrap!.contact?.fullName ?? formatPhone(wrap!.toE164)} ממתינה לתיעוד</span>
      <Link href="/leads" className="ms-auto">
        <Button size="sm" variant="warn">
          תעד עכשיו
        </Button>
      </Link>
    </div>
  );
}
