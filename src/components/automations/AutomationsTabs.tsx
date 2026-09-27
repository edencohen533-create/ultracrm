"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/automations", label: "חוקים ומסעות לקוח", match: (p: string) => p === "/automations" || p.startsWith("/automations/journeys") || p.startsWith("/automations/history") },
  { href: "/automations/carts", label: "עגלות נטושות", match: (p: string) => p.startsWith("/automations/carts") },
  { href: "/automations/integrations", label: "Webhooks ו-API", match: (p: string) => p.startsWith("/automations/integrations") },
];

/** Sub-navigation of "אוטומציות": rules & journeys, abandoned carts (store connections), webhooks & public API. */
export function AutomationsTabs() {
  const p = usePathname() ?? "";
  return (
    <nav className="automation-tabs" aria-label="אוטומציות" data-testid="automation-tabs">
      {TABS.map((t) => <Link key={t.href} href={t.href} aria-current={t.match(p) ? "page" : undefined} data-testid={`automation-tab-${t.href.split("/")[2] ?? "rules"}`}>{t.label}</Link>)}
    </nav>
  );
}
