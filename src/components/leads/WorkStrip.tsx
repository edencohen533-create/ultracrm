"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Summary {
  leadsNew: number; leadsOpen: number; conversationsWaiting: number | null; missedCalls: number | null; callbacksDue: number; tasksDue: number; tasksOverdue: number;
  modules: { crm: boolean; messaging: boolean; telephony: boolean }; scope: "mine" | "team";
}

/** "What is waiting for me" – each tile opens the matching filtered list. Replaces the old cross-module dashboard for agents. */
export function WorkStrip({ refreshKey = 0 }: { refreshKey?: number }) {
  const [s, setS] = useState<Summary | null>(null);
  const t = useT();
  useEffect(() => {
    let alive = true;
    const load = () => api.get<Summary>("/api/workspace/summary").then((r) => alive && setS(r)).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [refreshKey]);
  if (!s) return null;
  const tiles: Array<{ label: string; value: number; href: string; tone?: "warn" | "bad" }> = [
    { label: t("לידים חדשים לטיפול", "New leads to handle"), value: s.leadsNew, href: "/leads?status=new&mine=1" },
    ...(s.conversationsWaiting !== null ? [{ label: t("הודעות ממתינות למענה", "Messages awaiting reply"), value: s.conversationsWaiting, href: "/inbox?filter=mine", tone: s.conversationsWaiting ? ("warn" as const) : undefined }] : []),
    ...(s.missedCalls !== null ? [{ label: t("שיחות שלא נענו היום", "Missed calls today"), value: s.missedCalls, href: "/leads?tasks=1&view=calls&missed=1", tone: s.missedCalls ? ("warn" as const) : undefined }] : []),
    { label: t("חזרות ללקוחות להיום", "Callbacks due today"), value: s.callbacksDue, href: "/leads?tasks=1&type=callback&due=today", tone: s.callbacksDue ? "warn" : undefined },
    { label: t("משימות להיום", "Tasks for today"), value: s.tasksDue, href: "/leads?tasks=1&due=today" },
    { label: t("באיחור", "Overdue"), value: s.tasksOverdue, href: "/leads?tasks=1&due=overdue", tone: s.tasksOverdue ? "bad" : undefined },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2" data-testid="work-strip">
      {tiles.map((tile) => (
        <Link key={tile.label} href={tile.href} className={cx("rounded-lg border border-line bg-panel px-3 py-2 hover:border-accent transition-colors", tile.tone === "bad" && "border-bad/40", tile.tone === "warn" && "border-warn/40")}>
          <p className={cx("text-xl font-semibold tabular leading-tight", tile.tone === "bad" && "text-bad", tile.tone === "warn" && "text-warn")}>{tile.value}</p>
          <p className="text-[11px] text-muted">{tile.label}</p>
        </Link>
      ))}
    </div>
  );
}
