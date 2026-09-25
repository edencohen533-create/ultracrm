"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Badge, Panel, Phone, Spinner, Stat, EmptyState } from "@/components/ui";
import { formatDateTime, formatDuration, formatPhone, relativeTime } from "@/lib/client/format";
import { LEAD_STATUS_LABEL } from "@/lib/crm/labels";

interface Dash {
  modules: { crm: boolean; messaging: boolean; telephony: boolean };
  plan: string | null;
  crm: { contacts: number; contactsWeek: number; leadsOpen: number; leadsWeek: number; dealsOpen: { count: number; amount: number }; dealsWonMonth: { count: number; amount: number }; tasksOverdue: number; tasksToday: number; suppressed: number };
  messaging: { openConversations: number; unread: number; messagesToday: number; inboundToday: number; campaignsRunning: number } | null;
  telephony: { callsToday: number; answeredToday: number; talkSeconds: number; liveCalls: number; agentsOnline: number; callbacksDue: number } | null;
  recentLeads: Array<{ id: string; status: string; title: string | null; source: string | null; createdAt: string; contact: { id: string; fullName: string; phoneE164: string }; owner: { fullName: string } | null }>;
  myTasks: Array<{ id: string; title: string | null; type: string; dueAt: string; contact: { id: string; fullName: string; phoneE164: string }; user: { fullName: string } }>;
  recentEvents: Array<{ id: string; type: string; occurredAt: string; status: string; source: string; contact: { id: string; fullName: string } | null }>;
  now: string;
}

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 });
const EVENT_LABEL: Record<string, string> = { "lead.created": "ליד חדש", "lead.status_changed": "שינוי סטטוס ליד", "deal.created": "עסקה נוצרה", "deal.won": "עסקה נסגרה", "call.ended": "שיחה הסתיימה", "call.outcome_saved": "תוצאת שיחה", "message.received": "הודעה נכנסת", "message.sent": "הודעה יוצאת", "contact.suppressed": "הסרה מדיוור", "contact.resubscribed": "הסכמה מחודשת", "task.created": "משימה נוצרה" };

