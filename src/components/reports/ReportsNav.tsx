"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMe } from "@/lib/client/use-me";

/** Report sections toolbar – shown (and kept at the top) on every report page. */
export function ReportsNav() {
  const pathname = usePathname();
  const me = useMe();
  const items = [
    { href: "/reports", label: "ביצועי נציגים", show: me?.modules.telephony !== false },
    { href: "/manager/calls", label: "שיחות", show: me?.modules.telephony !== false },
    { href: "/analytics", label: "אנליטיקה", show: me?.modules.messaging !== false },
  ].filter((i) => i.show);
  return (
    <nav className="reports-nav" aria-label="דוחות" data-testid="reports-nav">
      {items.map((i) => <Link key={i.href} href={i.href} className={pathname === i.href || pathname.startsWith(i.href + "/") ? "active" : ""} aria-current={pathname === i.href ? "page" : undefined}>{i.label}</Link>)}
    </nav>
  );
}
