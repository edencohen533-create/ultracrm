"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button } from "@/components/ui";

export interface AiActionView { id: string; kind: string; summary: string; impact: string | null; status: string; requiresApproval: boolean; result: unknown; error: string | null; createdAt: string; executedAt: string | null; approved: boolean }
const STATUS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  proposed: { label: "ממתין לאישור", tone: "info" }, executing: { label: "מבצע…", tone: "warn" }, executed: { label: "בוצע (אושר בשרת)", tone: "good" },
  failed: { label: "נכשל", tone: "bad" }, cancelled: { label: "בוטל", tone: "neutral" }, skipped: { label: "דולג", tone: "neutral" },
};

/** The status shown is ALWAYS the server row's status – never the model's wording. */
export function ActionCard({ action, onChange }: { action: AiActionView; onChange?: (a: AiActionView) => void }) {
  const [a, setA] = useState(action); const [busy, setBusy] = useState<string | null>(null);
  const st = STATUS[a.status] ?? { label: a.status, tone: "neutral" as const };
  async function approve() {
    setBusy("approve");
    try { const r = await api.post<AiActionView>(`/api/ai/actions/${a.id}/approve`); setA(r); onChange?.(r); if (r.status === "executed") toast.success("בוצע"); else if (r.status === "failed") toast.error(r.error ?? "נכשל"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function cancel() {
    setBusy("cancel");
    try { await api.post(`/api/ai/actions/${a.id}/cancel`); const r = { ...a, status: "cancelled" }; setA(r); onChange?.(r); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  return (
    <div className="rounded-lg border border-line bg-panel p-3 text-sm space-y-1.5" data-testid="ai-action-card" data-status={a.status}>
      <div className="flex items-start justify-between gap-2"><div className="font-medium">{a.summary}</div><Badge tone={st.tone}>{st.label}</Badge></div>
      {a.impact && <div className="text-xs text-muted">השפעה: {a.impact}</div>}
      {a.status === "failed" && a.error && <div className="text-xs text-bad">{a.error}</div>}
      {a.status === "proposed" && <div className="flex gap-2 pt-1"><Button size="sm" onClick={approve} loading={busy === "approve"} data-testid="ai-action-approve">אשר ובצע</Button><Button size="sm" variant="ghost" onClick={cancel} loading={busy === "cancel"} data-testid="ai-action-cancel">בטל</Button></div>}
    </div>
  );
}
