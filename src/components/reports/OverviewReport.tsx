"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Badge, Panel, Phone, Spinner, Stat, EmptyState } from "@/components/ui";
import { formatDateTime, formatDuration, formatPhone, relativeTime } from "@/lib/client/format";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import { useT } from "@/components/i18n/LangProvider";

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

const moneyFmt = (locale: string) => new Intl.NumberFormat(locale, { style: "currency", currency: "ILS", maximumFractionDigits: 0 });
const EVENT_LABEL: Record<string, [string, string]> = { "lead.created": ["ליד חדש", "New lead"], "lead.status_changed": ["שינוי סטטוס ליד", "Lead status changed"], "deal.created": ["עסקה נוצרה", "Deal created"], "deal.won": ["עסקה נסגרה", "Deal won"], "call.ended": ["שיחה הסתיימה", "Call ended"], "call.outcome_saved": ["תוצאת שיחה", "Call outcome"], "message.received": ["הודעה נכנסת", "Inbound message"], "message.sent": ["הודעה יוצאת", "Outbound message"], "contact.suppressed": ["הסרה מדיוור", "Unsubscribed"], "contact.resubscribed": ["הסכמה מחודשת", "Resubscribed"], "task.created": ["משימה נוצרה", "Task created"] };

/** Business-wide overview (formerly the home dashboard) – now the first tab of the managers' reports screen. */
export function OverviewReport() {
  const t = useT(); const money = moneyFmt(t.lang === "en" ? "en-GB" : "he-IL");
  const statuses = useLeadStatuses();
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<Dash>("/api/dashboard").then((r) => alive && setD(r)).catch((e) => alive && setErr((e as Error).message));
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  if (err) return <div className="p-6 text-bad">{err}</div>;
  if (!d) return <div className="flex justify-center p-10"><Spinner /></div>;
  const now = new Date(d.now).getTime();
  return (
    <div className="p-5 space-y-5 max-w-7xl">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{t("סקירה", "Overview")}</h1>
        {d.plan && <Badge tone="accent">{d.plan}</Badge>}
        <span className="text-xs text-muted ms-auto">{t("מתעדכן כל 30 שניות", "Refreshes every 30 seconds")}</span>
      </div>

      <section>
        <p className="text-xs text-muted mb-2">CRM</p>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          <Stat label={t("אנשי קשר", "Contacts")} value={d.crm.contacts} sub={t(`+${d.crm.contactsWeek} השבוע`, `+${d.crm.contactsWeek} this week`)} />
          <Stat label={t("לידים פתוחים", "Open leads")} value={d.crm.leadsOpen} sub={t(`${d.crm.leadsWeek} חדשים השבוע`, `${d.crm.leadsWeek} new this week`)} />
          <Stat label={t("עסקאות פתוחות", "Open deals")} value={d.crm.dealsOpen.count} sub={money.format(d.crm.dealsOpen.amount)} />
          <Stat label={t("נסגרו החודש", "Won this month")} value={d.crm.dealsWonMonth.count} sub={money.format(d.crm.dealsWonMonth.amount)} tone="good" />
          <Stat label={t("משימות באיחור", "Overdue tasks")} value={d.crm.tasksOverdue} sub={t(`${d.crm.tasksToday} להיום`, `${d.crm.tasksToday} due today`)} tone={d.crm.tasksOverdue ? "bad" : undefined} />
          <Stat label={t("הסרות פעילות", "Active unsubscribes")} value={d.crm.suppressed} sub={t("חסימות דיוור", "Marketing blocks")} />
        </div>
      </section>

      {d.messaging && (
        <section>
          <p className="text-xs text-muted mb-2">{t("דיוור (WhatsApp)", "Messaging (WhatsApp)")}</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label={t("שיחות פתוחות", "Open conversations")} value={d.messaging.openConversations} />
            <Stat label={t("לא נקראו", "Unread")} value={d.messaging.unread} tone={d.messaging.unread ? "warn" : undefined} />
            <Stat label={t("הודעות היום", "Messages today")} value={d.messaging.messagesToday} sub={t(`${d.messaging.inboundToday} נכנסות`, `${d.messaging.inboundToday} inbound`)} />
            <Stat label={t("קמפיינים פעילים", "Active broadcasts")} value={d.messaging.campaignsRunning} />
            <Link href="/inbox" className="bg-panel-2 border border-line rounded-lg px-3 py-2 text-sm flex items-center justify-center hover:border-accent">{t("לתיבת ההודעות →", "To inbox →")}</Link>
          </div>
        </section>
      )}

      {d.telephony && (
        <section>
          <p className="text-xs text-muted mb-2">{t("טלפוניה", "Telephony")}</p>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label={t("שיחות היום", "Calls today")} value={d.telephony.callsToday} sub={t(`${d.telephony.answeredToday} נענו`, `${d.telephony.answeredToday} answered`)} />
            <Stat label={t("זמן שיחה", "Talk time")} value={formatDuration(d.telephony.talkSeconds)} />
            <Stat label={t("שיחות חיות", "Live calls")} value={d.telephony.liveCalls} tone={d.telephony.liveCalls ? "good" : undefined} />
            <Stat label={t("נציגים מחוברים", "Agents online")} value={d.telephony.agentsOnline} />
            <Stat label={t("חזרות שהגיע מועדן", "Callbacks due")} value={d.telephony.callbacksDue} tone={d.telephony.callbacksDue ? "warn" : undefined} />
            <Link href="/leads" className="bg-panel-2 border border-line rounded-lg px-3 py-2 text-sm flex items-center justify-center hover:border-accent">{t("לחייגן →", "To dialer →")}</Link>
          </div>
        </section>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <Panel title={t("לידים אחרונים", "Recent leads")} actions={<Link href="/leads" className="text-xs text-accent underline hover:underline">{t("הכול", "All")}</Link>} bodyClassName="p-0">
          {d.recentLeads.length === 0 ? <EmptyState title={t("אין לידים עדיין", "No leads yet")} hint={t("לידים נוצרים מאנשי קשר, מייבוא או אוטומטית מהודעות ושיחות", "Leads are created from contacts, imports, or automatically from messages and calls")} /> : (
            <ul className="divide-y divide-line">
              {d.recentLeads.map((l) => (
                <li key={l.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <Link href={`/contacts/${l.contact.id}`} className="font-medium hover:underline">{l.contact.fullName}</Link>
                    <p className="text-xs text-muted truncate">{l.title ?? l.source ?? "—"} · {l.owner?.fullName ?? t("ללא נציג", "No agent")} · {relativeTime(l.createdAt, now)}</p>
                  </div>
                  <Badge tone={l.status === "new" ? "info" : l.status === "qualified" ? "good" : "neutral"}>{statuses.label(l.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t("המשימות הקרובות", "Upcoming tasks")} actions={<Link href="/leads?tasks=1" className="text-xs text-accent underline hover:underline">{t("הכול", "All")}</Link>} bodyClassName="p-0">
          {d.myTasks.length === 0 ? <EmptyState title={t("אין משימות פתוחות", "No open tasks")} /> : (
            <ul className="divide-y divide-line">
              {d.myTasks.map((task) => {
                const overdue = new Date(task.dueAt).getTime() < now;
                return (
                  <li key={task.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <Link href={`/contacts/${task.contact.id}`} className="font-medium hover:underline">{task.contact.fullName}</Link>
                      <p className="text-xs text-muted truncate">{task.title ?? (task.type === "callback" ? t("חזרה טלפונית", "Callback") : t("מעקב", "Follow-up"))} · {task.user.fullName}</p>
                    </div>
                    <span className={overdue ? "text-bad text-xs tabular" : "text-muted text-xs tabular"}>{formatDateTime(task.dueAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title={t("אירועים אחרונים", "Recent events")} bodyClassName="p-0">
          {d.recentEvents.length === 0 ? <EmptyState title={t("אין אירועים", "No events")} /> : (
            <ul className="divide-y divide-line">
              {d.recentEvents.map((e) => (
                <li key={e.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{EVENT_LABEL[e.type] ? t(EVENT_LABEL[e.type][0], EVENT_LABEL[e.type][1]) : e.type}</p>
                    <p className="text-xs text-muted truncate">{e.contact ? <Link href={`/contacts/${e.contact.id}`} className="hover:underline">{e.contact.fullName}</Link> : "—"} · {relativeTime(e.occurredAt, now)}</p>
                  </div>
                  <Badge tone={e.status === "done" ? "good" : e.status === "failed" ? "bad" : "neutral"}>{e.status === "done" ? t("טופל", "Done") : e.status === "failed" ? t("נכשל", "Failed") : t("ממתין", "Pending")}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <p className="text-[11px] text-muted"><Phone value={formatPhone("+972501234567")} className="hidden" />{t("ערוצי SMS ואימייל טרם חוברו לספק ומוצגים כלא פעילים. WhatsApp פעיל דרך Meta Cloud API או במצב הדגמה.", "SMS and email channels are not yet connected to a provider and are shown as inactive. WhatsApp is active via Meta Cloud API or in demo mode.")}</p>
    </div>
  );
}
