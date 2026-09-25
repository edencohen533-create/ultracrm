"use client";

import Link from "next/link";
import { LiveFloor } from "@/components/manager/LiveFloor";

/** Live floor for managers: who is on a call, queues, alerts, pause controls. Period reports moved to /reports. */
export default function ManagerPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="px-5 pt-5 pb-3 flex flex-wrap items-center gap-3 border-b border-line">
        <h1 className="text-lg font-semibold">מוקד בזמן אמת</h1>
        <p className="text-xs text-muted">מצב חי של המוקד ונתוני היום</p>
        <Link href="/reports?tab=telephony" className="ms-auto text-xs text-accent underline">דוחות לתקופה ←</Link>
      </header>
      <LiveFloor />
    </div>
  );
}
