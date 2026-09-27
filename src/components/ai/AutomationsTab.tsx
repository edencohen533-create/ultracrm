"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Modal, Panel, Spinner } from "@/components/ui";

interface Auto { id: string; name: string; description: string; state: "draft" | "active" | "paused" | "needs_attention"; trigger: string; lastRunAt: string | null; completed: number; failed: number; skipped: number; pending: number; updatedAt: string }
interface Run { id: string; status: string; startedAt: string; completedAt: string | null; stopReason: string | null; stepIndex: number; log: Array<{ step?: number; skipped?: string | null; messageId?: string | null; at?: string }>; contact: { fullName: string } }
interface Incident { id: string; module: string; question: string; statusLabel: string; status: string; createdAt: string; requestedBy: string | null; actions: Array<{ id: string; summary: string; status: string }> }
const STATE: Record<Auto["state"], { l: string; t: "neutral" | "good" | "warn" | "bad" }> = { draft: { l: "טיוטה", t: "neutral" }, active: { l: "פעילה", t: "good" }, paused: { l: "מושהית", t: "warn" }, needs_attention: { l: "דורשת טיפול", t: "bad" } };
const RUN: Record<string, string> = { COMPLETED: "הושלמה", FAILED: "נכשלה", STOPPED: "נעצרה/דולגה", PENDING: "ממתינה", RUNNING: "רצה" };
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "—");

