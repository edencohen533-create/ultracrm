"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Select, Spinner, Textarea, cx } from "@/components/ui";
import { ACCESS_STATUS_LABEL, DEPENDENCIES, MODULE_LABEL, MODULES, QUOTA_LABEL, QUOTA_METRICS, SOURCE_LABEL, type ModuleKey } from "@/lib/access/catalog";
import { useT } from "@/components/i18n/LangProvider";
import { StateBadge, UserAccessEditor, type AccessUserRow } from "./AccessMatrix";

interface BizRow { createdAt: string | null; owner: { fullName: string; email: string; isActive: boolean } | null; statusReason: string | null; id: string; name: string; isActive: boolean; accessStatus: string; accessUntil: string | null; billingStatus: string; planVersion: { id: string; version: number; name: string } | null; users: number; needsPackage: boolean; modules: Record<ModuleKey, { included: boolean; seats: number | null; sources: string[] }> }
interface Version { id: string; version: number; name: string; modules: Record<string, { included: boolean; seats: number | null }>; quotas: Record<string, number | null>; createdAt: string; businesses: number }
interface Plan { id: string; name: string; description: string | null; currentVersion: number; versions: Version[] }
interface Impact { modulesRemoved: ModuleKey[]; usersLosing: Record<string, Array<{ id: string; fullName: string }>>; seatOverflow: Record<string, { seats: number; holders: Array<{ id: string; fullName: string }> }>; campaigns: Array<{ id: string; name: string; channel: string; status: string }>; journeys: Array<{ id: string; name: string }>; inboxAutomations: number; serviceAgent: boolean; dialerSessions: number; dialLists: number }
type Target = { planVersionId?: string | null; revokeGrantId?: string; addGrant?: { module: ModuleKey; kind: string; seats: number | null; expiresAt: string | null } };
const fmt = (d: string | null, loc = "he-IL") => (d ? new Date(d).toLocaleDateString(loc) : "");

export function PlatformAdmin() {
  const t = useT();
  const [tab, setTab] = useState<"businesses" | "plans" | "requests" | "support">("businesses");
  return (
    <div className="p-5 space-y-4 max-w-6xl" data-testid="platform-admin">
      <h1 className="text-lg font-semibold">{t("ניהול הפלטפורמה", "Platform administration")}</h1>
      <p className="text-xs text-muted">{t("ניהול העסקים שמשתמשים ב-UltraCRM: חבילות, מצב, שימוש ובריאות חיבורים. תוכן שיחות ולקוחות אינו מוצג כאן – גישה אליו רק במצב תמיכה מפורש ומתועד.", "Managing the businesses that use UltraCRM: plans, status, usage and connection health. Conversations and customers are not shown here – only through an explicit, audited support session.")}</p>
      <div className="flex gap-1 border-b border-line">{([["businesses", "עסקים", "Businesses"], ["plans", "חבילות", "Plans"], ["requests", "בקשות והיסטוריה", "Requests & history"], ["support", "תמיכה ומחיקות", "Support & deletions"]] as const).map(([k, l, en]) => <button key={k} onClick={() => setTab(k)} data-testid={`platform-tab-${k}`} className={cx("px-4 h-10 text-sm -mb-px border-b-2", tab === k ? "border-accent text-accent font-semibold" : "border-transparent text-muted")}>{t(l, en)}</button>)}</div>
      {tab === "businesses" && <Businesses />}
      {tab === "plans" && <Plans />}
      {tab === "requests" && <Requests />}
      {tab === "support" && <SupportInbox />}
    </div>
  );
}

