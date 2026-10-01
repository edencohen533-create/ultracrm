"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/components/i18n/LangProvider";

/**
 * Tabs of the "חייגן" area – each tab is its own URL (refresh, shared links, back / forward work). Rendered by the
 * area's layout, so switching tabs never remounts the app shell: the active call (DialerProvider + CallBar in the app
 * layout) keeps running and no second telephony connection or live listener is opened.
 */
export function DialerHubNav({ showLive }: { showLive: boolean }) {
  const t = useT();
  const pathname = usePathname();
  const items = [
    { href: "/calling/start", label: t("הפעלת חייגן", "Start dialer"), testid: "hub-tab-start" },
    { href: "/calling/lists", label: t("רשימות חיוג", "Dial lists"), testid: "hub-tab-lists" },
    { href: "/calling/ready", label: t("פתיחת משמרת", "Start of shift"), testid: "hub-tab-ready" },
    { href: "/calling/history", label: t("היסטוריית שיחות", "Call history"), testid: "hub-tab-history" },
    ...(showLive ? [{ href: "/calling/live", label: t("שיחות פעילות", "Active calls"), testid: "hub-tab-live" }] : []),
  ];
  return (
    <nav className="reports-nav dialer-hub-nav" aria-label={t("חייגן", "Dialer")} data-testid="dialer-hub-nav">
      {items.map((i) => {
        const active = pathname === i.href || pathname.startsWith(i.href + "/");
        return <Link key={i.href} href={i.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined} data-testid={i.testid}>{i.label}</Link>;
      })}
    </nav>
  );
}