export function AutomationsTab() {
  const router = useRouter();
  const [items, setItems] = useState<Auto[] | null>(null); const [incidents, setIncidents] = useState<Incident[]>([]);
  const [open, setOpen] = useState<string | null>(null); const [confirm, setConfirm] = useState<{ a: Auto; versionAt: string; description: string } | null>(null);
  const [runs, setRuns] = useState<Record<string, Run[]>>({}); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const [a, i] = await Promise.all([api.get<{ items: Auto[] }>("/api/ai/automations"), api.get<{ items: Incident[] }>("/api/ai/incidents")]); setItems(a.items); setIncidents(i.items); }
    catch (e) { toast.error((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function toggleRuns(a: Auto) {
    if (open === a.id) { setOpen(null); return; }
    setOpen(a.id);
    try { const r = await api.get<{ runs: Run[] }>(`/api/ai/automations/${a.id}`); setRuns((x) => ({ ...x, [a.id]: r.runs })); } catch (e) { toast.error((e as Error).message); }
  }
  async function askActivate(a: Auto) {
    try { const r = await api.get<{ versionAt: string; description: string }>(`/api/ai/automations/${a.id}`); setConfirm({ a, versionAt: r.versionAt, description: r.description }); } catch (e) { toast.error((e as Error).message); }
  }
  async function act(a: Auto, action: "pause" | "activate", versionAt?: string) {
    setBusy(true);
    try { await api.post(`/api/ai/automations/${a.id}`, { action, versionAt }); toast.success(action === "pause" ? "האוטומציה הושהתה" : "האוטומציה הופעלה – תפעל על אירועים חדשים בלבד"); setConfirm(null); await load(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  if (!items) return <div className="py-10 flex justify-center"><Spinner /></div>;
  return (
    <div className="space-y-4" data-testid="ai-automations">
      <div className="flex items-center justify-between gap-2"><p className="text-sm text-muted">יוצרים ועורכים אוטומציות בשפה חופשית בצ׳אט. העוזר בונה אותן מקטלוג קבוע, שומר כטיוטה, ומפעיל רק אחרי אישור הגרסה המוצגת.</p>
        <Button variant="secondary" onClick={() => router.replace("/ai?tab=chat")}>אוטומציה חדשה בצ׳אט</Button></div>
      {!items.length ? <EmptyState title="אין עדיין אוטומציות" hint="למשל: ״כל ליד שלא ענה 3 פעמים – לשלוח לו וואטסאפ עם התבנית follow_up״" /> :
        <div className="space-y-2">{items.map((a) => <Panel key={a.id} bodyClassName="p-3">
          <div className="flex flex-wrap items-start gap-3" data-testid="auto-row">
            <div className="flex-1 min-w-[240px]"><div className="flex items-center gap-2"><span className="font-semibold">{a.name}</span><Badge tone={STATE[a.state].t}>{STATE[a.state].l}</Badge></div><div className="text-sm text-muted mt-1">{a.description}</div></div>
            <div className="text-xs text-muted space-y-0.5 min-w-[180px]"><div>ריצה אחרונה: {fmt(a.lastRunAt)}</div><div>הצליחו {a.completed} · נכשלו <span className={a.failed ? "text-bad" : ""}>{a.failed}</span> · דולגו {a.skipped} · ממתינות {a.pending}</div></div>
            <div className="flex gap-1.5">
              {a.state === "active" || a.state === "needs_attention" ? <Button size="sm" variant="secondary" onClick={() => act(a, "pause")} loading={busy} data-testid="auto-pause">השהה</Button> : <Button size="sm" onClick={() => askActivate(a)} data-testid="auto-activate">{a.state === "draft" ? "בדוק והפעל" : "הפעל מחדש"}</Button>}
              <Button size="sm" variant="ghost" onClick={() => toggleRuns(a)}>{open === a.id ? "הסתר" : "היסטוריה"}</Button>
            </div>
          </div>
          {open === a.id && <div className="mt-3 border-t border-line pt-2 text-sm">{!runs[a.id] ? <Spinner /> : !runs[a.id].length ? <p className="text-muted text-xs">אין ריצות</p> :
            <table className="w-full text-xs"><thead className="text-muted"><tr><th className="text-start">לקוח</th><th className="text-start">התחילה</th><th className="text-start">מצב</th><th className="text-start">סיבה / שלבים</th></tr></thead><tbody className="divide-y divide-line">
              {runs[a.id].map((r) => <tr key={r.id}><td className="py-1">{r.contact.fullName}</td><td>{fmt(r.startedAt)}</td><td>{RUN[r.status] ?? r.status}</td><td className="text-muted">{r.stopReason ?? (r.log ?? []).map((l) => `שלב ${(l.step ?? 0) + 1}: ${l.skipped ? `דולג (${l.skipped})` : l.messageId ? "נשלח" : "בוצע"}`).join(" · ")}</td></tr>)}
            </tbody></table>}</div>}
        </Panel>)}</div>}
      <Panel title="אבחונים ותקלות">
        {!incidents.length ? <p className="text-sm text-muted">אין עדיין אבחונים. אפשר לשאול בצ׳אט למשל ״למה דני לא קיבל את ההודעה?״</p> :
          <table className="w-full text-sm" data-testid="ai-incidents"><tbody className="divide-y divide-line">{incidents.slice(0, 30).map((i) => <tr key={i.id}><td className="py-1.5 text-xs text-muted whitespace-nowrap">{fmt(i.createdAt)}</td><td className="px-2">{i.question}<div className="text-xs text-muted">{i.module}{i.requestedBy ? ` · ${i.requestedBy}` : ""}{i.actions.length ? ` · תיקונים: ${i.actions.map((x) => `${x.summary} (${x.status})`).join(", ")}` : ""}</div></td><td><Badge tone={i.status === "fixed_verified" || i.status === "no_issue" ? "good" : i.status === "external" || i.status === "escalated" ? "bad" : i.status === "approval_required" ? "info" : "warn"}>{i.statusLabel}</Badge></td></tr>)}</tbody></table>}
      </Panel>
      {confirm && <Modal open onClose={() => setConfirm(null)} title={`הפעלת "${confirm.a.name}"`} footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>ביטול</Button><Button onClick={() => act(confirm.a, "activate", confirm.versionAt)} loading={busy} data-testid="auto-confirm">מאשר את הגרסה הזו – הפעל</Button></>}>
        <div className="space-y-2 text-sm"><p>{confirm.description}</p><p className="text-muted text-xs">גרסה: {fmt(confirm.versionAt)}. תפעל על אירועים חדשים בלבד מרגע האישור. הודעות יישלחו רק ללקוחות שאישרו דיוור ולא הוסרו, בכפוף למגבלות השליחה. אם האוטומציה תשתנה לפני האישור – ההפעלה תידחה.</p></div>
      </Modal>}
    </div>
  );
}
