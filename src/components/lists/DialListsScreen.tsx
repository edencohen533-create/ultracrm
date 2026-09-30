"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Modal, Select, Spinner, Textarea } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { ListAdminActions } from "@/components/lists/ListAdminActions";
import { HelpTip } from "@/components/ai/HelpTip";
import { BusinessDialingNote, HelpLabel, listHelp, type BusinessDialState } from "@/components/lists/ListHelp";

interface ListRow {
  id: string; name: string; description: string | null; isActive: boolean; priority: number; audience?: string; maxAttempts: number | null; retryIntervalMinutes: number | null;
  agents: Array<{ user: { id: string; fullName: string } }>;
  script: { id: string; title: string } | null;
  stats: { byStatus: Record<string, number>; dueNow: number; total: number } & BusinessDialState;
}

/** "חייגן → רשימות חיוג": the dial lists (create, activate / deactivate, agents, move leads, delete, start the dialer). */
export function DialListsScreen() {
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const t = useT();
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; role: string }>>([]);
  const [scripts, setScripts] = useState<Array<{ id: string; title: string }>>([]);
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [form, setForm] = useState({ name: "", description: "", priority: 5, maxAttempts: "", unansweredLimit: "", access: "all" as "all" | "selected", retryIntervalMinutes: "", scriptId: "", phoneNumberId: "", isDynamic: false, agentIds: [] as string[], filterSource: "", filterNeverCalled: false, audience: "new_prospects" as "new_prospects" | "existing_customers" | "all" });
  const [numbers, setNumbers] = useState<Array<{ id: string; e164: string; label: string | null }>>([]);

  const load = useCallback(async () => {
    try {
      setLists(await api.get<ListRow[]>("/api/lists"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
    api.get<{ user: { role: string } }>("/api/auth/me").then((m) => setMe(m.user)).catch(() => undefined);
    api.get<{ items: Array<{ id: string; fullName: string; role: string }> }>("/api/users").then((u) => setUsers(u.items)).catch(() => undefined);
    api.get<Array<{ id: string; title: string }>>("/api/scripts").then(setScripts).catch(() => undefined);
    api.get<typeof numbers>("/api/phone-numbers").then(setNumbers).catch(() => undefined);
  }, [load]);

  const [creating, setCreating] = useState(false);
  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      const r = await api.post<{ added: number }>("/api/lists", {
        name: form.name, description: form.description || undefined, priority: form.priority,
        maxAttempts: form.maxAttempts ? Number(form.maxAttempts) : null, unansweredLimit: form.unansweredLimit === "" ? null : Number(form.unansweredLimit), retryIntervalMinutes: form.retryIntervalMinutes ? Number(form.retryIntervalMinutes) : null,
        scriptId: form.scriptId || null, phoneNumberId: form.phoneNumberId || null, isDynamic: form.isDynamic, audience: form.audience, agentIds: form.access === "all" ? [] : form.agentIds,
        filter: form.filterSource || form.filterNeverCalled ? { source: form.filterSource || undefined, neverCalled: form.filterNeverCalled ? "true" : undefined } : undefined,
      });
      toast.success(t(`רשימת החיוג נוצרה${r.added ? ` עם ${r.added} לידים` : ""}`, `List created${r.added ? ` with ${r.added} leads` : ""}`));
      setOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setCreating(false); }
  }

  const isManager = me?.role !== "agent";
  const help = listHelp(t);

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{t("רשימות חיוג", "Dial lists")}</h1>
        {isManager && <Button size="sm" className="ms-auto" onClick={() => setOpen(true)}>{t("+ רשימת חיוג חדשה", "+ New dial list")}</Button>}
      </div>
      {isManager && <QueueAlerts />}
      <BusinessDialingNote stats={lists?.[0]?.stats} isManager={isManager} />
      {!lists ? <div className="flex justify-center p-10"><Spinner /></div> : lists.length === 0 ? <EmptyState title={t("אין רשימות חיוג", "No dial lists")} hint={t("צור רשימת חיוג מסינון אנשי קשר או ידנית", "Create a dial list from a contact filter or manually")} /> : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {lists.map((l) => (
            <div key={l.id} className={`bg-panel border border-line rounded-xl p-4 hover:border-accent/50 transition-colors ${l.isActive ? "" : "opacity-80"}`} data-testid={`list-card-${l.id}`}>
            <Link href={`/calling/lists/${l.id}`} className="block">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold truncate">{l.name}</h2>
                {!isManager && <Badge tone={l.isActive ? "good" : "neutral"}>{l.isActive ? t("פעילה", "Active") : t("לא פעילה", "Inactive")}</Badge>}
              </div>
              {l.description && <p className="text-xs text-muted mt-1 line-clamp-2">{l.description}</p>}
              <div className="grid grid-cols-4 gap-2 mt-3 text-center">
                {([[t("בתור", "In queue"), l.stats.dueNow, help.queue, "queue"], [t("ממתינים", "Pending"), l.stats.byStatus.pending ?? 0, help.pending, "pending"], [t("הושלמו", "Completed"), l.stats.byStatus.completed ?? 0, null, "completed"], [t("סה״כ", "Total"), l.stats.total, null, "total"]] as Array<[string, number, string | null, string]>).map(([k, v, h, key]) => (
                  <div key={key} className="bg-white/4 rounded-md py-1.5"><p className="text-base font-semibold tabular">{v}</p><p className="flex items-center justify-center text-[10px] text-muted">{k}{h && <HelpTip label={k} hover testId={`list-help-${key}-${l.id}`}>{h}</HelpTip>}</p></div>
                ))}
              </div>
              <p className="text-[11px] text-muted mt-3 truncate">{t("נציגים:", "Agents:")} {l.agents.length ? l.agents.map((a) => a.user.fullName).join(", ") : t("כולם", "All")} · {t("עדיפות", "Priority")} {l.priority} · {l.audience === "existing_customers" ? t("לקוחות קיימים", "Existing customers") : l.audience === "all" ? t("כולם", "Everyone") : t("גיוס", "Acquisition")}</p>
            </Link>
            {isManager && <ListAdminActions list={l} lists={lists} onChanged={load} />}
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t("רשימת חיוג חדשה", "New dial list")} width="max-w-2xl" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t("ביטול", "Cancel")}</Button><Button onClick={create} loading={creating} data-testid="list-create" disabled={creating || !form.name.trim() || (form.access === "selected" && !form.agentIds.length)}>{t("צור", "Create")}</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Input label={t("שם", "Name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="col-span-2" />
          <Textarea label={t("תיאור", "Description")} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="col-span-2" />
          <label className="block"><HelpLabel text={t("עדיפות (1–10)", "Priority (1–10)")} help={help.priority} testId="list-help-priority" />
            <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} data-testid="list-priority">
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}{n === 1 ? t(" – הנמוכה", " – lowest") : n === 10 ? t(" – הגבוהה", " – highest") : ""}</option>)}
            </Select></label>
          <label className="block"><HelpLabel text={t("מטרת רשימת החיוג", "Dial list purpose")} help={help.audience} testId="list-help-audience" /><Select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as typeof form.audience })} data-testid="list-audience">
            <option value="new_prospects">{t("גיוס לקוחות חדשים", "New customer acquisition")}</option>
            <option value="existing_customers">{t("חידושים / מכירה נוספת ללקוחות קיימים", "Renewals / upsell to existing customers")}</option>
            <option value="all">{t("כולם (לידים ולקוחות)", "Everyone (leads and customers)")}</option>
          </Select></label>
          <label className="block"><HelpLabel text={t("תסריט", "Script")} help={help.script} /><Select value={form.scriptId} onChange={(e) => setForm({ ...form, scriptId: e.target.value })}>
            <option value="">{t("ברירת מחדל של העסק", "Business default")}</option>
            {scripts.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </Select></label>
          <label className="block"><HelpLabel text={t("מספר יוצא לרשימה", "Outbound number for the list")} help={help.number} /><Select value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })}>
            <option value="">{t("ברירת מחדל של העסק", "Business default")}</option>
            {numbers.map((n) => <option key={n.id} value={n.id}>{n.e164} {n.label ? `· ${n.label}` : ""}</option>)}
          </Select></label>
          <label className="block"><HelpLabel text={t("מקס׳ ניסיונות (ריק = הגדרת עסק)", "Max attempts (empty = business setting)")} help={help.maxAttempts} testId="list-help-max" /><Input type="number" min={1} max={20} value={form.maxAttempts} onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })} /></label>
          <label className="block"><HelpLabel text={t("ניסיונות ללא מענה לפני ״לא רלוונטי״", "Unanswered attempts before \"Not relevant\"")} help={help.unanswered} /><Select value={form.unansweredLimit} onChange={(e) => setForm({ ...form, unansweredLimit: e.target.value })}>
            <option value="">{t("לפי הגדרת העסק", "Per business setting")}</option><option value="0">{t("כבוי", "Off")}</option>
            {Array.from({ length: 30 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </Select></label>
          <label className="block"><HelpLabel text={t("מרווח בין ניסיונות (דקות)", "Interval between attempts (minutes)")} help={help.retry} /><Input type="number" min={1} value={form.retryIntervalMinutes} onChange={(e) => setForm({ ...form, retryIntervalMinutes: e.target.value })} /></label>
          <p className="col-span-2 rounded-lg bg-bg px-3 py-2 text-xs text-muted" data-testid="list-hours-note">{t("אין לרשימה שעות משלה – אפשר להפעיל אותה בכל עת. החיוג בפועל כפוף לשעות החיוג ולכללי החסימה של העסק (הגדרות ← חייגן).", "The list has no hours of its own – it can be activated at any time. Actual dialing follows the business's dialing hours and blocking rules (settings → dialer).")}</p>
          <div className="col-span-2">
            <HelpLabel text={t("למי רשימת החיוג פתוחה", "Who the dial list is open to")} help={help.access} />
            <div className="flex gap-4 text-sm mb-2"><label className="flex items-center gap-1"><input type="radio" checked={form.access === "all"} onChange={() => setForm({ ...form, access: "all" })} /> {t("כל הנציגים בעסק", "All agents in the business")}</label><label className="flex items-center gap-1"><input type="radio" checked={form.access === "selected"} onChange={() => setForm({ ...form, access: "selected" })} /> {t("נציגים מסוימים", "Specific agents")}</label></div>
            {form.access === "selected" && <div className="flex flex-wrap gap-1.5">
              {users.filter((u) => u.role === "agent" || u.role === "manager").map((u) => (
                <button key={u.id} type="button" onClick={() => setForm({ ...form, agentIds: form.agentIds.includes(u.id) ? form.agentIds.filter((x) => x !== u.id) : [...form.agentIds, u.id] })} className={`h-8 px-3 rounded-md text-xs ${form.agentIds.includes(u.id) ? "bg-accent text-white" : "bg-white/6 text-muted"}`}>{u.fullName}</button>
              ))}
            </div>}
          </div>
          <div className="col-span-2 border-t border-line pt-3">
            <HelpLabel text={t("מילוי ראשוני מ-CRM (אופציונלי)", "Initial fill from CRM (optional)")} help={help.fill} />
            <div className="flex gap-2 items-center">
              <Input placeholder={t("מקור (למשל facebook)", "Source (e.g. facebook)")} value={form.filterSource} onChange={(e) => setForm({ ...form, filterSource: e.target.value })} />
              <label className="flex items-center gap-2 text-xs whitespace-nowrap"><input type="checkbox" checked={form.filterNeverCalled} onChange={(e) => setForm({ ...form, filterNeverCalled: e.target.checked })} /> {t("רק שטרם חויגו", "Only never dialed")}</label>
            </div>
            <div className="mt-2 flex items-center gap-1"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.isDynamic} onChange={(e) => setForm({ ...form, isDynamic: e.target.checked })} /> {t("רשימה דינמית", "Dynamic list")}</label><HelpTip label={t("רשימה דינמית", "Dynamic list")} hover testId="list-help-dynamic">{help.dynamic}</HelpTip></div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface QueueAlert { id: string; agentId: string; agent: string; listId: string; list: string; state: string; exhaustedCount: number; nextAt: string | null; openedAt: string; closedAt: string | null }
/** Managers: agents who ran out of dialable leads (open first). The same event also reaches linked managers on WhatsApp. */
function QueueAlerts() {
  const [items, setItems] = useState<QueueAlert[]>([]);
  const t = useT();
  useEffect(() => { api.get<{ items: QueueAlert[] }>("/api/dialer/queue-alerts").then((r) => setItems(r.items)).catch(() => undefined); }, []);
  const open = items.filter((a) => !a.closedAt);
  if (!open.length) return null;
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 space-y-1" data-testid="queue-alerts">
      <p className="text-sm font-semibold">{t("נציגים ללא לידים זמינים", "Agents without available leads")}</p>
      {open.map((a) => <p key={a.id} className="text-sm" data-testid="queue-alert">{t("לנציג", "Agent")} <b>{a.agent}</b> {t("אין כרגע לידים זמינים לחיוג ברשימה", "currently has no leads available to dial in list")} <Link className="underline" href={`/calling/lists/${a.listId}`}>{a.list}</Link>. {t("מוצו:", "Exhausted:")} {a.exhaustedCount}. {a.nextAt ? t(`החיוג הבא צפוי ב-${new Date(a.nextAt).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}.`, `Next dial expected at ${new Date(a.nextAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}.`) : t("אין עבודה עתידית ברשימה.", "No future work in the list.")}</p>)}
    </div>
  );
}
