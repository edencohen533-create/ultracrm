"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Panel, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface C { path: "own_crm" | "external_crm"; steps: Array<{ key: string; title: string; required: boolean; done: boolean; href: string }>; requiredDone: number; requiredTotal: number; ready: boolean; note: string }

/** Onboarding – required vs optional steps, computed from real data; each links to the screen that does it. */
export function OnboardingChecklist() {
  const t = useT(); const [c, setC] = useState<C | null>(null);
  const load = () => api.get<C>("/api/onboarding").then(setC).catch((e) => toast.error((e as Error).message));
  useEffect(() => { void load(); }, []);
  if (!c) return <div className="p-10 flex justify-center"><Spinner /></div>;
  const Row = ({ s }: { s: C["steps"][number] }) => <li className="flex items-center gap-2 py-2"><span aria-hidden className={s.done ? "text-good" : "text-muted"}>{s.done ? "✓" : "○"}</span><span className={s.done ? "text-muted line-through" : ""}>{s.title}</span>{!s.done && <Link className="ms-auto text-xs underline text-accent" href={s.href}>{t("למסך", "Open")}</Link>}</li>;
  return (
    <div className="p-4 md:p-5 max-w-2xl space-y-3" data-testid="onboarding">
      <h1 className="text-lg font-semibold">{t("הקמת העסק", "Business setup")}</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t("מסלול:", "Path:")}</span>
        {(["own_crm", "external_crm"] as const).map((p) => <button key={p} type="button" onClick={async () => setC(await api.put<C>("/api/onboarding", { path: p }))} className={`h-8 px-3 rounded-full border text-xs ${c.path === p ? "bg-accent text-white border-accent" : "border-line"}`}>{p === "own_crm" ? t("CRM של UltraCRM", "UltraCRM's CRM") : t("CRM חיצוני + חייגן / WhatsApp", "External CRM + dialer / WhatsApp")}</button>)}
      </div>
      <Panel title={<span className="flex items-center gap-2">{t("חובה להפעלה", "Required to start")} <Badge tone={c.ready ? "good" : "warn"}>{c.requiredDone}/{c.requiredTotal}</Badge></span>}><ul className="divide-y divide-line text-sm" data-testid="onboarding-required">{c.steps.filter((s) => s.required).map((s) => <Row key={s.key} s={s} />)}</ul></Panel>
      <Panel title={t("חיבורים אופציונליים", "Optional connections")}><ul className="divide-y divide-line text-sm">{c.steps.filter((s) => !s.required).map((s) => <Row key={s.key} s={s} />)}</ul></Panel>
      <p className="text-xs text-muted">{c.note}</p>
    </div>
  );
}
