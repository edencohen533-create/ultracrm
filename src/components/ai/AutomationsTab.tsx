"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Modal, Panel, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Auto { id: string; name: string; description: string; state: "draft" | "active" | "paused" | "needs_attention"; trigger: string; lastRunAt: string | null; completed: number; failed: number; skipped: number; pending: number; updatedAt: string }
interface Run { id: string; status: string; startedAt: string; completedAt: string | null; stopReason: string | null; stepIndex: number; log: Array<{ step?: number; skipped?: string | null; messageId?: string | null; at?: string }>; contact: { fullName: string } }
interface Incident { id: string; module: string; question: string; statusLabel: string; status: string; createdAt: string; requestedBy: string | null; actions: Array<{ id: string; summary: string; status: string }> }
const STATE: Record<Auto["state"], { l: string; en: string; t: "neutral" | "good" | "warn" | "bad" }> = { draft: { l: "טיוטה", en: "Draft", t: "neutral" }, active: { l: "פעילה", en: "Active", t: "good" }, paused: { l: "מושהית", en: "Paused", t: "warn" }, needs_attention: { l: "דורשת טיפול", en: "Needs attention", t: "bad" } };
const RUN: Record<string, [string, string]> = { COMPLETED: ["הושלמה", "Completed"], FAILED: ["נכשלה", "Failed"], STOPPED: ["נעצרה/דולגה", "Stopped/skipped"], PENDING: ["ממתינה", "Pending"], RUNNING: ["רצה", "Running"] };
const fmt = (d: string | null, locale = "he-IL") => (d ? new Date(d).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "—");

