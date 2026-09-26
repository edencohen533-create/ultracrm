"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, DollarSign, History, Info, Moon, PhoneCall, UserPlus } from "lucide-react";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { DialerWorkspace } from "@/components/dialer/DialerWorkspace";
import { StartSessionForm } from "@/components/dialer/SessionControls";

interface Perf { followUps: { done: number; total: number }; dealsWon: number; newCustomerCalls: number; calls: { answered: number; total: number }; talkSeconds: number }
const hms = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");

/**
 * The dialer as its own full screen (/dialer): "הביצועים שלי" on the side and, in the middle, either the launcher
 * card ("הפעלת חייגן אוטומטי") or the live call workspace once a session/call is running.
 */
export function DialerScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { state, sessionSummary } = useDialer();
  const live = Boolean((state?.session && state.session.status !== "ended") || state?.activeCall || state?.wrapUpCall || sessionSummary);
  const [perf, setPerf] = useState<Perf | null>(null);
  const loadPerf = useCallback(() => { api.get<Perf>("/api/dialer/my-performance").then(setPerf).catch(() => undefined); }, []);
  useEffect(() => { loadPerf(); }, [loadPerf, state?.wrapUpCall?.id, state?.activeCall?.id, live]);
  useEffect(() => { const t = setInterval(loadPerf, 60_000); return () => clearInterval(t); }, [loadPerf]);
  const cards = perf ? [
    { label: "שיחות מעקב להיום", value: <><b>{perf.followUps.done}</b> / {perf.followUps.total}</>, Icon: History, tone: "orange", hint: "חזרות שבוצעו היום מתוך החזרות שמתוכננות להיום" },
    { label: "עסקות סגורות", value: <b>{perf.dealsWon}</b>, Icon: DollarSign, tone: "green", hint: "עסקאות שנסגרו בהצלחה היום על שמך" },
    { label: "שיחות עם לקוחות חדשים", value: <b>{perf.newCustomerCalls}</b>, Icon: UserPlus, tone: "yellow", hint: "אנשי קשר שחויגו היום בפעם הראשונה" },
    { label: "סה״כ שיחות שנוהלו", value: <><b>{perf.calls.answered}</b> / {perf.calls.total}</>, Icon: PhoneCall, tone: "blue", hint: "שיחות שנענו מתוך כל השיחות שלך היום" },
    { label: "סה״כ זמן בשיחה", value: <b>{hms(perf.talkSeconds)}</b>, Icon: Moon, tone: "indigo", hint: "זמן דיבור מצטבר היום" },
  ] : [];
  return (
    <div className="dialer-screen" data-testid="dialer-screen">
      <main className="dialer-main">
        <div className="dialer-topbar"><Link href="/leads" className="dialer-back" data-testid="dialer-back"><ArrowRight size={16} /> חזרה ללידים</Link>{live && <span className="dialer-live-badge">החייגן פעיל</span>}</div>
        {live ? (
          <section className="dialer-live" data-testid="dialer-embedded"><DialerWorkspace embedded minimal /></section>
        ) : (
          <section className="dialer-launcher" data-testid="dialer-launcher">
            <h1>הפעלת חייגן אוטומטי</h1>
            <StartSessionForm compact initialListId={params.get("listId") ?? undefined} onStarted={() => { router.replace("/dialer"); }} />
          </section>
        )}
      </main>
      <aside className="dialer-perf" aria-label="הביצועים שלי">
        <h2>הביצועים שלי</h2>
        {perf ? cards.map(({ label, value, Icon, tone, hint }) => (
          <article className="perf-card" key={label} title={hint}>
            <span className="perf-info" aria-hidden><Info size={14} /></span>
            <div className="perf-text"><div className="perf-value" dir="ltr">{value}</div><div className="perf-label">{label}</div></div>
            <span className={`perf-icon ${tone}`}><Icon size={22} /></span>
          </article>
        )) : <p className="text-xs text-muted p-3">טוען…</p>}
      </aside>
    </div>
  );
}
