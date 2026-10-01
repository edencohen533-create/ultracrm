"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, DollarSign, History, Info, Moon, Phone, PhoneCall } from "lucide-react";
import { api } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { DialerWorkspace } from "@/components/dialer/DialerWorkspace";
import { StartSessionForm } from "@/components/dialer/SessionControls";
import { useT } from "@/components/i18n/LangProvider";

interface Perf { followUps: { done: number; total: number }; dealsWon: number; calls: { answered: number; total: number; outbound: number; inbound: number }; talkSeconds: number }
const hms = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");

/**
 * The dialer as its own full screen (/dialer): "הביצועים שלי" on the side and, in the middle, either the launcher
 * card ("הפעלת חייגן אוטומטי") or the live call workspace once a session/call is running.
 */
export function DialerScreen({ inHub = false }: { inHub?: boolean } = {}) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const { state, sessionSummary } = useDialer();
  const live = Boolean((state?.session && state.session.status !== "ended") || state?.activeCall || state?.wrapUpCall || sessionSummary);
  const [perf, setPerf] = useState<Perf | null>(null);
  const loadPerf = useCallback(() => { api.get<Perf>("/api/dialer/my-performance").then(setPerf).catch(() => undefined); }, []);
  useEffect(() => { loadPerf(); }, [loadPerf, state?.wrapUpCall?.id, state?.activeCall?.id, live]);
  useEffect(() => { const iv = setInterval(loadPerf, 60_000); return () => clearInterval(iv); }, [loadPerf]);
  const cards = perf ? [
    { label: t("שיחות מעקב להיום", "Today's follow-up calls"), value: <><b>{perf.followUps.done}</b> / {perf.followUps.total}</>, Icon: History, tone: "orange", hint: t("חזרות שבוצעו היום מתוך החזרות שמתוכננות להיום", "Callbacks done today out of those scheduled for today") },
    { label: t("עסקות סגורות", "Closed deals"), value: <b>{perf.dealsWon}</b>, Icon: DollarSign, tone: "green", hint: t("עסקאות שנסגרו בהצלחה היום על שמך", "Deals successfully closed today under your name") },
    { label: t("שיחות", "Calls"), value: <><b>{perf.calls.total}</b> <small className="text-xs font-normal" dir={t.lang === "en" ? "ltr" : "rtl"}>{t(`(${perf.calls.outbound} יוצאות · ${perf.calls.inbound} נכנסות)`, `(${perf.calls.outbound} out · ${perf.calls.inbound} in)`)}</small></>, Icon: Phone, tone: "yellow", hint: t("כל השיחות שלך היום – ללקוחות חדשים וקיימים, יוצאות ונכנסות", "All your calls today – new and existing customers, outbound and inbound") },
    { label: t("סה״כ שיחות שנוהלו", "Total calls handled"), value: <><b>{perf.calls.answered}</b> / {perf.calls.total}</>, Icon: PhoneCall, tone: "blue", hint: t("שיחות שנענו מתוך כל השיחות שלך היום", "Answered calls out of all your calls today") },
    { label: t("סה״כ זמן בשיחה", "Total talk time"), value: <b>{hms(perf.talkSeconds)}</b>, Icon: Moon, tone: "indigo", hint: t("זמן דיבור מצטבר היום", "Cumulative talk time today") },
  ] : [];
  return (
    <div className={inHub ? "dialer-screen in-hub" : "dialer-screen"} data-testid="dialer-screen">
      <main className="dialer-main">
        {/* In the "חייגן" area the tabs are the navigation; the standalone /dialer screen (from CRM) keeps its way back */}
        {(!inHub || live) && <div className="dialer-topbar">{!inHub && <Link href="/leads" className="dialer-back" data-testid="dialer-back"><ArrowRight size={16} /> {t("חזרה ללידים", "Back to leads")}</Link>}{live && <span className="dialer-live-badge">{t("החייגן פעיל", "Dialer active")}</span>}</div>}
        {live ? (
          <section className="dialer-live" data-testid="dialer-embedded"><DialerWorkspace embedded minimal /></section>
        ) : (
          <section className="dialer-launcher" data-testid="dialer-launcher">
            <h1>{t("הפעלת חייגן אוטומטי", "Start auto-dialer")}</h1>
            <StartSessionForm compact initialListId={params.get("listId") ?? undefined} onStarted={() => { router.replace(pathname); }} />
          </section>
        )}
      </main>
      <aside className="dialer-perf" aria-label={t("הביצועים שלי", "My performance")}>
        <h2>{t("הביצועים שלי", "My performance")}</h2>
        {perf ? cards.map(({ label, value, Icon, tone, hint }) => (
          <article className="perf-card" key={label} title={hint}>
            <span className="perf-info" aria-hidden><Info size={14} /></span>
            <div className="perf-text"><div className="perf-value" dir="ltr">{value}</div><div className="perf-label">{label}</div></div>
            <span className={`perf-icon ${tone}`}><Icon size={22} /></span>
          </article>
        )) : <p className="text-xs text-muted p-3">{t("טוען…", "Loading…")}</p>}
      </aside>
    </div>
  );
}
