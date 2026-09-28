"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";

interface Req { proposal?: { leadId?: string }; id: string; kind: string; code: string; managerApprovedCount: number | null; expiresAt: string; text: string }

/**
 * Agent: an extra-leads request approved by the manager, waiting for MY answer (the in-app twin of the WhatsApp
 * question). Nothing is assigned until I answer; no answer = no leads.
 */
export function OpsAgentRequests() {
  const [items, setItems] = useState<Req[]>([]); const [n, setN] = useState<Record<string, number>>({}); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setItems(await api.get<Req[]>("/api/ops/my-requests")); } catch { setItems([]); } }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);
  if (!items.length) return null;
  const answer = async (r: Req, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ status: string; message?: string; reason?: string }>(`/api/ops/my-requests/${r.id}`, body);
      if (res.status === "unclear") toast.message(res.message ?? "לא הובן");
      else if (r.kind === "followup_checkin") toast.message(res.message ?? "התשובה נשמרה");
      else toast.success(res.status === "active" || res.status === "completed" ? "ההקצאה הופעלה" : res.status === "rejected" ? "נרשם – לא יוקצו לידים" : res.reason ?? res.status);
      await load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="border-b border-line bg-accent/10 px-4 py-2 space-y-2 text-sm" data-testid="ops-agent-requests">
      {items.map((r) => { const max = r.managerApprovedCount ?? 1; const v = n[r.id] ?? max; return (
        <div key={r.id} className="flex flex-wrap items-center gap-2" data-testid={`ops-agent-request-${r.id}`}>
          <span className="whitespace-pre-line flex-1 min-w-[260px]">{r.text.split("\n\nאפשר לענות")[0]}</span>
          {r.kind === "lead_response_sla" ? <span className="text-xs text-warn">יעד הזמן עבר. ההתראה תיסגר כשיירשם ניסיון חיוג בפועל. {r.proposal?.leadId && <a className="underline" href={`/leads?leadId=${encodeURIComponent(r.proposal.leadId)}`}>פתח ליד</a>}</span> : r.kind === "followup_checkin" ? <><Button size="sm" loading={busy} onClick={() => answer(r, { text: "connect" })} data-testid="followup-connect">אני מתחבר לחייגן</Button><Button size="sm" variant="secondary" loading={busy} onClick={() => answer(r, { text: "transfer" })} data-testid="followup-transfer">בקש להעביר לנציג אחר</Button></> : <>
          <Button size="sm" loading={busy} onClick={() => answer(r, { answer: "yes" })} data-testid="ops-agent-yes">כן, אפשר להעביר {max}</Button>
          <span className="flex items-center gap-1 text-xs">או<input type="number" min={1} max={max} value={v} onChange={(e) => setN({ ...n, [r.id]: Math.max(1, Math.min(max, Number(e.target.value))) })} className="h-8 w-14 rounded border border-line bg-bg px-1" /><Button size="sm" variant="secondary" loading={busy} onClick={() => answer(r, { answer: "yes", count: v })} data-testid="ops-agent-partial">רק {v}</Button></span>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => answer(r, { answer: "no" })} data-testid="ops-agent-no">לא היום</Button></>}
        </div>); })}
    </div>
  );
}