/** Business-wide overview (formerly the home dashboard) – now the first tab of the managers' reports screen. */
export function OverviewReport() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<Dash>("/api/dashboard").then((r) => alive && setD(r)).catch((e) => alive && setErr((e as Error).message));
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (err) return <div className="p-6 text-bad">{err}</div>;
  if (!d) return <div className="flex justify-center p-10"><Spinner /></div>;
  const now = new Date(d.now).getTime();
  return (
    <div className="p-5 space-y-5 max-w-7xl">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">סקירה</h1>
        {d.plan && <Badge tone="accent">{d.plan}</Badge>}
        <span className="text-xs text-muted ms-auto">מתעדכן כל 30 שניות</span>
      </div>

      <section>
        <p className="text-xs text-muted mb-2">CRM</p>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          <Stat label="אנשי קשר" value={d.crm.contacts} sub={`+${d.crm.contactsWeek} השבוע`} />
          <Stat label="לידים פתוחים" value={d.crm.leadsOpen} sub={`${d.crm.leadsWeek} חדשים השבוע`} />
          <Stat label="עסקאות פתוחות" value={d.crm.dealsOpen.count} sub={money.format(d.crm.dealsOpen.amount)} />
          <Stat label="נסגרו החודש" value={d.crm.dealsWonMonth.count} sub={money.format(d.crm.dealsWonMonth.amount)} tone="good" />
          <Stat label="משימות באיחור" value={d.crm.tasksOverdue} sub={`${d.crm.tasksToday} להיום`} tone={d.crm.tasksOverdue ? "bad" : undefined} />
          <Stat label="הסרות פעילות" value={d.crm.suppressed} sub="חסימות דיוור" />
        </div>
      </section>

      {d.messaging && (
        <section>
          <p className="text-xs text-muted mb-2">דיוור (WhatsApp)</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="שיחות פתוחות" value={d.messaging.openConversations} />
            <Stat label="לא נקראו" value={d.messaging.unread} tone={d.messaging.unread ? "warn" : undefined} />
            <Stat label="הודעות היום" value={d.messaging.messagesToday} sub={`${d.messaging.inboundToday} נכנסות`} />
            <Stat label="קמפיינים פעילים" value={d.messaging.campaignsRunning} />
            <Link href="/inbox" className="bg-panel-2 border border-line rounded-lg px-3 py-2 text-sm flex items-center justify-center hover:border-accent">לתיבת ההודעות →</Link>
          </div>
        </section>
      )}

      {d.telephony && (
        <section>
          <p className="text-xs text-muted mb-2">טלפוניה</p>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="שיחות היום" value={d.telephony.callsToday} sub={`${d.telephony.answeredToday} נענו`} />
            <Stat label="זמן שיחה" value={formatDuration(d.telephony.talkSeconds)} />
            <Stat label="שיחות חיות" value={d.telephony.liveCalls} tone={d.telephony.liveCalls ? "good" : undefined} />
            <Stat label="נציגים מחוברים" value={d.telephony.agentsOnline} />
            <Stat label="חזרות שהגיע מועדן" value={d.telephony.callbacksDue} tone={d.telephony.callbacksDue ? "warn" : undefined} />
            <Link href="/leads" className="bg-panel-2 border border-line rounded-lg px-3 py-2 text-sm flex items-center justify-center hover:border-accent">לחייגן →</Link>
          </div>
        </section>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <Panel title="לידים אחרונים" actions={<Link href="/leads" className="text-xs text-accent underline hover:underline">הכול</Link>} bodyClassName="p-0">
          {d.recentLeads.length === 0 ? <EmptyState title="אין לידים עדיין" hint="לידים נוצרים מאנשי קשר, מייבוא או אוטומטית מהודעות ושיחות" /> : (
            <ul className="divide-y divide-line">
              {d.recentLeads.map((l) => (
                <li key={l.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <Link href={`/contacts/${l.contact.id}`} className="font-medium hover:underline">{l.contact.fullName}</Link>
                    <p className="text-xs text-muted truncate">{l.title ?? l.source ?? "—"} · {l.owner?.fullName ?? "ללא נציג"} · {relativeTime(l.createdAt, now)}</p>
                  </div>
                  <Badge tone={l.status === "new" ? "info" : l.status === "qualified" ? "good" : "neutral"}>{LEAD_STATUS_LABEL[l.status as keyof typeof LEAD_STATUS_LABEL] ?? l.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="המשימות הקרובות" actions={<Link href="/tasks" className="text-xs text-accent underline hover:underline">הכול</Link>} bodyClassName="p-0">
          {d.myTasks.length === 0 ? <EmptyState title="אין משימות פתוחות" /> : (
            <ul className="divide-y divide-line">
              {d.myTasks.map((t) => {
                const overdue = new Date(t.dueAt).getTime() < now;
                return (
                  <li key={t.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <Link href={`/contacts/${t.contact.id}`} className="font-medium hover:underline">{t.contact.fullName}</Link>
                      <p className="text-xs text-muted truncate">{t.title ?? (t.type === "callback" ? "חזרה טלפונית" : "מעקב")} · {t.user.fullName}</p>
                    </div>
                    <span className={overdue ? "text-bad text-xs tabular" : "text-muted text-xs tabular"}>{formatDateTime(t.dueAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="אירועים אחרונים" bodyClassName="p-0">
          {d.recentEvents.length === 0 ? <EmptyState title="אין אירועים" /> : (
            <ul className="divide-y divide-line">
              {d.recentEvents.map((e) => (
                <li key={e.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</p>
                    <p className="text-xs text-muted truncate">{e.contact ? <Link href={`/contacts/${e.contact.id}`} className="hover:underline">{e.contact.fullName}</Link> : "—"} · {relativeTime(e.occurredAt, now)}</p>
                  </div>
                  <Badge tone={e.status === "done" ? "good" : e.status === "failed" ? "bad" : "neutral"}>{e.status === "done" ? "טופל" : e.status === "failed" ? "נכשל" : "ממתין"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <p className="text-[11px] text-muted"><Phone value={formatPhone("+972501234567")} className="hidden" />ערוצי SMS ואימייל טרם חוברו לספק ומוצגים כלא פעילים. WhatsApp פעיל דרך Meta Cloud API או במצב הדגמה.</p>
    </div>
  );
}
