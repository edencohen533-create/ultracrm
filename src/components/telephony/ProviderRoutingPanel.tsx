"use client";

/**
 * Telephony providers (business owner only): primary / backup, account checks, routing policy, manual switch,
 * circuit breaker state, switch log and dial attempts waiting for settlement. Configuration health is shown apart
 * from an end-to-end test (a real, paid call – never run from here).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";
import { ZadarmaSection } from "./ZadarmaSection";

type Mode = "primary_only" | "manual_backup" | "auto_failover";
interface ProviderRow {
  name: string; simulation: boolean; testOnly: boolean; configured: boolean; missing: string[]; blocker: string | null;
  capabilities: { agentClient: string; inboundCalls: boolean; recording: boolean; legLookupByReference: boolean };
  accountCheck: { ok: boolean; checkedAt: string; verifiedAt: string | null; checks: Array<{ name: string; ok: boolean; detail?: string }> } | null;
  eligibleForRealCalls: boolean; eligibilityReason: string;
}
interface Overview {
  featureFlag: "on" | "off"; platformDefault: string; newCallsUse: string;
  routing: { primary: string; backup: string | null; mode: Mode; manualActive: "primary" | "backup"; breaker: { failureThreshold: number; windowSeconds: number; cooldownSeconds: number; probeCalls: number }; backupDailyCallLimit: number | null; failoverOnCapacity: boolean };
  providers: ProviderRow[];
  health: Array<{ provider: string; state: "closed" | "open" | "half_open"; failuresInWindow: number; lastFailureClass: string | null; lastFailureAt: string | null; nextProbeAt: string | null; lastSuccessAt: string | null }>;
  log: Array<{ id: string; kind: string; fromProvider: string | null; toProvider: string | null; reason: string | null; createdAt: string; actorId: string | null }>;
  settlement: Array<{ id: string; callId: string; leg: string; provider: string; toE164: string | null; requestedAt: string; failureDetail: string | null }>;
}

const REASON: Record<string, [string, string]> = {
  verified: ["מאומת", "Verified"], test_adapter: ["מתאם בדיקות", "Test adapter"], not_configured: ["לא מוגדר", "Not configured"],
  not_verified: ["לא מאומת – הרץ בדיקת הגדרות", "Not verified – run a configuration check"], verification_expired: ["האימות פג – הרץ בדיקה שוב", "Verification expired – check again"],
  simulation: ["הדמיה – לא ספק אמיתי", "Simulation – not a real provider"], test_only: ["לבדיקות בלבד", "Tests only"],
  agent_client_missing: ["אין לקוח דפדפן לנציג", "No agent browser client"], no_outbound: ["לא תומך בחיוג יוצא", "No outbound dialing"],
  caller_id_not_approved: ["מספר יוצא לא אושר", "Caller ID not approved"], no_agent_extensions: ["לא הוגדרו שלוחות לנציגים", "No agent extensions"],
  live_test_required: ["נדרשת בדיקה חיה שעברה", "A passed live test is required"], backup_daily_limit: ["הגיע למגבלה היומית", "Daily limit reached"],
};
const BREAKER: Record<string, [string, string, "good" | "warn" | "bad"]> = { closed: ["תקין", "Healthy", "good"], half_open: ["בודק התאוששות", "Testing recovery", "warn"], open: ["מנותק זמנית", "Tripped", "bad"] };
const KIND: Record<string, [string, string]> = { manual: ["החלפה ידנית", "Manual switch"], auto_failover: ["מעבר אוטומטי לגיבוי", "Automatic failover"], auto_recovery: ["חזרה לראשי", "Back to primary"], policy_change: ["שינוי מדיניות", "Policy change"], breaker_open: ["מפסק נפתח", "Breaker opened"], breaker_closed: ["מפסק נסגר", "Breaker closed"] };
const PROVIDER_LABEL: Record<string, string> = { telnyx: "Telnyx", mock: "Simulation", zadarma: "Zadarma" };

export function ProviderRoutingPanel() {
  const t = useT();
  const [d, setD] = useState<Overview | null | "denied">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Overview["routing"] | null>(null);
  const load = useCallback(async () => {
    try { const o = await api.get<Overview>("/api/telephony/routing"); setD(o); setForm(o.routing); }
    catch (e) { if (e instanceof ApiClientError && e.status === 403) setD("denied"); else toast.error((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (d === "denied") return null;
  if (!d || !form) return <Spinner />;

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try { await fn(); if (done) toast.success(done); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  const reason = (r: string) => t(...(REASON[r] ?? [r, r]));
  const label = (p: string | null) => (p ? PROVIDER_LABEL[p] ?? p : t("לא מוגדר", "Not configured"));
  const healthOf = (p: string) => d.health.find((h) => h.provider === p);

  return (
    <Panel title={t("ספקי טלפוניה – ראשי וגיבוי", "Telephony providers – primary and backup")}>
      <div className="flex flex-wrap items-center gap-2 text-sm mb-3" data-testid="routing-summary">
        <span>{t("מתג התכונה:", "Feature flag:")}</span>
        <Badge tone={d.featureFlag === "on" ? "good" : "neutral"}>{d.featureFlag === "on" ? t("פעיל", "On") : t("כבוי – כל השיחות בספק ברירת המחדל", "Off – all calls use the platform default")}</Badge>
        <span className="ms-3">{t("שיחות חדשות יוצאות דרך:", "New calls go through:")}</span><b>{label(d.newCallsUse)}</b>
        <span className="text-xs text-muted">{t("(שיחה פעילה לעולם לא עוברת בין ספקים)", "(an active call never moves between providers)")}</span>
      </div>

      <div className="overflow-auto">
        <table className="w-full min-w-[860px] text-xs" data-testid="routing-providers">
          <thead className="text-muted"><tr><th className="text-start p-1">{t("ספק", "Provider")}</th><th className="text-start">{t("תפקיד", "Role")}</th><th className="text-start">{t("הגדרות", "Configuration")}</th><th className="text-start">{t("בדיקת חשבון", "Account check")}</th><th className="text-start">{t("שיחות אמיתיות", "Real calls")}</th><th className="text-start">{t("מפסק", "Breaker")}</th><th /></tr></thead>
          <tbody>{d.providers.map((p) => {
            const h = healthOf(p.name); const b = BREAKER[h?.state ?? "closed"];
            const role = p.name === d.routing.primary ? t("ראשי", "Primary") : p.name === d.routing.backup ? t("גיבוי", "Backup") : "—";
            return (
              <tr key={p.name} className="border-t border-line align-top">
                <td className="p-1"><b>{label(p.name)}</b><div className="text-muted">{t("לקוח נציג:", "Agent client:")} {p.capabilities.agentClient}</div></td>
                <td>{role}</td>
                <td className="max-w-56">{p.configured ? <Badge tone="good">{t("מוגדר", "Configured")}</Badge> : <><Badge tone="bad">{t("חסרים משתני סביבה", "Missing environment variables")}</Badge><div className="text-muted break-all mt-0.5 ltr">{p.missing.join(", ")}</div></>}</td>
                <td>{p.accountCheck ? <div><Badge tone={p.accountCheck.ok ? "good" : "bad"}>{p.accountCheck.ok ? t("עבר", "Passed") : t("נכשל", "Failed")}</Badge> <span className="text-muted">{formatDateTime(p.accountCheck.checkedAt)}</span>
                  <ul className="mt-1">{p.accountCheck.checks.map((c) => <li key={c.name} className={c.ok ? "text-muted" : "text-bad"}>{c.ok ? "✓" : "✗"} {c.name}{c.detail ? ` – ${c.detail}` : ""}</li>)}</ul></div> : <span className="text-muted">{t("לא נבדק", "Not checked")}</span>}</td>
                <td><Badge tone={p.eligibleForRealCalls ? "good" : "neutral"}>{reason(p.eligibilityReason)}</Badge></td>
                <td>{h ? <div><Badge tone={b[2]}>{t(b[0], b[1])}</Badge>{h.lastFailureClass && <div className="text-muted">{t("כשל אחרון:", "Last failure:")} {h.lastFailureClass} · {h.lastFailureAt ? formatDateTime(h.lastFailureAt) : ""}</div>}{h.state === "open" && h.nextProbeAt && <div className="text-muted">{t("ניסיון חוזר:", "Retry at:")} {formatDateTime(h.nextProbeAt)}</div>}</div> : <span className="text-muted">—</span>}</td>
                <td>{!p.simulation && <Button size="sm" variant="secondary" loading={busy === `check-${p.name}`} onClick={() => run(`check-${p.name}`, () => api.post("/api/telephony/routing/check", { provider: p.name }), t("הבדיקה הסתיימה", "Check finished"))} data-testid={`routing-check-${p.name}`}>{t("בדיקת הגדרות", "Check configuration")}</Button>}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">{t("בדיקת הגדרות קוראת בלבד מהחשבון (אפליקציה, פרופיל יוצא, webhook, יתרה) – ללא שיחות וללא רכישות. בדיקה מקצה לקצה דורשת שיחה אמיתית בתשלום ולכן לא בוצעה.", "The configuration check only reads the account (app, outbound profile, webhook, balance) – no calls, no purchases. An end-to-end test needs a real paid call and has not been run.")}</p>

      <div className="grid md:grid-cols-3 gap-3 mt-4 text-sm" data-testid="routing-policy">
        <Select label={t("ספק ראשי", "Primary provider")} value={form.primary} onChange={(e) => setForm({ ...form, primary: e.target.value })}>{d.providers.map((p) => <option key={p.name} value={p.name}>{label(p.name)}</option>)}</Select>
        <Select label={t("ספק גיבוי", "Backup provider")} value={form.backup ?? ""} onChange={(e) => setForm({ ...form, backup: e.target.value || null })}><option value="">{t("ללא", "None")}</option>{d.providers.filter((p) => p.name !== form.primary).map((p) => <option key={p.name} value={p.name}>{label(p.name)}</option>)}</Select>
        <Select label={t("מדיניות מעבר", "Failover policy")} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Mode })} data-testid="routing-mode">
          <option value="primary_only">{t("ראשי בלבד", "Primary only")}</option><option value="manual_backup">{t("מעבר ידני", "Manual switch")}</option><option value="auto_failover">{t("גיבוי אוטומטי", "Automatic failover")}</option>
        </Select>
        <Input type="number" label={t("כשלים לפתיחת המפסק", "Failures to trip")} value={String(form.breaker.failureThreshold)} onChange={(e) => setForm({ ...form, breaker: { ...form.breaker, failureThreshold: Number(e.target.value) } })} />
        <Input type="number" label={t("חלון ספירה (שניות)", "Counting window (s)")} value={String(form.breaker.windowSeconds)} onChange={(e) => setForm({ ...form, breaker: { ...form.breaker, windowSeconds: Number(e.target.value) } })} />
        <Input type="number" label={t("זמן התאוששות (שניות)", "Recovery period (s)")} value={String(form.breaker.cooldownSeconds)} onChange={(e) => setForm({ ...form, breaker: { ...form.breaker, cooldownSeconds: Number(e.target.value) } })} />
        <Input type="number" label={t("שיחות ניסיון לחזרה", "Trial calls before return")} value={String(form.breaker.probeCalls)} onChange={(e) => setForm({ ...form, breaker: { ...form.breaker, probeCalls: Number(e.target.value) } })} />
        <Input type="number" label={t("מקסימום שיחות ביום דרך הגיבוי (ריק = ללא)", "Max calls per day via backup (empty = none)")} value={form.backupDailyCallLimit == null ? "" : String(form.backupDailyCallLimit)} onChange={(e) => setForm({ ...form, backupDailyCallLimit: e.target.value ? Number(e.target.value) : null })} />
        <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" checked={form.failoverOnCapacity} onChange={(e) => setForm({ ...form, failoverOnCapacity: e.target.checked })} />{t("מעבר לגיבוי גם כשכל הקווים תפוסים אצל הראשי", "Fail over also when the primary is out of lines")}</label>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <Button loading={busy === "save"} onClick={() => run("save", () => api.patch("/api/telephony/routing", { primaryProvider: form.primary, backupProvider: form.backup, mode: form.mode, ...form.breaker, backupDailyCallLimit: form.backupDailyCallLimit, failoverOnCapacity: form.failoverOnCapacity }), t("נשמר", "Saved"))} data-testid="routing-save">{t("שמירת מדיניות", "Save policy")}</Button>
        {d.routing.mode === "manual_backup" && (d.routing.manualActive === "primary"
          ? <Button variant="secondary" loading={busy === "switch"} onClick={() => { if (confirm(t("להעביר שיחות חדשות לספק הגיבוי? שיחות פעילות יישארו בספק שלהן.", "Send new calls to the backup provider? Active calls stay on their provider."))) void run("switch", () => api.patch("/api/telephony/routing", { manualActive: "backup" }), t("שיחות חדשות עוברות לגיבוי", "New calls now use the backup")); }} data-testid="routing-to-backup">{t("העבר שיחות חדשות לגיבוי", "Send new calls to backup")}</Button>
          : <Button variant="secondary" loading={busy === "switch"} onClick={() => run("switch", () => api.patch("/api/telephony/routing", { manualActive: "primary" }), t("חזרה לספק הראשי", "Back to primary"))} data-testid="routing-to-primary">{t("חזור לספק הראשי", "Return to primary")}</Button>)}
      </div>
      <p className="text-xs text-muted mt-1">{t("מעבר לגיבוי מופעל רק לתקלות ספק/חשבון/הרשאה ו-timeout – לא לתפוס או אין מענה. ספק שאינו מוגדר ומאומת לא יקבל שיחות אמיתיות.", "Failover reacts only to provider / account / authorization failures and timeouts – never to busy or no answer. A provider that is not configured and verified never receives real calls.")}</p>

      {d.settlement.length > 0 && (
        <div className="mt-4" data-testid="routing-settlement">
          <h4 className="text-sm font-semibold">{t("ניסיונות חיוג שממתינים להסדרה", "Dial attempts awaiting settlement")}</h4>
          <p className="text-xs text-muted">{t("הספק לא אישר ולא שלל יצירת שיחה. בדוק ביומן השיחות של הספק וסמן את התוצאה.", "The provider neither confirmed nor denied the call. Check the provider's call log and record the result.")}</p>
          <ul className="text-xs space-y-1 mt-1">{d.settlement.map((a) => <li key={a.id} className="flex flex-wrap items-center gap-2"><span>{formatDateTime(a.requestedAt)} · {label(a.provider)} · {a.leg} · <span className="ltr">{a.toE164 ?? ""}</span></span>
            <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => run(a.id, () => api.post("/api/telephony/routing/settle", { attemptId: a.id, resolution: "no_call" }))}>{t("לא נוצרה שיחה", "No call was made")}</Button>
            <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => run(a.id, () => api.post("/api/telephony/routing/settle", { attemptId: a.id, resolution: "call_happened" }))}>{t("השיחה התקיימה", "The call happened")}</Button></li>)}</ul>
        </div>
      )}

      <ZadarmaSection />

      <div className="mt-4">
        <h4 className="text-sm font-semibold">{t("יומן מעברים", "Switch log")}</h4>
        {d.log.length ? <ul className="text-xs space-y-0.5 mt-1 max-h-56 overflow-auto" data-testid="routing-log">{d.log.map((l) => <li key={l.id}><span className="text-muted">{formatDateTime(l.createdAt)}</span> · {t(...(KIND[l.kind] ?? [l.kind, l.kind]))} · {label(l.fromProvider)} → {label(l.toProvider)}{l.reason ? ` · ${l.reason}` : ""}</li>)}</ul> : <p className="text-xs text-muted mt-1">{t("אין מעברים עדיין.", "No switches yet.")}</p>}
      </div>
    </Panel>
  );
}
