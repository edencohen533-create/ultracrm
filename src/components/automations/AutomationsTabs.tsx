"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/components/i18n/LangProvider";

const TABS = [
  { href: "/automations", label: "חוקים ומסעות לקוח", en: "Rules & journeys", match: (p: string) => p === "/automations" || p.startsWith("/automations/journeys") || p.startsWith("/automations/history") },
  { href: "/automations/carts", label: "עגלות נטושות", en: "Abandoned carts", match: (p: string) => p.startsWith("/automations/carts") },
  { href: "/automations/integrations", label: "Webhooks ו-API", en: "Webhooks & API", match: (p: string) => p.startsWith("/automations/integrations") },
];

/** Sub-navigation of "אוטומציות": rules & journeys, abandoned carts (store connections), webhooks & public API. */
export function AutomationsTabs() {
  const p = usePathname() ?? "";
  const tr = useT();
  return (
    <nav className="automation-tabs" aria-label={tr("אוטומציות", "Automations")} data-testid="automation-tabs">
      {TABS.map((t) => <Link key={t.href} href={t.href} aria-current={t.match(p) ? "page" : undefined} data-testid={`automation-tab-${t.href.split("/")[2] ?? "rules"}`}>{tr(t.label, t.en)}</Link>)}
    </nav>
  );
}
