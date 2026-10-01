"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/components/i18n/LangProvider";

const TABS = [
  { href: "/automations", label: "אוטומציות", en: "Automations", match: (p: string) => p === "/automations" || p.startsWith("/automations/history"), testid: "rules" },
  { href: "/automations/journeys", label: "מסעות לקוח", en: "Customer journeys", match: (p: string) => p.startsWith("/automations/journeys"), testid: "journeys" },
  { href: "/automations/carts", label: "עגלות נטושות", en: "Abandoned carts", match: (p: string) => p.startsWith("/automations/carts"), testid: "carts" },
  { href: "/automations/integrations", label: "Webhooks ו-API", en: "Webhooks & API", match: (p: string) => p.startsWith("/automations/integrations"), testid: "integrations" },
];

/** Sub-navigation of "אוטומציות": automation rules, customer journeys, abandoned carts (store connections), webhooks & public API. */
export function AutomationsTabs() {
  const p = usePathname() ?? "";
  const tr = useT();
  return (
    <nav className="automation-tabs" aria-label={tr("אוטומציות", "Automations")} data-testid="automation-tabs">
      {TABS.map((t) => <Link key={t.href} href={t.href} aria-current={t.match(p) ? "page" : undefined} data-testid={`automation-tab-${t.testid}`}>{tr(t.label, t.en)}</Link>)}
    </nav>
  );
}
