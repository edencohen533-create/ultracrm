"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { ModuleKey } from "@/lib/access/catalog";
import type { EffectiveModule } from "@/lib/access/engine";
import { useT } from "@/components/i18n/LangProvider";

/** Screen → what it needs (any of). Data is protected by the APIs; this only avoids showing an empty, failing screen. */
const SCREENS: Array<{ match: (p: string) => boolean; need: string[] }> = [
  { match: (p) => p === "/leads" || p.startsWith("/leads/") || p.startsWith("/deals") || p.startsWith("/tasks"), need: ["crm.view"] },
  { match: (p) => p.startsWith("/dialer") || p.startsWith("/lists") || p.startsWith("/calls"), need: ["telephony.use"] },
  { match: (p) => p.startsWith("/manager") || p.startsWith("/numbers"), need: ["telephony.team_settings"] },
  { match: (p) => p.startsWith("/campaigns"), need: ["whatsapp.campaign_draft", "whatsapp.campaign_send", "sms.view", "email.view"] },
  { match: (p) => p.startsWith("/audiences") || p === "/contacts" || p.startsWith("/contacts/"), need: ["crm.view", "sms.draft", "email.draft", "whatsapp.campaign_draft", "telephony.use", "whatsapp.view"] },
  { match: (p) => p.startsWith("/carts"), need: ["whatsapp.automations", "sms.send", "email.send"] },
];

export function AccessGate({ access, children }: { access: Record<ModuleKey, EffectiveModule>; children: ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  const screen = SCREENS.find((s) => s.match(pathname));
  if (!screen) return <>{children}</>;
  const ok = screen.need.some((n) => { const [m, a] = n.split(".") as [ModuleKey, string]; return access[m]?.state === "active" && access[m].actions.includes(a); });
  if (ok) return <>{children}</>;
  const states = screen.need.map((n) => access[n.split(".")[0] as ModuleKey]?.state);
  const reason = states.every((s) => s === "not_in_package") ? t("המודול אינו כלול בחבילה של העסק.", "This module isn't included in the business's plan.") : states.includes("suspended") ? t("הגישה של העסק מושעית כרגע.", "The business's access is currently suspended.") : t("המודול או הפעולה לא הוקצו לך – פנה למנהל העסק.", "This module or action hasn't been assigned to you – contact the business admin.");
  return <div className="p-10 max-w-lg mx-auto text-center space-y-3" data-testid="no-access"><h1 className="text-xl font-bold">{t("אין גישה למסך הזה", "No access to this screen")}</h1><p className="text-muted">{reason}</p><Link href="/" className="underline text-sm">{t("חזרה", "Back")}</Link></div>;
}
