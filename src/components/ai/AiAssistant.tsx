"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client/api";
import { Badge, ErrorState, Spinner, cx } from "@/components/ui";
import { ChatTab } from "./ChatTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { AutomationsTab } from "./AutomationsTab";
import { SettingsTab } from "./SettingsTab";
import { OpsTab } from "./OpsTab";
import { SalesCoach } from "@/components/coach/SalesCoach";
import { useT } from "@/components/i18n/LangProvider";

export interface Overview { connected: boolean; businessName: string; role: "owner" | "manager" | "agent"; canManage: boolean; canChat: boolean; salesCoach?: boolean; pendingApprovals: number; service: { enabled: boolean; channels: Array<{ id: string; label: string; status: string; active: boolean; simulated: boolean; enabled: boolean }> }; knowledge: Record<string, number> }

const TABS = [
  { key: "chat", label: "צ׳אט", en: "Chat" },
  { key: "ops", label: "מנהל AI", en: "AI Manager", manage: true },
  { key: "knowledge", label: "שירות לקוחות", en: "Customer service", manage: true },
  { key: "sales", label: "מאמן מכירות", en: "Sales coach", manage: true },
  { key: "automations", label: "אוטומציות", en: "Automations", manage: true },
  { key: "settings", label: "הגדרות והרשאות", en: "Settings & permissions", manage: true },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** "מרכז ה־AI": one menu item, several tabs (old links such as ?tab=knowledge keep working). What a tab can do is decided by the server (the tabs only hide what would be refused). */
export function AiAssistant() {
  const t = useT();
  const router = useRouter(); const sp = useSearchParams();
  const [o, setO] = useState<Overview | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setO(await api.get<Overview>("/api/ai")); setErr(null); } catch (e) { setErr((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const tab = (TABS.find((x) => x.key === sp.get("tab"))?.key ?? "chat") as TabKey;
  if (err) return <div className="p-6"><ErrorState message={err} retry={load} /></div>;
  if (!o) return <div className="py-16 flex justify-center"><Spinner /></div>;
  const tabs = TABS.filter((x) => (!("manage" in x) || o.canManage) && (x.key !== "sales" || o.salesCoach !== false));
  return (
    <div className="p-4 md:p-6 space-y-4 min-w-0 w-full" data-testid="ai-page">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{t("מרכז ה־AI", "AI Center")}</h1>
        {o.connected ? <Badge tone="good" dot>{t("מחובר למודל", "Model connected")}</Badge> : <Badge tone="warn" dot data-testid="ai-needs-connection">{t("נדרש חיבור", "Connection required")}</Badge>}
        {o.pendingApprovals > 0 && <Badge tone="info">{t(`${o.pendingApprovals} ממתינות לאישור`, `${o.pendingApprovals} awaiting approval`)}</Badge>}
        <Badge tone={o.service.enabled ? "accent" : "neutral"}>{t("נציג שירות ב-WhatsApp:", "WhatsApp service agent:")} {o.service.enabled ? t("פעיל", "On") : t("כבוי", "Off")}</Badge>
      </div>
      {!o.connected && <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="ai-connection-banner">{t("המודל אינו מחובר. שאלות על נתונים זמינות במצב בסיסי, וכללים נתמכים במנהל AI פועלים לפי ההגדרות שאישרת. פענוח חופשי של בקשות ופעולות מהצ׳אט דורש חיבור למודל; נציג השירות לא יענה ללקוחות עד לחיבור.", "The AI model is not connected. Questions about your data work in basic mode, and supported AI Manager rules run according to the settings you approved. Free-text understanding of requests and actions from the chat require a model connection; the service agent will not reply to customers until it is connected.")}</div>}
      <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {tabs.map((x) => <button key={x.key} role="tab" aria-selected={tab === x.key} data-testid={`ai-tab-${x.key}`} onClick={() => router.replace(`/ai?tab=${x.key}`)} className={cx("px-4 h-10 shrink-0 whitespace-nowrap text-sm -mb-px border-b-2", tab === x.key ? "border-accent text-accent font-semibold" : "border-transparent text-muted hover:text-text")}>{t(x.label, x.en)}</button>)}
      </div>
      {tab === "chat" && (o.canChat ? <ChatTab overview={o} /> : <ErrorState message={t("העוזר זמין כרגע למנהלים בלבד", "The assistant is currently available to managers only")} />)}
      {tab === "ops" && o.canManage && <OpsTab />}
      {tab === "knowledge" && o.canManage && <KnowledgeTab />}
      {tab === "sales" && o.canManage && o.salesCoach !== false && <SalesCoach isOwner={o.role === "owner"} />}
      {tab === "automations" && o.canManage && <AutomationsTab />}
      {tab === "settings" && o.canManage && <SettingsTab overview={o} onSaved={load} />}
    </div>
  );
}