export function AutomationsTab() {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
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
    try { await api.post(`/api/ai/automations/${a.id}`, { action, versionAt }); toast.success(action === "pause" ? t("האוטומציה הושהתה", "Automation paused") : t("האוטומציה הופעלה – תפעל על אירועים חדשים בלבד", "Automation activated – it will act on new events only")); setConfirm(null); await load(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  if (!items) return <div className="py-10 flex justify-center"><Spinner /></div>;
  return (
    <div className="space-y-4" data-testid="ai-automations">
      <div className="flex items-center justify-between gap-2"><p className="text-sm text-muted">{t("יוצרים ועורכים אוטומציות בשפה חופשית בצ׳אט. העוזר בונה אותן מקטלוג קבוע, שומר כטיוטה, ומפעיל רק אחרי אישור הגרסה המוצגת.", "Create and edit automations in plain language in the chat. The assistant builds them from a fixed catalog, saves them as drafts, and activates them only after you approve the displayed version.")}</p>
        <Button variant="secondary" onClick={() => router.replace("/ai?tab=chat")}>{t("אוטומציה חדשה בצ׳אט", "New automation in chat")}</Button></div>
      {!items.length ? <EmptyState title={t("אין עדיין אוטומציות", "No automations yet")} hint={t("למשל: ״כל ליד שלא ענה 3 פעמים – לשלוח לו וואטסאפ עם התבנית follow_up״", "For example: “Every lead who didn’t answer 3 times – send them a WhatsApp with the follow_up template”")} /> :
        <div className="space-y-2">{items.map((a) => <Panel key={a.id} bodyClassName="p-3">
          <div className="flex flex-wrap items-start gap-3" data-testid="auto-row">
            <div className="flex-1 min-w-[240px]"><div className="flex items-center gap-2"><span className="font-semibold">{a.name}</span><Badge tone={STATE[a.state].t}>{t(STATE[a.state].l, STATE[a.state].en)}</Badge></div><div className="text-sm text-muted mt-1">{a.description}</div></div>
            <div className="text-xs text-muted space-y-0.5 min-w-[180px]"><div>{t("ריצה אחרונה:", "Last run:")} {fmt(a.lastRunAt, loc)}</div><div>{t("הצליחו", "Succeeded")} {a.completed} · {t("נכשלו", "Failed")} <span className={a.failed ? "text-bad" : ""}>{a.failed}</span> · {t("דולגו", "Skipped")} {a.skipped} · {t("ממתינות", "Pending")} {a.pending}</div></div>
            <div className="flex gap-1.5">
              {a.state === "active" || a.state === "needs_attention" ? <Button size="sm" variant="secondary" onClick={() => act(a, "pause")} loading={busy} data-testid="auto-pause">{t("השהה", "Pause")}</Button> : <Button size="sm" onClick={() => askActivate(a)} data-testid="auto-activate">{a.state === "draft" ? t("בדוק והפעל", "Review & activate") : t("הפעל מחדש", "Reactivate")}</Button>}
              <Button size="sm" variant="ghost" onClick={() => toggleRuns(a)}>{open === a.id ? t("הסתר", "Hide") : t("היסטוריה", "History")}</Button>
            </div>
          </div>
          {open === a.id && <div className="mt-3 border-t border-line pt-2 text-sm">{!runs[a.id] ? <Spinner /> : !runs[a.id].length ? <p className="text-muted text-xs">{t("אין ריצות", "No runs")}</p> :
            <table className="w-full text-xs"><thead className="text-muted"><tr><th className="text-start">{t("לקוח", "Customer")}</th><th className="text-start">{t("התחילה", "Started")}</th><th className="text-start">{t("מצב", "Status")}</th><th className="text-start">{t("סיבה / שלבים", "Reason / steps")}</th></tr></thead><tbody className="divide-y divide-line">
              {runs[a.id].map((r) => <tr key={r.id}><td className="py-1">{r.contact.fullName}</td><td>{fmt(r.startedAt, loc)}</td><td>{RUN[r.status] ? t(RUN[r.status][0], RUN[r.status][1]) : r.status}</td><td className="text-muted">{r.stopReason ?? (r.log ?? []).map((l) => t(`שלב ${(l.step ?? 0) + 1}: ${l.skipped ? `דולג (${l.skipped})` : l.messageId ? "נשלח" : "בוצע"}`, `Step ${(l.step ?? 0) + 1}: ${l.skipped ? `skipped (${l.skipped})` : l.messageId ? "sent" : "done"}`)).join(" · ")}</td></tr>)}
            </tbody></table>}</div>}
        </Panel>)}</div>}
      <Panel title={t("אבחונים ותקלות", "Diagnostics & incidents")}>
        {!incidents.length ? <p className="text-sm text-muted">{t("אין עדיין אבחונים. אפשר לשאול בצ׳אט למשל ״למה דני לא קיבל את ההודעה?״", "No diagnostics yet. You can ask in the chat, e.g. “Why didn’t Danny get the message?”")}</p> :
          <table className="w-full text-sm" data-testid="ai-incidents"><tbody className="divide-y divide-line">{incidents.slice(0, 30).map((i) => <tr key={i.id}><td className="py-1.5 text-xs text-muted whitespace-nowrap">{fmt(i.createdAt, loc)}</td><td className="px-2">{i.question}<div className="text-xs text-muted">{i.module}{i.requestedBy ? ` · ${i.requestedBy}` : ""}{i.actions.length ? ` · ${t("תיקונים:", "Fixes:")} ${i.actions.map((x) => `${x.summary} (${x.status})`).join(", ")}` : ""}</div></td><td><Badge tone={i.status === "fixed_verified" || i.status === "no_issue" ? "good" : i.status === "external" || i.status === "escalated" ? "bad" : i.status === "approval_required" ? "info" : "warn"}>{i.statusLabel}</Badge></td></tr>)}</tbody></table>}
      </Panel>
      {confirm && <Modal open onClose={() => setConfirm(null)} title={t(`הפעלת "${confirm.a.name}"`, `Activate "${confirm.a.name}"`)} footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>{t("ביטול", "Cancel")}</Button><Button onClick={() => act(confirm.a, "activate", confirm.versionAt)} loading={busy} data-testid="auto-confirm">{t("מאשר את הגרסה הזו – הפעל", "I approve this version – activate")}</Button></>}>
        <div className="space-y-2 text-sm"><p>{confirm.description}</p><p className="text-muted text-xs">{t("גרסה:", "Version:")} {fmt(confirm.versionAt, loc)}. {t("תפעל על אירועים חדשים בלבד מרגע האישור. הודעות יישלחו רק ללקוחות שאישרו דיוור ולא הוסרו, בכפוף למגבלות השליחה. אם האוטומציה תשתנה לפני האישור – ההפעלה תידחה.", "It will act on new events only from the moment of approval. Messages will be sent only to customers who opted in to marketing and haven’t unsubscribed, subject to sending limits. If the automation changes before approval, activation will be rejected.")}</p></div>
      </Modal>}
    </div>
  );
}
