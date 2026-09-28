"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { LeadsWorkspace } from "@/components/leads/LeadsWorkspace";
import { toast } from "sonner";
import { ExhaustionPreview } from "@/components/dialer/ExhaustionPreview";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Phone, Select, Spinner, Stat } from "@/components/ui";
import { LEAD_STATUS_LABEL, formatDateTime, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";
import { useT } from "@/components/i18n/LangProvider";

interface ListFull { id: string; name: string; unansweredLimit?: number | null; description: string | null; isActive: boolean; isPaused: boolean; isDynamic: boolean; archivedAt: string | null; lastRefreshedAt: string | null; priority: number; maxAttempts: number | null; retryIntervalMinutes: number | null; dialWindowJson: { start: string; end: string; days: number[] } | null; agents: Array<{ user: { id: string; fullName: string } }>; stats: { byStatus: Record<string, number>; dueNow: number; total: number; unavailable: { notDueYet: number; inProgress: number; exhausted: number; completed: number; dnc: number; removed: number; outsideDialWindow: boolean; listPaused: boolean; listInactive: boolean } } }
interface LeadRow { id: string; status: string; attempts: number; priority: number; lastAttemptAt: string | null; nextAttemptAt: string | null; lastOutcome: string | null; lastSkipReason: string | null; contact: { id: string; fullName: string; phoneE164: string; source: string | null }; lockedBy: { fullName: string } | null }

/**
 * A dial list: the list's header/controls/queue stats, then the same lead workspace as /leads (filtered to the
 * list's contacts) with a "תור החיוג" view that keeps the queue-level table (attempts, next attempt, transfer, requeue).
 */
export function ListQueuePanel({ id }: { id: string }) {
  const [view, setView] = useState<"leads" | "queue">("leads");
  const t = useT();
  const [list, setList] = useState<ListFull | null>(null);
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addFilter, setAddFilter] = useState({ source: "", city: "", neverCalled: false });
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; role: string }>>([]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [agentMode, setAgentMode] = useState<"all" | "selected">("all");
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitDraft, setLimitDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([api.get<ListFull>(`/api/lists/${id}`), api.get<{ items: LeadRow[]; total: number }>(`/api/lists/${id}/leads${qs({ status, q, page, limit: 50 })}`)]);
      setList(l);
      setRows(r.items);
      setTotal(r.total);
      setAgentIds(l.agents.map((a) => a.user.id));
      setAgentMode(l.agents.length ? "selected" : "all");
      setLimitDraft(l.unansweredLimit === null || l.unansweredLimit === undefined ? "" : String(l.unansweredLimit));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id, status, q, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    api.get<{ user: { role: string } }>("/api/auth/me").then((m) => setMe(m.user)).catch(() => undefined);
    api.get<{ items: typeof users }>("/api/users").then((u) => setUsers(u.items)).catch(() => undefined);
  }, []);

  const isManager = me?.role !== "agent";
  async function bulk(action: "remove" | "requeue") {
    if (sel.size === 0) return;
    try {
      await api.patch(`/api/lists/${id}/leads`, { leadIds: [...sel], action });
      setSel(new Set());
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function toggleActive() {
    if (!list) return;
    try { await api.patch(`/api/lists/${id}`, { isActive: !list.isActive }); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function addFromFilter() {
    try {
      const r = await api.post<{ added: number }>(`/api/lists/${id}/leads`, { filter: { source: addFilter.source || undefined, city: addFilter.city || undefined, neverCalled: addFilter.neverCalled ? "true" : undefined, notInListId: id } });
      toast.success(t(`נוספו ${r.added} לידים`, `Added ${r.added} leads`));
      setAddOpen(false);
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function patchList(body: object, msg: string) { try { await api.patch(`/api/lists/${id}`, body); toast.success(msg); load(); } catch (e) { toast.error((e as Error).message); } }
  async function duplicate() { try { const r = await api.post<{ id: string; copied: number }>(`/api/lists/${id}/duplicate`, { withLeads: true }); toast.success(t(`שוכפל עם ${r.copied} לידים`, `Duplicated with ${r.copied} leads`)); window.location.href = `/lists/${r.id}`; } catch (e) { toast.error((e as Error).message); } }
  async function refresh() { try { const r = await api.post<{ added: number }>(`/api/lists/${id}/refresh`); toast.success(t(`רוענן: נוספו ${r.added}`, `Refreshed: added ${r.added}`)); load(); } catch (e) { toast.error((e as Error).message); } }
  async function transfer(leadId: string) {
    const toUserId = window.prompt(t("מזהה/שם נציג יעד (ריק = חזרה למאגר):", "Target agent ID/name (empty = back to pool):") + "\n" + users.filter((u) => u.role !== "owner").map((u) => `${u.fullName} = ${u.id}`).join("\n"));
    if (toUserId === null) return;
    const match = users.find((u) => u.id === toUserId.trim() || u.fullName === toUserId.trim());
    try { await api.post(`/api/queue/${leadId}/transfer`, { toUserId: toUserId.trim() ? match?.id ?? toUserId.trim() : null }); toast.success(t("הליד הועבר", "Lead transferred")); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function saveAgents() {
    try { await api.put(`/api/lists/${id}/agents`, { mode: agentMode, agentIds: agentMode === "all" ? [] : agentIds }); toast.success(agentMode === "all" ? t("הקמפיין פתוח לכל הנציגים", "The campaign is open to all agents") : t(`הקמפיין פתוח ל-${agentIds.length} נציגים`, `The campaign is open to ${agentIds.length} agents`)); setAgentsOpen(false); load(); } catch (e) { toast.error((e as Error).message); }
  }

  if (!list) return <div className="flex justify-center p-10"><Spinner /></div>;
  const s = list.stats;

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{list.name}</h1>
        <Badge tone={list.isActive ? "good" : "neutral"}>{list.isActive ? t("פעילה", "Active") : t("לא פעילה", "Inactive")}</Badge>
        {list.dialWindowJson && <span className="text-xs text-muted ltr">{list.dialWindowJson.start}–{list.dialWindowJson.end}</span>}
        {list.isPaused && <Badge tone="bad">{t("מושהית", "Paused")}</Badge>}
        {list.archivedAt && <Badge tone="neutral">{t("בארכיון", "Archived")}</Badge>}
        <Badge tone="neutral">{list.isDynamic ? t("דינמית", "Dynamic") : t("מוקפאת", "Frozen")}</Badge>
        {isManager && (
          <div className="ms-auto flex flex-wrap gap-2">
            {list.isDynamic && <Button size="sm" variant="secondary" onClick={refresh}>{t("רענן מהסינון", "Refresh from filter")}</Button>}
            <Button size="sm" variant="secondary" onClick={duplicate}>{t("שכפל", "Duplicate")}</Button>
            <Button size="sm" variant="secondary" onClick={() => patchList({ isPaused: !list.isPaused }, list.isPaused ? t("החיוג ברשימה חודש", "Dialing resumed for the list") : t("החיוג ברשימה הושהה", "Dialing paused for the list"))}>{list.isPaused ? t("חדש חיוג", "Resume dialing") : t("השהה חיוג", "Pause dialing")}</Button>
            <Button size="sm" variant="secondary" onClick={() => patchList({ archived: !list.archivedAt }, list.archivedAt ? t("הוצא מארכיון", "Unarchived") : t("הועבר לארכיון", "Archived"))}>{list.archivedAt ? t("הוצא מארכיון", "Unarchive") : t("ארכב", "Archive")}</Button>
            <Button size="sm" variant="secondary" onClick={() => setAgentsOpen(true)} data-testid="campaign-access-open">{t("למי הקמפיין פתוח", "Who the campaign is open to")} ({list.agents.length || t("כולם", "All")})</Button>
            <Button size="sm" variant="secondary" onClick={() => setLimitOpen(true)} data-testid="campaign-limit-open">{t("מכסת ניסיונות ללא מענה", "Unanswered attempts limit")} ({list.unansweredLimit === null || list.unansweredLimit === undefined ? t("לפי העסק", "Business default") : list.unansweredLimit || t("כבוי", "Off")})</Button>
            <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>{t("+ הוסף לידים מסינון", "+ Add leads from filter")}</Button>
            <Button size="sm" variant={list.isActive ? "danger" : "good"} onClick={toggleActive}>{list.isActive ? t("השבת רשימה", "Deactivate list") : t("הפעל רשימה", "Activate list")}</Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted">
        {t("לא זמינים עכשיו: ממתינים לניסיון חוזר/חלון", "Not available now: waiting for retry/window")} <b className="text-text tabular">{s.unavailable.notDueYet}</b> · {t("בטיפול", "In progress")} <b className="text-text tabular">{s.unavailable.inProgress}</b> · {t("מוצו", "Exhausted")} <b className="text-text tabular">{s.unavailable.exhausted}</b> · {t("הושלמו", "Completed")} <b className="text-text tabular">{s.unavailable.completed}</b> · DNC <b className="text-text tabular">{s.unavailable.dnc}</b> · {t("הוסרו", "Removed")} <b className="text-text tabular">{s.unavailable.removed}</b>
        {s.unavailable.outsideDialWindow && <Badge tone="warn" className="ms-2">{t("מחוץ לחלון החיוג", "Outside dial window")}</Badge>}
        {s.unavailable.listPaused && <Badge tone="bad" className="ms-2">{t("הרשימה מושהית", "List paused")}</Badge>}
      </p>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        <Stat label={t("בתור עכשיו", "In queue now")} value={s.dueNow} tone="good" />
        <Stat label={t("ממתינים", "Pending")} value={s.byStatus.pending ?? 0} />
        <Stat label={t("חזרות", "Callbacks")} value={s.byStatus.callback ?? 0} tone="warn" />
        <Stat label={t("הושלמו", "Completed")} value={s.byStatus.completed ?? 0} />
        <Stat label={t("מוצו", "Exhausted")} value={s.byStatus.exhausted ?? 0} />
        <Stat label={t("DNC / הוסרו", "DNC / Removed")} value={(s.byStatus.dnc ?? 0) + (s.byStatus.removed ?? 0)} tone="bad" />
      </div>

      <div className="flex gap-1 border-b border-line" role="tablist">
        <button role="tab" aria-selected={view === "leads"} onClick={() => setView("leads")} className={`h-9 px-3 text-sm border-b-2 -mb-px ${view === "leads" ? "border-accent font-medium" : "border-transparent text-muted"}`} data-testid="list-view-leads">{t("לידים וחייגן", "Leads & dialer")}</button>
        <button role="tab" aria-selected={view === "queue"} onClick={() => setView("queue")} className={`h-9 px-3 text-sm border-b-2 -mb-px ${view === "queue" ? "border-accent font-medium" : "border-transparent text-muted"}`} data-testid="list-view-queue">{t("תור החיוג", "Dial queue")} ({total})</button>
      </div>
      {view === "leads" && <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}><LeadsWorkspace listId={id} listName={list.name} /></Suspense>}
      {view === "queue" && <>
      <div className="flex flex-wrap gap-2 items-center">
        <Input placeholder={t("חיפוש", "Search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-56" />
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t("כל הסטטוסים", "All statuses")}</option>
          {Object.entries(LEAD_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {isManager && sel.size > 0 && (
          <div className="flex gap-2 ms-auto">
            <span className="text-xs text-muted self-center">{t(`${sel.size} נבחרו`, `${sel.size} selected`)}</span>
            <Button size="sm" variant="secondary" onClick={() => bulk("requeue")}>{t("החזר לתור", "Requeue")}</Button>
            <Button size="sm" variant="danger" onClick={() => bulk("remove")}>{t("הסר", "Remove")}</Button>
          </div>
        )}
      </div>

      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted bg-white/3">
            <tr>
              {isManager && <th className="px-3 w-8"><input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>}
              <th className="text-start px-3 h-9 font-medium">{t("שם", "Name")}</th><th className="text-start px-3 font-medium">{t("טלפון", "Phone")}</th><th className="text-start px-3 font-medium">{t("מקור", "Source")}</th><th className="text-start px-3 font-medium">{t("סטטוס", "Status")}</th><th className="text-start px-3 font-medium">{t("ניסיונות", "Attempts")}</th><th className="text-start px-3 font-medium">{t("תוצאה אחרונה", "Last outcome")}</th><th className="text-start px-3 font-medium">{t("ניסיון אחרון", "Last attempt")}</th><th className="text-start px-3 font-medium">{t("ניסיון הבא", "Next attempt")}</th>{isManager && <th></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-white/3">
                {isManager && <td className="px-3"><input type="checkbox" checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSel(n); }} /></td>}
                <td className="px-3 h-10"><a href={`/contacts/${r.contact.id}`} className="hover:underline">{r.contact.fullName}</a></td>
                <td className="px-3"><Phone value={formatPhone(r.contact.phoneE164)} /></td>
                <td className="px-3 text-muted">{r.contact.source ?? "—"}</td>
                <td className="px-3"><Badge tone={r.status === "in_call" ? "good" : r.status === "dnc" || r.status === "exhausted" ? "bad" : r.status === "callback" ? "warn" : "neutral"}>{LEAD_STATUS_LABEL[r.status]}</Badge>{r.lockedBy && <span className="text-[11px] text-muted ms-1">{r.lockedBy.fullName}</span>}</td>
                <td className="px-3 tabular">{r.attempts}</td>
                <td className="px-3 text-muted">{OUTCOMES.find((o) => o.key === r.lastOutcome)?.label ?? (r.lastSkipReason ? t(`דילוג: ${r.lastSkipReason}`, `Skipped: ${r.lastSkipReason}`) : "—")}</td>
                <td className="px-3 text-muted text-xs tabular">{formatDateTime(r.lastAttemptAt)}</td>
                <td className="px-3 text-muted text-xs tabular">{formatDateTime(r.nextAttemptAt)}</td>
                {isManager && <td className="px-3 text-end">{r.status !== "in_call" && <button onClick={() => transfer(r.id)} className="text-xs text-accent underline hover:underline">{t("העבר", "Transfer")}</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-3 h-10 border-t border-line text-xs text-muted">
          <span className="tabular">{total} {t("לידים", "leads")}</span>
          <div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-30">‹ {t("הקודם", "Previous")}</button><button disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-30">{t("הבא", "Next")} ›</button></div>
        </div>
      </div>

      </>}

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t("הוספת לידים מסינון CRM", "Add leads from CRM filter")} footer={<><Button variant="ghost" onClick={() => setAddOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={addFromFilter}>{t("הוסף", "Add")}</Button></>}>
        <div className="space-y-2">
          <Input label={t("מקור", "Source")} value={addFilter.source} onChange={(e) => setAddFilter({ ...addFilter, source: e.target.value })} />
          <Input label={t("עיר", "City")} value={addFilter.city} onChange={(e) => setAddFilter({ ...addFilter, city: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={addFilter.neverCalled} onChange={(e) => setAddFilter({ ...addFilter, neverCalled: e.target.checked })} /> {t("רק אנשי קשר שטרם חויגו", "Only contacts never dialed")}</label>
          <p className="text-xs text-muted">{t("אנשי קשר שכבר ברשימה, ומספרים חסומים, לא יתווספו.", "Contacts already in the list, and blocked numbers, won't be added.")}</p>
        </div>
      </Modal>
      <Modal open={agentsOpen} onClose={() => setAgentsOpen(false)} title={t("למי הקמפיין פתוח", "Who the campaign is open to")} footer={<><Button variant="ghost" onClick={() => setAgentsOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={saveAgents} disabled={agentMode === "selected" && !agentIds.length} data-testid="campaign-access-save">{t("שמור", "Save")}</Button></>}>
        <div className="space-y-2 text-sm" data-testid="campaign-access">
          <label className="flex items-center gap-2"><input type="radio" name="access" checked={agentMode === "all"} onChange={() => setAgentMode("all")} data-testid="campaign-access-all" /> {t("כל הנציגים בעסק", "All agents in the business")}</label>
          <label className="flex items-center gap-2"><input type="radio" name="access" checked={agentMode === "selected"} onChange={() => setAgentMode("selected")} data-testid="campaign-access-selected" /> {t("נציגים מסוימים", "Specific agents")}</label>
          {agentMode === "selected" && <div className="flex flex-wrap gap-1.5 ps-6">
            {users.filter((u) => u.role !== "owner").map((u) => (
              <button key={u.id} type="button" data-testid={`campaign-agent-${u.id}`} aria-pressed={agentIds.includes(u.id)} onClick={() => setAgentIds(agentIds.includes(u.id) ? agentIds.filter((x) => x !== u.id) : [...agentIds, u.id])} className={`h-8 px-3 rounded-md text-xs ${agentIds.includes(u.id) ? "bg-accent text-white" : "bg-white/6 text-muted"}`}>{u.fullName}</button>
            ))}
          </div>}
          {agentMode === "selected" && !agentIds.length && <p className="text-xs text-bad">{t("יש לבחור לפחות נציג אחד.", "Select at least one agent.")}</p>}
          <p className="text-xs text-muted">{t("ההרשאה נאכפת בשרת בהצגת הקמפיינים, בספירת הלידים, בכניסה לקמפיין ובהפעלת החייגן. היא אינה נותנת גישה ללידים פרטיים של נציגים אחרים.", "Access is enforced on the server when listing campaigns, counting leads, entering a campaign and starting the dialer. It doesn't grant access to other agents' private leads.")}</p>
        </div>
      </Modal>
      <Modal open={limitOpen} onClose={() => setLimitOpen(false)} title={t("מכסת ניסיונות ללא מענה בקמפיין", "Campaign unanswered attempts limit")} footer={<><Button variant="ghost" onClick={() => setLimitOpen(false)}>{t("סגור", "Close")}</Button><Button data-testid="campaign-limit-save" onClick={async () => { await patchList({ unansweredLimit: limitDraft === "" ? null : Number(limitDraft) }, t("המכסה נשמרה", "Limit saved")); setLimitOpen(false); }}>{t("שמור", "Save")}</Button></>}>
        <div className="space-y-3 text-sm">
          <Select label={t("מספר ניסיונות חיוג ללא מענה לפני העברה ללא רלוונטי", "Unanswered dial attempts before moving to Not relevant")} value={limitDraft} onChange={(e) => setLimitDraft(e.target.value)} data-testid="campaign-limit">
            <option value="">{t("לפי הגדרת העסק", "Per business setting")}</option><option value="0">{t("כבוי בקמפיין הזה", "Off for this campaign")}</option>
            {Array.from({ length: 30 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </Select>
          <p className="text-xs text-muted">{t("נציג שהגדיר מכסה אישית – המכסה האישית קובעת. נספרים רק חיוגים שיצאו בפועל.", "If an agent set a personal limit – the personal limit applies. Only dials actually placed are counted.")}</p>
          <ExhaustionPreview listId={id} />
        </div>
      </Modal>
    </div>
  );
}
