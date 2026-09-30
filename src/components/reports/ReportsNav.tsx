"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMe } from "@/lib/client/use-me";
import { useT } from "@/components/i18n/LangProvider";

/** Report sections toolbar – shown (and kept at the top) on every report page. */
export function ReportsNav() {
  const t = useT();
  const pathname = usePathname();
  const me = useMe();
  const items = [
    { href: "/reports", label: t("ביצועי נציגים", "Agent performance"), show: me?.modules.telephony !== false },
    { href: "/analytics", label: t("אנליטיקה", "Analytics"), show: me?.modules.messaging !== false },
    { href: "/reports/marketing", label: t("שיווק ומכירות", "Marketing & sales"), show: Boolean(me?.access?.modules.crm?.actions.includes("marketing_view") && (me.user.role === "owner" || me.access.scope === "business")) },
  ].filter((i) => i.show);
  return (
    <nav className="reports-nav" aria-label={t("דוחות", "Reports")} data-testid="reports-nav">
      {items.map((i) => <Link key={i.href} href={i.href} className={pathname === i.href || (i.href !== "/reports" && pathname.startsWith(i.href + "/")) ? "active" : ""} aria-current={pathname === i.href ? "page" : undefined}>{i.label}</Link>)}
    </nav>
  );
}
