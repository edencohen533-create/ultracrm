"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { cx } from "@/components/ui";

interface Summary {
  leadsNew: number; leadsOpen: number; conversationsWaiting: number | null; missedCalls: number | null; callbacksDue: number; tasksDue: number; tasksOverdue: number;
  modules: { crm: boolean; messaging: boolean; telephony: boolean }; scope: "mine" | "team";
}

/** "What is waiting for me" – each tile opens the matching filtered list. Replaces the old cross-module dashboard for agents. */
export function WorkStrip({ refreshKey = 0 }: { refreshKey?: number }) {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<Summary>("/api/workspace/summary").then((r) => alive && setS(r)).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [refreshKey]);
  if (!s) return null;
  const tiles: Array<{ label: string; value: number; href: string; tone?: "warn" | "bad" }> = [
    { label: "לידים חדשים לטיפול", value: s.leadsNew, href: "/leads?status=new&mine=1" },
    ...(s.conversationsWaiting !== null ? [{ label: "הודעות ממתינות למענה", value: s.conversationsWaiting, href: "/inbox?filter=mine", tone: s.conversationsWaiting ? ("warn" as const) : undefined }] : []),
    ...(s.missedCalls !== null ? [{ label: "שיחות שלא נענו היום", value: s.missedCalls, href: "/inbox?tab=calls&missed=1", tone: s.missedCalls ? ("warn" as const) : undefined }] : []),
    { label: "חזרות ללקוחות להיום", value: s.callbacksDue, href: "/leads?tasks=1&type=callback&due=today", tone: s.callbacksDue ? "warn" : undefined },
    { label: "משימות להיום", value: s.tasksDue, href: "/leads?tasks=1&due=today" },
    { label: "באיחור", value: s.tasksOverdue, href: "/leads?tasks=1&due=overdue", tone: s.tasksOverdue ? "bad" : undefined },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2" data-testid="work-strip">
      {tiles.map((t) => (
        <Link key={t.label} href={t.href} className={cx("rounded-lg border border-line bg-panel px-3 py-2 hover:border-accent transition-colors", t.tone === "bad" && "border-bad/40", t.tone === "warn" && "border-warn/40")}>
          <p className={cx("text-xl font-semibold tabular leading-tight", t.tone === "bad" && "text-bad", t.tone === "warn" && "text-warn")}>{t.value}</p>
          <p className="text-[11px] text-muted">{t.label}</p>
        </Link>
      ))}
    </div>
  );
}