// ─── businesses ──────────────────────────────────────────────────────────────────────────────────────────────────
function Businesses() {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [rows, setRows] = useState<BizRow[] | null>(null); const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState(""); const [statusF, setStatusF] = useState(""); const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.get<{ items: BizRow[] }>("/api/platform/businesses").then((r) => setRows(r.items)).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <Spinner />;
  const shown = rows.filter((b) => (!statusF || b.accessStatus === statusF) && (!q.trim() || `${b.name} ${b.id} ${b.owner?.email ?? ""} ${b.owner?.fullName ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <Input label={t("חיפוש (שם, מזהה, בעלים)", "Search (name, id, owner)")} value={q} onChange={(e) => setQ(e.target.value)} data-testid="platform-search" />
        <Select label={t("מצב", "Status")} value={statusF} onChange={(e) => setStatusF(e.target.value)} data-testid="platform-status-filter"><option value="">{t("הכול", "All")}</option>{Object.entries(ACCESS_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <span className="text-xs text-muted">{shown.length}/{rows.length}</span>
        <Button className="ms-auto" onClick={() => setCreating(true)} data-testid="platform-new-business">{t("+ עסק לקוח חדש", "+ New customer business")}</Button>
      </div>
      <Panel bodyClassName="p-0 overflow-x-auto"><table className="w-full text-sm" data-testid="platform-businesses"><thead className="text-xs text-muted"><tr><th className="text-start p-2">{t("עסק", "Business")}</th><th className="text-start">{t("חבילה", "Plan")}</th><th className="text-start">{t("גישה", "Access")}</th>{MODULES.map((m) => <th key={m} className="text-start">{MODULE_LABEL[m]}</th>)}<th /></tr></thead>
        <tbody className="divide-y divide-line">{shown.map((b) => (
          <tr key={b.id} data-testid="platform-business-row">
            <td className="p-2 font-medium">{b.name}<div className="text-xs text-muted">{t(`${b.users} משתמשים`, `${b.users} users`)} · <span dir="ltr">{b.id.slice(-8)}</span> · {t("הצטרף", "joined")} {fmt(b.createdAt, loc)}</div><div className="text-xs text-muted">{b.owner ? `${t("בעלים", "Owner")}: ${b.owner.fullName} <${b.owner.email}>${b.owner.isActive ? "" : t(" (הזמנה ממתינה)", " (invite pending)")}` : t("ללא בעלים", "No owner")}</div></td>
            <td>{b.planVersion ? `${b.planVersion.name} · v${b.planVersion.version}` : <Badge tone="warn">{t("נדרש שיוך חבילה", "Plan assignment required")}</Badge>}</td>
            <td><Badge tone={b.accessStatus === "active" ? "good" : b.accessStatus === "suspended" ? "bad" : "warn"}>{ACCESS_STATUS_LABEL[b.accessStatus]}{b.accessUntil ? ` · ${fmt(b.accessUntil, loc)}` : ""}</Badge></td>
            {MODULES.map((m) => <td key={m} className="text-xs">{b.modules[m].included ? <><Badge tone="good">✓</Badge> <span className="text-muted">{b.modules[m].seats === null ? "∞" : b.modules[m].seats}</span><div className="text-muted">{b.modules[m].sources.map((s) => SOURCE_LABEL[s] ?? s).join(" + ")}</div></> : "—"}</td>)}
            <td className="p-2"><Button size="sm" variant="ghost" onClick={() => setOpen(b.id)} data-testid={`platform-open-${b.id}`}>{t("ניהול", "Manage")}</Button></td>
          </tr>))}</tbody></table></Panel>
      {open && <BusinessDetail id={open} onClose={() => { setOpen(null); void load(); }} />}
      {creating && <NewBusiness onClose={() => { setCreating(false); void load(); }} />}
    </>
  );
}

interface StatusImpact { status: string; stops: boolean; users: number; campaigns: number; journeys: number; dialerSessions: number; dialLists: number; stores: number; outgoingWebhooks: number; serviceAgent: boolean; effects: string[] }
interface Detail { owners: Array<{ fullName: string; email: string; pendingInvite: boolean }>; usage: { period: string; calls: number; talkMinutes: number; whatsappOut: number; whatsappIn: number; smsOut: number; emailOut: number; aiActions: number; quotas: Array<{ metric: string; used: number; limit: number | null }> }; providerCosts: { aiCoachUsd: number; note: string }; billing: { status: string; note: string };
  health: { channels: Array<{ channel: string; provider: string; label: string | null; status: string; isActive: boolean; sendingBlocked: boolean; lastWebhookAt: string | null }>; numbers: Array<{ verificationStatus: string; isActive: boolean; count: number }>; stores: Array<{ platform: string; name: string; isActive: boolean; apiStatus: string; webhookStatus: string; lastVerifiedEventAt: string | null; lastSyncError: string | null; failedEvents: number }>; payments: Array<{ provider: string; environment: string; isActive: boolean }>; outgoingWebhooks: { active: number; failedDeliveries: number } };
  supportSessions: Array<{ id: string; reason: string; startedAt: string; expiresAt: string; endedAt: string | null; endedReason: string | null }>;
  business: { id: string; name: string; accessStatus: string; accessUntil: string | null; billingStatus: string; planVersionId: string | null; createdAt: string | null; statusReason: string | null; timezone: string }; entitlement: { planName: string | null; planVersion: number | null; modules: Record<ModuleKey, { included: boolean; seats: number | null; sources: Array<{ type: string; expiresAt: string | null; grantId?: string }> }> }; seats: Record<ModuleKey, { used: number; seats: number | null; free: number | null }>; grants: Array<{ id: string; module: string; kind: string; seats: number | null; expiresAt: string | null; revokedAt: string | null; note: string | null; createdAt: string }>; users: AccessUserRow[]; audit: Array<{ id: string; action: string; createdAt: string; targetUserId: string | null }> }

function BusinessDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [d, setD] = useState<Detail | null>(null); const [plans, setPlans] = useState<Plan[]>([]); const [edit, setEdit] = useState<AccessUserRow | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [status, setStatus] = useState("active"); const [until, setUntil] = useState("");
  const [grant, setGrant] = useState<{ module: ModuleKey; kind: string; seats: string; expiresAt: string }>({ module: "crm", kind: "trial", seats: "", expiresAt: "" });
  const load = useCallback(async () => {
    try { const r = await api.get<Detail>(`/api/platform/businesses/${id}`); setD(r); setStatus(r.business.accessStatus); setUntil(r.business.accessUntil?.slice(0, 10) ?? ""); setPlans((await api.get<{ items: Plan[] }>("/api/platform/plans")).items); }
    catch (e) { toast.error((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const [statusPreview, setStatusPreview] = useState<StatusImpact | null>(null); const [reason, setReason] = useState(""); const [confirmName, setConfirmName] = useState("");
  const [supportOpen, setSupportOpen] = useState(false);
  async function previewStatus() { try { setStatusPreview(await api.get<StatusImpact>(`/api/platform/businesses/${id}/status?status=${status}`)); setReason(""); setConfirmName(""); } catch (e) { toast.error((e as Error).message); } }
  async function saveStatus() { try { await api.post(`/api/platform/businesses/${id}/status`, { status, until: until ? new Date(`${until}T23:59:59`).toISOString() : null, reason: reason || undefined, confirmName: confirmName || undefined }); toast.success(t("סטטוס הגישה עודכן", "Access status updated")); setStatusPreview(null); void load(); } catch (e) { toast.error((e as Error).message); } }
  if (!d) return <Modal open onClose={onClose} title={t("טוען…", "Loading…")}><Spinner /></Modal>;
  const versions = plans.flatMap((p) => p.versions.map((v) => ({ ...v, planName: p.name })));
  return (
    <Modal open onClose={onClose} width="max-w-5xl" title={t(`ניהול העסק: ${d.business.name}`, `Manage business: ${d.business.name}`)}>
      <div className="space-y-4 text-sm" data-testid="platform-business-detail">
        <Panel title={t("זכאות בפועל ומקורה", "Effective entitlement and its source")}>
          <table className="w-full text-sm"><tbody className="divide-y divide-line">{MODULES.map((m) => { const x = d.entitlement.modules[m]; return (
            <tr key={m} data-testid={`platform-ent-${m}`}><td className="py-1.5 w-40 font-medium">{MODULE_LABEL[m]}</td><td>{x.included ? <Badge tone="good">{t("כלול", "Included")}</Badge> : <Badge>{t("לא כלול", "Not included")}</Badge>}</td>
              <td className="text-xs text-muted">{x.sources.map((s) => `${SOURCE_LABEL[s.type] ?? s.type}${s.expiresAt ? t(` (עד ${fmt(s.expiresAt, loc)})`, ` (until ${fmt(s.expiresAt, loc)})`) : ""}`).join(" + ") || "—"}</td>
              <td className="tabular text-xs">{x.included ? (x.seats === null ? t(`${d.seats[m].used} · ללא הגבלה`, `${d.seats[m].used} · Unlimited`) : `${d.seats[m].used}/${x.seats}`) : ""}</td></tr>); })}</tbody></table>
        </Panel>
        <div className="grid md:grid-cols-2 gap-3">
          <Panel title={t("חבילה", "Plan")}>
            <Select label={t("שיוך לגרסת חבילה", "Assign plan version")} value={d.business.planVersionId ?? ""} onChange={(e) => setTarget({ planVersionId: e.target.value || null })} data-testid="platform-assign-version">
              <option value="">{t("ללא חבילה (ברירת מחדל קודמת)", "No plan (legacy default)")}</option>{versions.map((v) => <option key={v.id} value={v.id}>{v.planName} · {t("גרסה", "Version")} {v.version}</option>)}
            </Select>
            <p className="text-xs text-muted mt-1">{t("כל שינוי מציג קודם את ההשפעה ודורש אישור.", "Every change shows its impact first and requires confirmation.")}</p>
          </Panel>
          <Panel title={t("סטטוס גישה (נפרד מתשלום)", "Access status (separate from billing)")}>
            <div className="flex flex-wrap gap-2 items-end">
              <Select label={t("סטטוס", "Status")} value={status} onChange={(e) => setStatus(e.target.value)} data-testid="platform-status">{Object.entries(ACCESS_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
              {(status === "trial" || status === "grace") && <Input label={t("עד תאריך", "Until date")} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}
              <Button size="sm" onClick={previewStatus} disabled={status === d.business.accessStatus && !(status === "trial" || status === "grace")} data-testid="platform-status-save">{t("המשך – הצג השפעה", "Continue – show impact")}</Button>
            </div>
            {d.business.statusReason && <p className="text-xs mt-1">{t("סיבה:", "Reason:")} {d.business.statusReason}</p>}
            {statusPreview && <div className="mt-2 rounded border border-line p-2 text-xs space-y-1" data-testid="platform-status-impact">
              <b>{t("השפעת המעבר ל", "Effect of changing to ")}{ACCESS_STATUS_LABEL[statusPreview.status]}:</b>
              <ul className="list-disc ps-5">{statusPreview.effects.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <p>{t(`כרגע: ${statusPreview.users} משתמשים, ${statusPreview.campaigns} קמפיינים מתוזמנים/רצים, ${statusPreview.journeys} מסעות, ${statusPreview.dialerSessions} סשנים בחייגן, ${statusPreview.stores} חנויות, ${statusPreview.outgoingWebhooks} Webhooks יוצאים${statusPreview.serviceAgent ? ", סוכן שירות פעיל" : ""}.`, `Now: ${statusPreview.users} users, ${statusPreview.campaigns} scheduled/running campaigns, ${statusPreview.journeys} journeys, ${statusPreview.dialerSessions} dialer sessions, ${statusPreview.stores} stores, ${statusPreview.outgoingWebhooks} outgoing webhooks${statusPreview.serviceAgent ? ", service agent on" : ""}.`)}</p>
              <Textarea label={statusPreview.stops ? t("סיבה (חובה)", "Reason (required)") : t("סיבה (לתיעוד)", "Reason (for the record)")} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="platform-status-reason" />
              {statusPreview.stops && <Input label={t(`לאישור הקלד את שם העסק: ${d.business.name}`, `To confirm type the business name: ${d.business.name}`)} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} data-testid="platform-status-confirm" />}
              <div className="flex gap-2"><Button size="sm" variant={statusPreview.stops ? "danger" : "primary"} disabled={statusPreview.stops && (!reason.trim() || confirmName.trim() !== d.business.name.trim())} onClick={saveStatus} data-testid="platform-status-apply">{t("אשר ושמור", "Confirm and save")}</Button><Button size="sm" variant="ghost" onClick={() => setStatusPreview(null)}>{t("ביטול", "Cancel")}</Button></div>
            </div>}
          </Panel>
        </div>
        <Panel title={t("תוספות, ניסיונות והרשאות זמניות", "Add-ons, trials and temporary grants")}>
          <div className="flex flex-wrap gap-2 items-end">
            <Select label={t("מודול", "Module")} value={grant.module} onChange={(e) => setGrant({ ...grant, module: e.target.value as ModuleKey })}>{MODULES.map((m) => <option key={m} value={m}>{MODULE_LABEL[m]}</option>)}</Select>
            <Select label={t("סוג", "Type")} value={grant.kind} onChange={(e) => setGrant({ ...grant, kind: e.target.value })}><option value="addon">{t("תוספת", "Add-on")}</option><option value="trial">{t("ניסיון", "Trial")}</option><option value="temporary">{t("הרשאה זמנית", "Temporary grant")}</option></Select>
            <Input label={t("מושבים (ריק = ללא הגבלה)", "Seats (empty = unlimited)")} type="number" value={grant.seats} onChange={(e) => setGrant({ ...grant, seats: e.target.value })} />
            <Input label={t("תפוגה", "Expiry")} type="date" value={grant.expiresAt} onChange={(e) => setGrant({ ...grant, expiresAt: e.target.value })} />
            <Button size="sm" onClick={() => setTarget({ addGrant: { module: grant.module, kind: grant.kind, seats: grant.seats === "" ? null : Number(grant.seats), expiresAt: grant.expiresAt ? new Date(`${grant.expiresAt}T23:59:59`).toISOString() : null } })} data-testid="platform-add-grant">{t("הוסף", "Add")}</Button>
          </div>
          <ul className="mt-2 divide-y divide-line">{d.grants.map((g) => <li key={g.id} className="flex items-center gap-2 py-1 text-xs"><span className="w-32">{MODULE_LABEL[g.module as ModuleKey] ?? g.module}</span><Badge>{SOURCE_LABEL[g.kind] ?? g.kind}</Badge><span>{g.seats === null ? t("ללא הגבלת מושבים", "Unlimited seats") : t(`${g.seats} מושבים`, `${g.seats} seats`)}</span>{g.expiresAt && <span>{t("עד", "Until")} {fmt(g.expiresAt, loc)}</span>}{g.revokedAt ? <Badge tone="neutral">{t("בוטל", "Revoked")}</Badge> : <Button size="sm" variant="ghost" onClick={() => setTarget({ revokeGrantId: g.id })}>{t("בטל", "Revoke")}</Button>}</li>)}</ul>
        </Panel>
        <div className="grid md:grid-cols-2 gap-3">
          <Panel title={t("פרטי העסק", "Business")}>
            <p className="text-xs"><span className="text-muted">{t("מזהה:", "Id:")}</span> <span dir="ltr">{d.business.id}</span> · {t("הצטרף", "Joined")} {fmt(d.business.createdAt, loc)} · {d.business.timezone}</p>
            <ul className="text-xs mt-1">{d.owners.map((o, i) => <li key={i}>{t("בעלים", "Owner")}: {o.fullName} <span dir="ltr">&lt;{o.email}&gt;</span>{o.pendingInvite ? t(" · הזמנה ממתינה", " · invite pending") : ""}</li>)}{!d.owners.length && <li className="text-warn">{t("אין בעלים לעסק", "The business has no owner")}</li>}</ul>
          </Panel>
          <Panel title={t("חיוב ומנוי", "Billing & subscription")}>
            <p className="text-xs" data-testid="platform-billing">{t("מצב:", "State:")} <b>{d.billing.status === "manual" ? t("שיוך ידני", "Manual") : d.billing.status}</b></p>
            <p className="text-xs text-muted">{d.billing.note}</p>
          </Panel>
        </div>
        <Panel title={t(`שימוש בפועל – ${d.usage.period}`, `Actual usage – ${d.usage.period}`)}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs" data-testid="platform-usage">
            <span>{t("שיחות", "Calls")}: <b>{d.usage.calls}</b> ({d.usage.talkMinutes} {t("דק׳ שיחה", "talk min")})</span>
            <span>WhatsApp: <b>{d.usage.whatsappOut}</b> {t("יוצאות", "out")} · {d.usage.whatsappIn} {t("נכנסות", "in")}</span>
            <span>SMS: <b>{d.usage.smsOut}</b></span><span>{t("אימייל", "Email")}: <b>{d.usage.emailOut}</b></span>
            <span>{t("פעולות AI", "AI actions")}: <b>{d.usage.aiActions}</b></span>
          </div>
          <table className="mt-2 text-xs"><tbody>{d.usage.quotas.map((x) => <tr key={x.metric}><td className="pe-3">{QUOTA_LABEL[x.metric as keyof typeof QUOTA_LABEL] ?? x.metric}</td><td className="tabular">{x.used}{x.limit === null ? t(" · ללא מכסה", " · no quota") : ` / ${x.limit}`}</td></tr>)}</tbody></table>
          <p className="text-xs text-muted mt-1">{t("עלות ספק (נמדדת):", "Provider cost (measured):")} AI ${d.providerCosts.aiCoachUsd.toFixed(2)} · {d.providerCosts.note}</p>
        </Panel>
        <Panel title={t("בריאות חיבורים (ללא סודות)", "Connection health (no secrets)")}>
          <ul className="text-xs space-y-0.5" data-testid="platform-health">
            {d.health.channels.map((c, i) => <li key={`c${i}`}>{c.channel} · {c.provider} · {c.label ?? ""} · {c.isActive ? c.status : t("לא פעיל", "inactive")}{c.sendingBlocked ? t(" · שליחה חסומה", " · sending blocked") : ""}{c.lastWebhookAt ? ` · ${t("אירוע אחרון", "last event")} ${fmt(c.lastWebhookAt, loc)}` : ""}</li>)}
            {d.health.numbers.map((n, i) => <li key={`n${i}`}>{t("מספרי טלפון", "Phone numbers")}: {n.count} · {n.verificationStatus}{n.isActive ? "" : t(" (לא פעילים)", " (inactive)")}</li>)}
            {d.health.stores.map((s, i) => <li key={`s${i}`}>{t("חנות", "Store")} {s.name} ({s.platform}) · API {s.apiStatus} · Webhooks {s.webhookStatus}{s.lastVerifiedEventAt ? ` · ${fmt(s.lastVerifiedEventAt, loc)}` : ""}{s.failedEvents ? t(` · ${s.failedEvents} אירועים נכשלו`, ` · ${s.failedEvents} failed events`) : ""}{s.lastSyncError ? ` · ${s.lastSyncError}` : ""}{s.isActive ? "" : t(" · מנותקת", " · disconnected")}</li>)}
            {d.health.payments.map((p, i) => <li key={`p${i}`}>{t("סליקה", "Payments")}: {p.provider} · {p.environment}{p.isActive ? "" : t(" (לא פעיל)", " (inactive)")}</li>)}
            <li>{t("Webhooks יוצאים", "Outgoing webhooks")}: {d.health.outgoingWebhooks.active}{d.health.outgoingWebhooks.failedDeliveries ? t(` · ${d.health.outgoingWebhooks.failedDeliveries} משלוחים נכשלו`, ` · ${d.health.outgoingWebhooks.failedDeliveries} failed deliveries`) : ""}</li>
            {!d.health.channels.length && !d.health.stores.length && !d.health.payments.length && <li className="text-muted">{t("אין חיבורים לעסק", "No connections")}</li>}
          </ul>
        </Panel>
        <Panel title={t("גישת תמיכה", "Support access")} actions={<Button size="sm" variant="secondary" onClick={() => setSupportOpen(true)} data-testid="platform-support-start">{t("כניסה במצב תמיכה", "Enter support mode")}</Button>}>
          <p className="text-xs text-muted">{t("קריאה בלבד, עד 60 דקות, עם סיבה מתועדת. אין שליחה, חיוג, חיוב או חשיפת סודות.", "Read-only, up to 60 minutes, with a recorded reason. No sending, dialing, charging or secrets.")}</p>
          <ul className="text-xs mt-1">{d.supportSessions.map((s) => <li key={s.id}>{new Date(s.startedAt).toLocaleString(loc)} · {s.reason} · {s.endedAt ? t(`הסתיים (${s.endedReason ?? ""})`, `ended (${s.endedReason ?? ""})`) : new Date(s.expiresAt) > new Date() ? t("פעיל", "active") : t("פג", "expired")}</li>)}</ul>
        </Panel>
        <Panel title={t("משתמשים והרשאות", "Users and permissions")} bodyClassName="p-0">
          <table className="w-full text-sm"><tbody className="divide-y divide-line">{d.users.map((u) => <tr key={u.id} className={u.isActive ? "" : "opacity-50"}><td className="p-2">{u.fullName}<div className="text-xs text-muted">{u.email}</div></td>{MODULES.map((m) => <td key={m}><StateBadge state={u.effective?.[m]?.state} /></td>)}<td className="p-2">{u.role !== "owner" && u.isActive && <Button size="sm" variant="ghost" onClick={() => setEdit(u)} data-testid={`platform-user-${u.id}`}>{t("הגדרות", "Settings")}</Button>}</td></tr>)}</tbody></table>
        </Panel>
        <details className="text-xs"><summary className="cursor-pointer text-muted">{t("היסטוריית שינויי חבילה והרשאות", "Plan and permission change history")} ({d.audit.length})</summary><ul className="mt-1 space-y-0.5">{d.audit.map((a) => <li key={a.id}>{new Date(a.createdAt).toLocaleString(loc)} · {a.action}</li>)}</ul></details>
      </div>
      {edit && <UserAccessEditor user={edit} packageModules={d.entitlement.modules} actor={null} endpoint={`/api/platform/businesses/${id}/users/${edit.id}`} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
      {target && <ChangePreview businessId={id} target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); void load(); }} />}
      {supportOpen && <StartSupport businessId={id} businessName={d.business.name} onClose={() => setSupportOpen(false)} />}
    </Modal>
  );
}

/** Preview → explicit apply. Seat overflow requires choosing who keeps access; live calls are never cut. */
function ChangePreview({ businessId, target, onClose, onDone }: { businessId: string; target: Target; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [imp, setImp] = useState<Impact | null>(null); const [keep, setKeep] = useState<Record<string, string[]>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { api.post<{ impact: Impact }>(`/api/platform/businesses/${businessId}/impact`, target).then((r) => setImp(r.impact)).catch((e) => { toast.error((e as Error).message); onClose(); }); }, [businessId, target, onClose]);
  async function apply() { setBusy(true); try { await api.post(`/api/platform/businesses/${businessId}/apply`, { target, keep }); toast.success(t("השינוי הוחל", "Change applied")); onDone(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  const overflowOk = imp ? Object.entries(imp.seatOverflow).every(([m, o]) => (keep[m]?.length ?? -1) >= 0 && (keep[m]?.length ?? 0) <= o.seats && keep[m] !== undefined) : false;
  const nothing = imp && !imp.modulesRemoved.length && !Object.keys(imp.seatOverflow).length;
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={t("השפעת השינוי", "Change impact")} footer={<><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button><Button onClick={apply} loading={busy} disabled={!imp || !overflowOk} data-testid="platform-apply">{t("אשר והחל", "Confirm and apply")}</Button></>}>
      {!imp ? <Spinner /> : <div className="space-y-2 text-sm" data-testid="platform-impact">
        {nothing && <p className="text-good">{t("אין משתמשים או פעולות שייפגעו. מודולים שנוספים לא ייפתחו אוטומטית למשתמשים – מנהל העסק יקצה אותם.", "No users or operations will be affected. Added modules will not be opened to users automatically – the business manager will assign them.")}</p>}
        {imp.modulesRemoved.map((m) => <div key={m} className="rounded-md border border-warn/40 bg-warn/10 p-2"><b>{t(`${MODULE_LABEL[m]} יוסר`, `${MODULE_LABEL[m]} will be removed`)}</b> · {t("משתמשים שיאבדו גישה:", "Users losing access:")} {imp.usersLosing[m]?.map((u) => u.fullName).join(", ") || t("אין", "None")}</div>)}
        {imp.campaigns.length > 0 && <p>{t("קמפיינים שייעצרו (יושהו, לא יימחקו):", "Campaigns that will stop (paused, not deleted):")} {imp.campaigns.map((c) => `${c.name} (${c.channel}, ${c.status})`).join(", ")}</p>}
        {imp.journeys.length > 0 && <p>{t("מסעות לקוח ששלבי השליחה שלהם בערוץ שהוסר ידלגו:", "Customer journeys whose send steps in the removed channel will be skipped:")} {imp.journeys.map((j) => j.name).join(", ")}</p>}
        {imp.inboxAutomations > 0 && <p>{t(`${imp.inboxAutomations} אוטומציות תיבת וואטסאפ לא יבוצעו.`, `${imp.inboxAutomations} WhatsApp inbox automations will not run.`)}</p>}
        {imp.serviceAgent && <p>{t("נציג השירות ב-AI בוואטסאפ יפסיק לענות.", "The WhatsApp AI service agent will stop replying.")}</p>}
        {(imp.dialerSessions > 0 || imp.dialLists > 0) && <p>{t(`חייגן: ${imp.dialerSessions} סשנים פעילים, ${imp.dialLists} קמפיינים. שיחות פעילות לא ינותקו – חיוגים חדשים ייחסמו.`, `Dialer: ${imp.dialerSessions} active sessions, ${imp.dialLists} campaigns. Active calls will not be disconnected – new dials will be blocked.`)}</p>}
        {Object.entries(imp.seatOverflow).map(([m, o]) => <div key={m} className="rounded-md border border-bad/40 bg-bad/10 p-2" data-testid={`platform-overflow-${m}`}><b>{t(`חריגה ממכסת המושבים ב${MODULE_LABEL[m as ModuleKey]}:`, `Seat limit exceeded in ${MODULE_LABEL[m as ModuleKey]}:`)}</b> {t(`${o.holders.length} משתמשים, ${o.seats} מושבים. בחרו מי נשאר עם גישה`, `${o.holders.length} users, ${o.seats} seats. Choose who keeps access`)} ({keep[m]?.length ?? 0}/{o.seats}):
          <div className="flex flex-wrap gap-2 mt-1">{o.holders.map((u) => <label key={u.id} className="flex items-center gap-1"><input type="checkbox" checked={keep[m]?.includes(u.id) ?? false} onChange={(e) => setKeep({ ...keep, [m]: e.target.checked ? [...(keep[m] ?? []), u.id] : (keep[m] ?? []).filter((x) => x !== u.id) })} data-testid={`platform-keep-${m}-${u.id}`} />{u.fullName}</label>)}</div></div>)}
        <p className="text-xs text-muted">{t("הנתונים נשמרים תמיד. פעולות עתידיות שאינן מורשות נבדקות מחדש לפני ביצוע ונעצרות בבטחה, בלי שליחה כפולה.", "Data is always kept. Future operations that are no longer permitted are re-checked before running and stopped safely, without duplicate sends.")}</p>
      </div>}
    </Modal>
  );
}

// ─── packages ────────────────────────────────────────────────────────────────────────────────────────────────────
type Spec = { name: string; description: string; modules: Record<ModuleKey, { included: boolean; seats: string }>; quotas: Record<string, string> };
const emptySpec = (): Spec => ({ name: "", description: "", modules: Object.fromEntries(MODULES.map((m) => [m, { included: false, seats: "" }])) as Spec["modules"], quotas: {} });

function Plans() {
  const t = useT();
  const [plans, setPlans] = useState<Plan[] | null>(null); const [edit, setEdit] = useState<{ planId?: string; spec: Spec } | null>(null); const [applying, setApplying] = useState<{ plan: Plan; versionId: string } | null>(null);
  const load = useCallback(() => api.get<{ items: Plan[] }>("/api/platform/plans").then((r) => setPlans(r.items)).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  function editPlan(p: Plan) {
    const v = p.versions[0];
    setEdit({ planId: p.id, spec: { name: p.name, description: p.description ?? "", modules: Object.fromEntries(MODULES.map((m) => [m, { included: Boolean(v?.modules[m]?.included), seats: v?.modules[m]?.seats === null || v?.modules[m]?.seats === undefined ? "" : String(v.modules[m].seats) }])) as Spec["modules"], quotas: Object.fromEntries(Object.entries(v?.quotas ?? {}).map(([k, x]) => [k, x === null ? "" : String(x)])) } });
  }
  async function save() {
    if (!edit) return;
    const body = { name: edit.spec.name, description: edit.spec.description || null, modules: Object.fromEntries(MODULES.map((m) => [m, { included: edit.spec.modules[m].included, seats: edit.spec.modules[m].seats === "" ? null : Number(edit.spec.modules[m].seats) }])), quotas: Object.fromEntries(Object.entries(edit.spec.quotas).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)])) };
    try { if (edit.planId) await api.put(`/api/platform/plans/${edit.planId}`, body); else await api.post("/api/platform/plans", body); toast.success(edit.planId ? t("נוצרה גרסה חדשה – עסקים קיימים לא השתנו", "New version created – existing businesses were not changed") : t("החבילה נוצרה", "Plan created")); setEdit(null); void load(); }
    catch (e) { toast.error((e as Error).message); }
  }
  if (!plans) return <Spinner />;
  return (
    <div className="space-y-3" data-testid="platform-plans">
      <Button size="sm" onClick={() => setEdit({ spec: emptySpec() })} data-testid="platform-new-plan">{t("+ חבילה חדשה", "+ New plan")}</Button>
      {plans.map((p) => <Panel key={p.id} title={t(`${p.name} · גרסה נוכחית ${p.currentVersion}`, `${p.name} · Current version ${p.currentVersion}`)} actions={<Button size="sm" variant="secondary" onClick={() => editPlan(p)}>{t("עריכה (גרסה חדשה)", "Edit (new version)")}</Button>}>
        {p.description && <p className="text-xs text-muted mb-2">{p.description}</p>}
        <table className="w-full text-xs"><thead className="text-muted"><tr><th className="text-start">{t("גרסה", "Version")}</th>{MODULES.map((m) => <th key={m} className="text-start">{MODULE_LABEL[m]}</th>)}<th className="text-start">{t("מכסות", "Quotas")}</th><th className="text-start">{t("עסקים", "Businesses")}</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{p.versions.map((v) => <tr key={v.id}><td className="py-1">v{v.version}</td>{MODULES.map((m) => <td key={m}>{v.modules[m]?.included ? `✓ ${v.modules[m].seats === null ? "∞" : v.modules[m].seats}` : "—"}</td>)}<td>{Object.entries(v.quotas ?? {}).map(([k, x]) => `${QUOTA_LABEL[k as keyof typeof QUOTA_LABEL] ?? k}: ${x ?? "∞"}`).join(" · ") || "—"}</td><td>{v.businesses}</td>
            <td>{v.version === p.currentVersion && p.versions.some((o) => o.version !== v.version && o.businesses > 0) && <Button size="sm" variant="ghost" onClick={() => setApplying({ plan: p, versionId: v.id })}>{t("החל על עסקים בגרסאות קודמות", "Apply to businesses on older versions")}</Button>}</td></tr>)}</tbody></table>
      </Panel>)}
      {edit && <Modal open onClose={() => setEdit(null)} width="max-w-2xl" title={edit.planId ? t("עריכת חבילה – תיווצר גרסה חדשה", "Edit plan – a new version will be created") : t("חבילה חדשה", "New plan")} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>{t("ביטול", "Cancel")}</Button><Button onClick={save} disabled={!edit.spec.name.trim()} data-testid="platform-plan-save">{t("שמור", "Save")}</Button></>}>
        <div className="space-y-3 text-sm">
          <Input label={t("שם", "Name")} value={edit.spec.name} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, name: e.target.value } })} data-testid="platform-plan-name" />
          <Textarea label={t("תיאור", "Description")} rows={2} value={edit.spec.description} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, description: e.target.value } })} />
          {MODULES.map((m) => { const x = edit.spec.modules[m]; const dep = DEPENDENCIES.find((d) => d.module === m); return <div key={m}><div className="flex items-center gap-3"><label className="flex items-center gap-1 w-44"><input type="checkbox" checked={x.included} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, modules: { ...edit.spec.modules, [m]: { ...x, included: e.target.checked } } } })} data-testid={`platform-plan-${m}`} />{MODULE_LABEL[m]}</label>{x.included && <Input aria-label={t("מושבים", "Seats")} placeholder={t("מושבים (ריק = ללא הגבלה)", "Seats (empty = unlimited)")} type="number" value={x.seats} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, modules: { ...edit.spec.modules, [m]: { ...x, seats: e.target.value } } } })} className="w-56" />}</div>{x.included && dep && <p className="text-xs text-muted ps-6">{dep.note}</p>}</div>; })}
          <div className="grid md:grid-cols-2 gap-2">{QUOTA_METRICS.map((q) => <Input key={q} label={t(`${QUOTA_LABEL[q]} (ריק = ללא הגבלה)`, `${QUOTA_LABEL[q]} (empty = unlimited)`)} type="number" value={edit.spec.quotas[q] ?? ""} onChange={(e) => setEdit({ ...edit, spec: { ...edit.spec, quotas: { ...edit.spec.quotas, [q]: e.target.value } } })} />)}</div>
          <p className="text-xs text-muted">{t("מוצגות רק מכסות שהמערכת מודדת ואוכפת. עריכה יוצרת גרסה חדשה – עסקים קיימים נשארים על הגרסה שלהם עד החלה מפורשת.", "Only quotas the system measures and enforces are shown. Editing creates a new version – existing businesses stay on their version until explicitly applied.")}</p>
        </div>
      </Modal>}
      {applying && <ApplyVersion plan={applying.plan} versionId={applying.versionId} onClose={() => { setApplying(null); void load(); }} />}
    </div>
  );
}

function ApplyVersion({ plan, versionId, onClose }: { plan: Plan; versionId: string; onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<Array<{ businessId: string; name: string; impact: Impact; applied: boolean; needsSeatChoice: boolean }> | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.post<{ businesses: typeof rows }>(`/api/platform/plans/${plan.id}/apply-version`, { versionId, apply: false }).then((r) => setRows(r.businesses)).catch((e) => toast.error((e as Error).message)); }, [plan.id, versionId]);
  async function apply() { setBusy(true); try { const r = await api.post<{ businesses: NonNullable<typeof rows> }>(`/api/platform/plans/${plan.id}/apply-version`, { versionId, apply: true }); setRows(r.businesses); toast.success(t(`הוחל על ${r.businesses.filter((b) => b.applied).length} עסקים`, `Applied to ${r.businesses.filter((b) => b.applied).length} businesses`)); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={t(`החלת הגרסה החדשה של ${plan.name}`, `Apply the new version of ${plan.name}`)} footer={<><Button variant="ghost" onClick={onClose}>{t("סגור", "Close")}</Button><Button onClick={apply} loading={busy} disabled={!rows?.length}>{t("החל על העסקים שאין בהם חריגה", "Apply to businesses without overflow")}</Button></>}>
      {!rows ? <Spinner /> : !rows.length ? <p className="text-sm">{t("כל העסקים כבר בגרסה הזו.", "All businesses are already on this version.")}</p> : <ul className="text-sm divide-y divide-line">{rows.map((r) => <li key={r.businessId} className="py-2"><b>{r.name}</b> {r.applied ? <Badge tone="good">{t("הוחל", "Applied")}</Badge> : r.needsSeatChoice ? <Badge tone="bad">{t("חריגת מושבים – יש להחיל מתוך מסך העסק ולבחור משתמשים", "Seat overflow – apply from the business screen and choose users")}</Badge> : <Badge>{t("ממתין", "Pending")}</Badge>}
        <div className="text-xs text-muted">{r.impact.modulesRemoved.length ? t(`יוסרו: ${r.impact.modulesRemoved.map((m) => MODULE_LABEL[m]).join(", ")}`, `Will be removed: ${r.impact.modulesRemoved.map((m) => MODULE_LABEL[m]).join(", ")}`) : t("ללא הסרת מודולים", "No modules removed")}{r.impact.campaigns.length ? t(` · ${r.impact.campaigns.length} קמפיינים יושהו`, ` · ${r.impact.campaigns.length} campaigns will be paused`) : ""}</div></li>)}</ul>}
    </Modal>
  );
}

// ─── requests / history ──────────────────────────────────────────────────────────────────────────────────────────
function Requests() {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [rows, setRows] = useState<Array<{ id: string; action: string; businessName: string | null; createdAt: string; after: { module?: string; note?: string } | null }> | null>(null);
  useEffect(() => { api.get<{ items: NonNullable<typeof rows> }>("/api/platform/requests").then((r) => setRows(r.items)).catch((e) => toast.error((e as Error).message)); }, []);
  if (!rows) return <Spinner />;
  return <Panel bodyClassName="p-0"><table className="w-full text-sm" data-testid="platform-requests"><tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.id}><td className="p-2 text-xs text-muted whitespace-nowrap">{new Date(r.createdAt).toLocaleString(loc)}</td><td>{r.businessName ?? t("פלטפורמה", "Platform")}</td><td>{r.action === "upgrade_requested" ? <Badge tone="info">{t("בקשת שדרוג", "Upgrade request")}</Badge> : r.action}</td><td className="text-xs">{r.after?.module ? MODULE_LABEL[r.after.module as ModuleKey] : ""} {r.after?.note ?? ""}</td></tr>)}</tbody></table></Panel>;
}

/** Public support requests + Meta deletion callbacks + scheduled business deletions. */
function SupportInbox() {
  type D = { support: Array<{ id: string; name: string; email: string; businessName: string | null; topic: string; message: string; lang: string; createdAt: string }>; meta: Array<{ id: string; kind: string; confirmationCode: string; status: string; businessIds: string[]; createdAt: string }>; deletions: Array<{ id: string; name: string; deletionRequestedAt: string; deletionScheduledFor: string }> };
  const [d, setD] = useState<D | null>(null);
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  useEffect(() => { api.get<D>("/api/platform/support").then(setD).catch((e) => toast.error((e as Error).message)); }, []);
  if (!d) return <Spinner />;
  return (
    <div className="space-y-4" data-testid="platform-support">
      <Panel title={t(`פניות תמיכה (${d.support.length})`, `Support requests (${d.support.length})`)} bodyClassName="p-0"><table className="w-full text-sm"><tbody className="divide-y divide-line">{d.support.map((r) => <tr key={r.id} className="align-top"><td className="p-2 text-xs text-muted whitespace-nowrap">{new Date(r.createdAt).toLocaleString(loc)}</td><td className="p-2">{r.name}<div className="text-xs ltr text-start">{r.email}</div>{r.businessName && <div className="text-xs text-muted">{r.businessName}</div>}</td><td className="p-2"><Badge tone="info">{r.topic}</Badge></td><td className="p-2 whitespace-pre-wrap">{r.message}</td></tr>)}</tbody></table></Panel>
      <Panel title={t("בקשות מחיקה / הסרה מ-Meta", "Meta deletion / removal requests")} bodyClassName="p-0"><table className="w-full text-sm"><tbody className="divide-y divide-line">{d.meta.map((r) => <tr key={r.id}><td className="p-2 text-xs text-muted">{new Date(r.createdAt).toLocaleString(loc)}</td><td className="p-2">{r.kind === "deauthorize" ? t("הסרת אפליקציה", "App removal") : t("מחיקת נתונים", "Data deletion")}</td><td className="p-2 ltr">{r.confirmationCode}</td><td className="p-2">{r.status}</td><td className="p-2 text-xs">{t(`${r.businessIds.length} עסקים`, `${r.businessIds.length} businesses`)}</td></tr>)}</tbody></table></Panel>
      <Panel title={t("עסקים שממתינים למחיקה", "Businesses pending deletion")} bodyClassName="p-0"><table className="w-full text-sm"><tbody className="divide-y divide-line">{d.deletions.map((b) => <tr key={b.id}><td className="p-2">{b.name}</td><td className="p-2 text-xs">{t("בקשה:", "Requested:")} {new Date(b.deletionRequestedAt).toLocaleDateString(loc)}</td><td className="p-2 text-xs">{t("מחיקה:", "Deletion:")} {new Date(b.deletionScheduledFor).toLocaleDateString(loc)}</td></tr>)}</tbody></table></Panel>
    </div>
  );
}

/** A new customer business: isolated and empty; its owner joins with a one-time link (shown ONCE here). */
function NewBusiness({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [f, setF] = useState({ name: "", ownerName: "", ownerEmail: "", status: "setup" as "setup" | "trial" | "active", trialUntil: "", planVersionId: "" });
  const [plans, setPlans] = useState<Plan[]>([]); const [busy, setBusy] = useState(false); const [done, setDone] = useState<{ inviteUrl: string; name: string } | null>(null);
  useEffect(() => { api.get<{ items: Plan[] }>("/api/platform/plans").then((r) => setPlans(r.items)).catch(() => undefined); }, []);
  async function create() {
    setBusy(true);
    try { const r = await api.post<{ business: { name: string }; inviteUrl: string }>("/api/platform/businesses", { name: f.name, ownerName: f.ownerName, ownerEmail: f.ownerEmail, status: f.status, trialUntil: f.status === "trial" && f.trialUntil ? new Date(`${f.trialUntil}T23:59:59`).toISOString() : null, planVersionId: f.planVersionId || null }); setDone({ inviteUrl: r.inviteUrl, name: r.business.name }); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const versions = plans.flatMap((p) => p.versions.filter((v) => v.version === p.currentVersion).map((v) => ({ ...v, planName: p.name })));
  return (
    <Modal open onClose={onClose} title={t("עסק לקוח חדש", "New customer business")}>
      {done ? <div className="space-y-2 text-sm" data-testid="platform-new-done">
        <p>{t(`העסק "${done.name}" נוצר – ריק, מבודד וללא חיבורים. שלח לבעלים את קישור ההזמנה (חד-פעמי, 7 ימים). הקישור לא יוצג שוב.`, `"${done.name}" was created – empty, isolated, with no connections. Send the owner this one-time invite link (7 days). It will not be shown again.`)}</p>
        <code dir="ltr" className="block break-all rounded bg-panel-2 p-2 text-xs" data-testid="platform-invite-url">{done.inviteUrl}</code>
        <Button size="sm" onClick={() => { void navigator.clipboard.writeText(done.inviteUrl); toast.success(t("הועתק", "Copied")); }}>{t("העתק קישור", "Copy link")}</Button>
      </div> : <div className="space-y-2 text-sm" data-testid="platform-new-form">
        <Input label={t("שם העסק", "Business name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="platform-new-name" />
        <div className="grid sm:grid-cols-2 gap-2">
          <Input label={t("שם הבעלים", "Owner name")} value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} data-testid="platform-new-owner-name" />
          <Input label={t("אימייל הבעלים", "Owner email")} dir="ltr" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} data-testid="platform-new-owner-email" />
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <Select label={t("מצב התחלתי", "Initial status")} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })}><option value="setup">{ACCESS_STATUS_LABEL.setup}</option><option value="trial">{ACCESS_STATUS_LABEL.trial}</option><option value="active">{ACCESS_STATUS_LABEL.active}</option></Select>
          {f.status === "trial" && <Input label={t("ניסיון עד", "Trial until")} type="date" value={f.trialUntil} onChange={(e) => setF({ ...f, trialUntil: e.target.value })} />}
        </div>
        <Select label={t("חבילה", "Plan")} value={f.planVersionId} onChange={(e) => setF({ ...f, planVersionId: e.target.value })}><option value="">{t("ללא – לשייך אחר כך", "None – assign later")}</option>{versions.map((v) => <option key={v.id} value={v.id}>{v.planName} · v{v.version}</option>)}</Select>
        <p className="text-xs text-muted">{t("שום נתון, חיבור או סוד לא מועתקים מעסק קיים. הבעלים יגדיר סיסמה בעצמו דרך הקישור.", "No data, connection or secret is copied from any existing business. The owner sets their own password through the link.")}</p>
        <div className="flex gap-2"><Button disabled={busy || f.name.trim().length < 2 || !f.ownerEmail.includes("@") || (f.status === "trial" && !f.trialUntil)} onClick={() => void create()} data-testid="platform-new-create">{busy ? t("יוצר…", "Creating…") : t("צור עסק והזמנת בעלים", "Create business & owner invite")}</Button><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button></div>
      </div>}
    </Modal>
  );
}

/** Explicit support entry: reason + duration; the browser session switches to the read-only support session. */
function StartSupport({ businessId, businessName, onClose }: { businessId: string; businessName: string; onClose: () => void }) {
  const t = useT();
  const [reason, setReason] = useState(""); const [minutes, setMinutes] = useState(30); const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    try { await api.post(`/api/platform/businesses/${businessId}/support`, { reason, minutes }); window.location.href = "/dashboard"; }
    catch (e) { toast.error((e as Error).message); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={t(`כניסת תמיכה לעסק "${businessName}"`, `Support access to "${businessName}"`)}>
      <div className="space-y-2 text-sm" data-testid="platform-support-form">
        <p className="text-xs">{t("קריאה בלבד: אפשר לצפות בנתוני העסק כדי לאבחן תקלה. אין שליחה, חיוג, חיוב, שינוי הגדרות או חשיפת סודות. הכניסה, הסיבה והזמן נרשמים ביומן העסק וביומן הפלטפורמה.", "Read-only: view the business's data to diagnose an issue. No sending, dialing, charging, settings changes or secrets. The entry, reason and time are recorded in the business and platform logs.")}</p>
        <Textarea label={t("סיבה (חובה)", "Reason (required)")} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="platform-support-reason" />
        <Select label={t("משך", "Duration")} value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}><option value="15">15 {t("דק׳", "min")}</option><option value="30">30 {t("דק׳", "min")}</option><option value="60">60 {t("דק׳", "min")}</option></Select>
        <div className="flex gap-2"><Button disabled={busy || reason.trim().length < 5} onClick={() => void start()} data-testid="platform-support-go">{t("כניסה במצב תמיכה", "Enter support mode")}</Button><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button></div>
      </div>
    </Modal>
  );
}
