"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client/api";
import { Badge, ErrorState, Spinner, cx } from "@/components/ui";
import { ChatTab } from "./ChatTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { AutomationsTab } from "./AutomationsTab";
import { SettingsTab } from "./SettingsTab";

export interface Overview { connected: boolean; businessName: string; role: "owner" | "manager" | "agent"; canManage: boolean; canChat: boolean; pendingApprovals: number; service: { enabled: boolean; channels: Array<{ id: string; label: string; status: string; active: boolean; simulated: boolean; enabled: boolean }> }; knowledge: Record<string, number> }

const TABS = [
  { key: "chat", label: "צ׳אט" },
  { key: "knowledge", label: "ידע על העסק", manage: true },
  { key: "automations", label: "אוטומציות", manage: true },
  { key: "settings", label: "הגדרות והרשאות", manage: true },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** "עוזר AI": one menu item, four tabs. What a tab can do is decided by the server (the tabs only hide what would be refused). */
export function AiAssistant() {
  const router = useRouter(); const sp = useSearchParams();
  const [o, setO] = useState<Overview | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setO(await api.get<Overview>("/api/ai")); setErr(null); } catch (e) { setErr((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const tab = (TABS.find((t) => t.key === sp.get("tab"))?.key ?? "chat") as TabKey;
  if (err) return <div className="p-6"><ErrorState message={err} retry={load} /></div>;
  if (!o) return <div className="py-16 flex justify-center"><Spinner /></div>;
  const tabs = TABS.filter((t) => !("manage" in t) || o.canManage);
  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto" data-testid="ai-page">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">עוזר AI</h1>
        {o.connected ? <Badge tone="good" dot>מחובר למודל</Badge> : <Badge tone="warn" dot data-testid="ai-needs-connection">נדרש חיבור</Badge>}
        {o.pendingApprovals > 0 && <Badge tone="info">{o.pendingApprovals} ממתינות לאישור</Badge>}
        <Badge tone={o.service.enabled ? "accent" : "neutral"}>נציג שירות ב-WhatsApp: {o.service.enabled ? "פעיל" : "כבוי"}</Badge>
      </div>
      {!o.connected && <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="ai-connection-banner">נדרש חיבור: לא הוגדר מפתח למודל AI בשרת (ANTHROPIC_API_KEY). במצב הזה אפשר לשאול שאלות על נתונים (מצב בסיסי), לנהל ידע ואוטומציות קיימות – אך העוזר לא יבצע פעולות מהצ׳אט ונציג השירות לא יענה ללקוחות.</div>}
      <div className="flex gap-1 border-b border-line" role="tablist">
        {tabs.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} data-testid={`ai-tab-${t.key}`} onClick={() => router.replace(`/ai?tab=${t.key}`)} className={cx("px-4 h-10 text-sm -mb-px border-b-2", tab === t.key ? "border-accent text-accent font-semibold" : "border-transparent text-muted hover:text-text")}>{t.label}</button>)}
      </div>
      {tab === "chat" && (o.canChat ? <ChatTab overview={o} /> : <ErrorState message="העוזר זמין כרגע למנהלים בלבד" />)}
      {tab === "knowledge" && o.canManage && <KnowledgeTab />}
      {tab === "automations" && o.canManage && <AutomationsTab />}
      {tab === "settings" && o.canManage && <SettingsTab overview={o} onSaved={load} />}
    </div>
  );
}
