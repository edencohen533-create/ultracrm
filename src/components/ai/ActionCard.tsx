"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

export interface AiActionView { id: string; kind: string; summary: string; impact: string | null; status: string; requiresApproval: boolean; result: unknown; error: string | null; createdAt: string; executedAt: string | null; approved: boolean }
const STATUS: Record<string, { label: string; en: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  proposed: { label: "ממתין לאישור", en: "Awaiting approval", tone: "info" }, executing: { label: "מבצע…", en: "Executing…", tone: "warn" }, executed: { label: "בוצע (אושר בשרת)", en: "Done (confirmed by server)", tone: "good" },
  failed: { label: "נכשל", en: "Failed", tone: "bad" }, cancelled: { label: "בוטל", en: "Cancelled", tone: "neutral" }, skipped: { label: "דולג", en: "Skipped", tone: "neutral" },
};

/** The status shown is ALWAYS the server row's status – never the model's wording. */
export function ActionCard({ action, onChange }: { action: AiActionView; onChange?: (a: AiActionView) => void }) {
  const t = useT();
  const [a, setA] = useState(action); const [busy, setBusy] = useState<string | null>(null);
  const st = STATUS[a.status] ?? { label: a.status, en: a.status, tone: "neutral" as const };
  async function approve() {
    setBusy("approve");
    try { const r = await api.post<AiActionView>(`/api/ai/actions/${a.id}/approve`); setA(r); onChange?.(r); if (r.status === "executed") toast.success(t("בוצע", "Done")); else if (r.status === "failed") toast.error(r.error ?? t("נכשל", "Failed")); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function cancel() {
    setBusy("cancel");
    try { await api.post(`/api/ai/actions/${a.id}/cancel`); const r = { ...a, status: "cancelled" }; setA(r); onChange?.(r); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  return (
    <div className="rounded-lg border border-line bg-panel p-3 text-sm space-y-1.5" data-testid="ai-action-card" data-status={a.status}>
      <div className="flex items-start justify-between gap-2"><div className="font-medium">{a.summary}</div><Badge tone={st.tone}>{t(st.label, st.en)}</Badge></div>
      {a.impact && <div className="text-xs text-muted">{t("השפעה:", "Impact:")} {a.impact}</div>}
      {a.status === "failed" && a.error && <div className="text-xs text-bad">{a.error}</div>}
      {a.status === "proposed" && <div className="flex gap-2 pt-1"><Button size="sm" onClick={approve} loading={busy === "approve"} data-testid="ai-action-approve">{t("אשר ובצע", "Approve & run")}</Button><Button size="sm" variant="ghost" onClick={cancel} loading={busy === "cancel"} data-testid="ai-action-cancel">{t("בטל", "Cancel")}</Button></div>}
    </div>
  );
}
