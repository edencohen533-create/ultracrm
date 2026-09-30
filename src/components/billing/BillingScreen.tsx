"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Item { code: string; modules: string[]; name: string; kind: "per_license" | "per_business"; unitPriceMinor: number }
interface Overview {
  provider: { key: string; name: string; live: boolean } | null;
  priceBook: { version: number; currency: string; taxRateBps: number; items: Item[] } | null;
  subscription: { status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null; paymentMethodLabel: string | null; failedAttempts: number; items: Array<{ code: string; quantity: number; pendingQuantity: number | null; unitPriceMinor: number; kind: string; inUse: number }> } | null;
  documents: Array<{ id: string; number: string; kind: string; periodStart: string | null; periodEnd: string | null; currency: string; subtotalMinor: number; taxMinor: number; totalMinor: number; status: string; issuedAt: string; paidAt: string | null; checkoutUrl: string | null }>;
  notice: { level: string; text: string; restrictAt: string | null } | null; paymentMethodUpdateUrl: string | null;
}
interface Quote { lines: Array<{ code: string; name: string; unitPriceMinor: number; current: number; next: number; chargeNowQty: number; chargeNowMinor: number; changeAtRenewal: number | null }>; subtotalMinor: number; taxMinor: number; totalMinor: number; monthlyAfterChangeMinor: number; monthlyTaxMinor: number; reductionsEffectiveAt: string | null; prorated: boolean; periodEnd: string; note: string }
interface Usage { month: string; lines: Array<{ module: string; service: string; status: string; unit: string; events: number; quantity: number; billedQuantity: number | null; priceMinor: number | null; billedByProvider: boolean }>; finalMinor: number; estimatedMinor: number; unratedEvents: number; forecastMinor: number; forecastNote: string }
interface Licenses { licenses: Array<{ module: string; seats: number | null; used: number; holders: Array<{ id: string; name: string }> }>; users: Array<{ id: string; fullName: string; role: string }> }

const SUB: Record<string, [string, "good" | "warn" | "bad" | "neutral"]> = { none: ["אין מנוי", "neutral"], pending_payment: ["ממתין לתשלום ראשון", "warn"], active: ["פעיל", "good"], past_due: ["תשלום נכשל – בניסיון חוזר", "bad"], grace: ["תקופת חסד הסתיימה – השירות מוגבל", "bad"], canceled: ["בוטל", "neutral"] };
const STATUS: Record<string, string> = { estimated: "הערכה", final: "סופי", unrated: "ללא תעריף", not_billable: "לא לחיוב", credited: "זוכה", failed: "נכשל" };
const MODULE: Record<string, string> = { crm: "CRM", telephony: "חייגן ו-AI", whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" };
const ils = (m: number | null | undefined) => (m === null || m === undefined ? "אין נתון" : `₪${(m / 100).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const d = (s: string | null) => (s ? new Date(s).toLocaleDateString("he-IL") : "—");

/** חיוב ושימוש – owner / billing admin. Every amount comes from the server (quote → confirm the exact total). */
export function BillingScreen() {
  const t = useT();
  const [ov, setOv] = useState<Overview | null>(null); const [usage, setUsage] = useState<Usage | null>(null); const [lic, setLic] = useState<Licenses | null>(null);
  const [budget, setBudget] = useState<{ policy: { monthlyCapMinor: number | null; alertPercents: number[]; hardStop: boolean }; spent: { usedMinor: number; heldMinor: number } } | null>(null);
  const [desired, setDesired] = useState<Record<string, number>>({}); const [q, setQ] = useState<Quote | null>(null); const [busy, setBusy] = useState(""); const [err, setErr] = useState("");
  const [cap, setCap] = useState(""); const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const load = useCallback(async () => {
    try {
      const o = await api.get<Overview>("/api/billing"); setOv(o);
      setDesired(Object.fromEntries((o.priceBook?.items ?? []).map((i) => [i.code, o.subscription?.items.find((x) => x.code === i.code)?.pendingQuantity ?? o.subscription?.items.find((x) => x.code === i.code)?.quantity ?? 0])));
      const b = await api.get<typeof budget>("/api/billing/budget"); setBudget(b); setCap(b?.policy.monthlyCapMinor ? String(b.policy.monthlyCapMinor / 100) : "");
      if (o.subscription && o.subscription.status !== "none") setLic(await api.get<Licenses>("/api/billing/licenses"));
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.get<Usage>(`/api/billing/usage?month=${month}`).then(setUsage).catch(() => undefined); }, [month]);
  const changed = useMemo(() => ov?.priceBook?.items.some((i) => (desired[i.code] ?? 0) !== (ov.subscription?.items.find((x) => x.code === i.code)?.pendingQuantity ?? ov.subscription?.items.find((x) => x.code === i.code)?.quantity ?? 0)), [desired, ov]);

  async function doQuote() { setBusy("q"); try { setQ(await api.post<Quote>("/api/billing/quote", { desired })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); } }
  async function confirm() {
    if (!q) return; setBusy("c");
    try {
      const r = await api.post<{ checkoutUrl: string | null; scheduled?: string | null }>("/api/billing/checkout", { desired, idempotencyKey: crypto.randomUUID(), expectedTotalMinor: q.totalMinor });
      if (r.checkoutUrl) { window.location.href = r.checkoutUrl; return; }
      toast.success(t("השינוי נשלח – הוא יחול אחרי אימות התשלום מול הספק", "Sent – it applies after the provider verifies the payment")); setQ(null); await load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }
  async function setLicense(userId: string, module: string, on: boolean) { try { setLic(await api.post<Licenses>("/api/billing/licenses", { userId, module, on })); } catch (e) { toast.error((e as Error).message); } }
  async function saveBudget() { try { await api.put("/api/billing/budget", { monthlyCapMinor: cap ? Math.round(Number(cap) * 100) : null, alertPercents: budget?.policy.alertPercents ?? [50, 80, 100], hardStop: budget?.policy.hardStop ?? true }); toast.success(t("התקציב נשמר", "Budget saved")); await load(); } catch (e) { toast.error((e as Error).message); } }

  if (err) return <div className="p-6"><p role="alert" className="text-bad">{err}</p></div>;
  if (!ov) return <div className="p-10 flex justify-center"><Spinner /></div>;
  const s = ov.subscription; const st = SUB[s?.status ?? "none"] ?? [s?.status ?? "", "neutral"];
  const fixed = (s?.items ?? []).reduce((a, i) => a + i.unitPriceMinor * i.quantity, 0);
  const spent = (budget?.spent.usedMinor ?? 0) + (budget?.spent.heldMinor ?? 0);
  return (
    <div className="p-4 md:p-5 space-y-4 max-w-5xl" data-testid="billing-screen">
      <h1 className="text-lg font-semibold">{t("חיוב ושימוש", "Billing & usage")}</h1>
      {!ov.provider && <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-sm" data-testid="billing-no-provider">{t("ספק החיוב של UltraCRM עדיין לא מחובר – לא ניתן לרכוש כרגע. החיוב נפרד מסליקת העסקאות של העסק מול הלקוחות שלו.", "UltraCRM's billing provider isn't connected yet – purchasing is unavailable. This is separate from your own payments to your customers.")}</p>}
      {ov.provider && !ov.provider.live && <p className="rounded-md bg-amber-100 text-amber-900 p-2 text-xs" data-testid="billing-sandbox">{t("סביבת בדיקה: תשלומים מדומים – לא מתבצע חיוב אמיתי.", "Sandbox: simulated payments – no real charge.")}</p>}
      {ov.notice && <p role="alert" className={ov.notice.level === "warning" ? "rounded-md border border-bad/40 bg-bad/10 p-2 text-sm" : "rounded-md border border-line bg-panel p-2 text-sm"} data-testid="billing-notice">{ov.notice.text}</p>}

      <Panel title={<span className="flex items-center gap-2">{t("מנוי", "Subscription")} <Badge tone={st[1]}>{st[0]}</Badge></span>}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div><p className="text-xs text-muted">{t("תקופה נוכחית", "Current period")}</p><p>{d(s?.currentPeriodStart ?? null)} – {d(s?.currentPeriodEnd ?? null)}</p></div>
          <div><p className="text-xs text-muted">{t("עלות רישיונות חודשית (לפני מע״מ)", "Monthly licenses (before VAT)")}</p><p className="font-semibold" data-testid="billing-fixed">{ils(fixed)}</p></div>
          <div><p className="text-xs text-muted">{t("אמצעי תשלום", "Payment method")}</p><p>{s?.paymentMethodLabel ?? "—"}</p>{ov.paymentMethodUpdateUrl && <a className="text-xs underline text-accent" href={ov.paymentMethodUpdateUrl}>{t("עדכון אמצעי תשלום", "Update payment method")}</a>}</div>
          <div><p className="text-xs text-muted">{t("מחירון", "Price book")}</p><p>{ov.priceBook ? `v${ov.priceBook.version}` : t("לא פורסם", "Not published")}</p></div>
        </div>
        {s && s.status === "active" && <div className="mt-2 text-xs">{s.cancelAtPeriodEnd ? <button className="underline" onClick={async () => { await api.post("/api/billing/cancel", { resume: true }); await load(); }}>{t("ביטול הביטול", "Undo cancellation")}</button> : <button className="underline text-bad" onClick={async () => { if (window.confirm(t(`לבטל? המנוי יסתיים ב-${d(s.currentPeriodEnd)}. הנתונים לא יימחקו.`, "Cancel? Ends at the period end. Data is not deleted."))) { await api.post("/api/billing/cancel", {}); await load(); } }} data-testid="billing-cancel">{t("ביטול מנוי בסוף התקופה", "Cancel at period end")}</button>}</div>}
      </Panel>

      {ov.priceBook && (
        <Panel title={t("רישיונות ומודולים", "Licenses & modules")}>
          <div className="space-y-2 text-sm" data-testid="billing-items">
            {ov.priceBook.items.map((i) => { const cur = s?.items.find((x) => x.code === i.code); return (
              <div key={i.code} className="flex flex-wrap items-center gap-2">
                <span className="min-w-44 font-medium">{i.name}</span>
                <span className="text-xs text-muted min-w-40">{ils(i.unitPriceMinor)} {i.kind === "per_license" ? t("לרישיון לחודש", "per license / month") : t("לעסק לחודש", "per business / month")}</span>
                {i.kind === "per_license" ? <Input aria-label={i.name} type="number" min={0} value={desired[i.code] ?? 0} onChange={(e) => { setDesired({ ...desired, [i.code]: Math.max(0, Number(e.target.value)) }); setQ(null); }} className="h-8 w-20" data-testid={`billing-qty-${i.code}`} /> : <label className="flex items-center gap-1"><input type="checkbox" checked={(desired[i.code] ?? 0) > 0} onChange={(e) => { setDesired({ ...desired, [i.code]: e.target.checked ? 1 : 0 }); setQ(null); }} data-testid={`billing-qty-${i.code}`} /> {t("כלול", "Included")}</label>}
                {cur && <span className="text-xs text-muted">{t(`נרכשו ${cur.quantity} · בשימוש ${cur.inUse}`, `${cur.quantity} bought · ${cur.inUse} in use`)}{cur.pendingQuantity !== null ? t(` · יירד ל-${cur.pendingQuantity} בחידוש`, ` · to ${cur.pendingQuantity} at renewal`) : ""}</span>}
              </div>
            ); })}
            <div className="flex gap-2 pt-1"><Button size="sm" variant="secondary" disabled={!changed || busy === "q"} onClick={doQuote} data-testid="billing-quote">{t("הצג מחיר לשינוי", "Price this change")}</Button></div>
            {q && (
              <div className="rounded-lg border border-line p-3 space-y-1" data-testid="billing-quote-result">
                {q.lines.map((l) => <p key={l.code} className="text-xs">{l.name}: {l.current} → {l.next}{l.chargeNowQty > 0 ? ` · ${t("חיוב עכשיו", "charged now")} ${ils(l.chargeNowMinor)}${q.prorated ? t(" (יחסי לתקופה)", " (prorated)") : ""}` : ""}{l.changeAtRenewal !== null ? ` · ${t(`ירידה בתוקף מ-${d(q.reductionsEffectiveAt)}`, `reduction from ${d(q.reductionsEffectiveAt)}`)}` : ""}</p>)}
                <p className="text-sm font-semibold">{t("לתשלום עכשיו", "Due now")}: {ils(q.totalMinor)} <span className="text-xs font-normal text-muted">({ils(q.subtotalMinor)} + {t("מע״מ", "VAT")} {ils(q.taxMinor)})</span></p>
                <p className="text-xs text-muted">{t("חודשי אחרי השינוי", "Monthly after the change")}: {ils(q.monthlyAfterChangeMinor)} + {t("מע״מ", "VAT")} {ils(q.monthlyTaxMinor)} · {q.note}</p>
                <Button size="sm" onClick={confirm} loading={busy === "c"} disabled={!ov.provider} data-testid="billing-confirm">{q.totalMinor > 0 ? t(`אישור ותשלום ${ils(q.totalMinor)}`, `Confirm & pay ${ils(q.totalMinor)}`) : t("אישור השינוי", "Confirm change")}</Button>
              </div>
            )}
          </div>
        </Panel>
      )}

      {lic && (
        <Panel title={t("הקצאת רישיונות לעובדים", "Assign licenses")}>
          <p className="text-xs text-muted mb-2">{t("רישיון אחד = אדם אחד בכל רגע. העברה בין עובדים לא דורשת רכישה. בעל העסק מנהל, צופה ומשלם בלי רישיון – עבודה כנציג דורשת רישיון.", "One license = one person at a time. Moving it needs no purchase. The owner manages, views and pays without a license – working as an agent needs one.")}</p>
          <div className="overflow-x-auto"><table className="w-full text-xs min-w-[520px]" data-testid="billing-licenses"><thead className="text-muted"><tr><th className="text-start py-1">{t("עובד", "Employee")}</th>{lic.licenses.filter((l) => l.seats !== null).map((l) => <th key={l.module} className="text-start">{MODULE[l.module]} ({l.used}/{l.seats})</th>)}</tr></thead>
            <tbody className="divide-y divide-line">{lic.users.map((u) => <tr key={u.id}><td className="py-1">{u.fullName}{u.role === "owner" ? t(" (בעלים)", " (owner)") : ""}</td>{lic.licenses.filter((l) => l.seats !== null).map((l) => { const has = l.holders.some((h) => h.id === u.id); return <td key={l.module}><input type="checkbox" checked={has} onChange={(e) => setLicense(u.id, l.module, e.target.checked)} aria-label={`${u.fullName} ${MODULE[l.module]}`} /></td>; })}</tr>)}</tbody></table></div>
        </Panel>
      )}

      <Panel title={t("שימוש", "Usage")} actions={<div className="flex items-center gap-2"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-40" ltr aria-label={t("חודש", "Month")} /><a className="text-xs underline" href={`/api/billing/usage/export?month=${month}`} data-testid="billing-usage-export">{t("ייצוא CSV", "Export CSV")}</a></div>}>
        {!usage ? <Spinner /> : (
          <div className="space-y-2 text-sm" data-testid="billing-usage">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div><p className="text-xs text-muted">{t("חיובים סופיים", "Final charges")}</p><p className="font-semibold">{ils(usage.finalMinor)}</p></div>
              <div><p className="text-xs text-muted">{t("הערכות (טרם סופי)", "Estimates (not final)")}</p><p className="font-semibold">{ils(usage.estimatedMinor)}</p></div>
              <div><p className="text-xs text-muted">{t("תחזית לחודש", "Month forecast")}</p><p className="font-semibold">{ils(usage.forecastMinor)}</p><p className="text-[11px] text-muted">{usage.forecastNote}</p></div>
              <div><p className="text-xs text-muted">{t("אירועים ללא תעריף", "Unrated events")}</p><p className="font-semibold">{usage.unratedEvents}</p>{usage.unratedEvents > 0 && <p className="text-[11px] text-warn">{t("לא מחויבים ולא מוצגים כאפס – ממתינים לתעריף", "Not charged and not shown as zero – awaiting a rate")}</p>}</div>
            </div>
            <div className="overflow-x-auto"><table className="w-full text-xs min-w-[560px]"><thead className="text-muted"><tr><th className="text-start py-1">{t("מודול", "Module")}</th><th className="text-start">{t("שירות", "Service")}</th><th className="text-start">{t("מצב", "Status")}</th><th className="text-start">{t("כמות", "Quantity")}</th><th className="text-start">{t("מחויב", "Billed")}</th><th className="text-start">{t("מחיר", "Price")}</th></tr></thead>
              <tbody className="divide-y divide-line">{usage.lines.length === 0 ? <tr><td colSpan={6} className="py-3 text-center text-muted">{t("אין שימוש בחודש הזה", "No usage this month")}</td></tr> : usage.lines.map((l, i) => <tr key={i}><td className="py-1">{MODULE[l.module] ?? l.module}</td><td>{l.service}</td><td>{STATUS[l.status] ?? l.status}{l.billedByProvider ? t(" · נגבה ישירות ע״י הספק", " · billed by the provider") : ""}</td><td className="tabular-nums">{l.quantity.toFixed(2)} {l.unit}</td><td className="tabular-nums">{l.billedQuantity === null ? "—" : l.billedQuantity.toFixed(2)}</td><td className="tabular-nums">{ils(l.priceMinor)}</td></tr>)}</tbody></table></div>
          </div>
        )}
      </Panel>

      {budget && (
        <Panel title={t("תקציב חודשי", "Monthly budget")}>
          <div className="space-y-2 text-sm" data-testid="billing-budget">
            <p>{t("שימוש החודש (כולל שריונים לפעולות בתהליך)", "This month (incl. holds for actions in progress)")}: <b>{ils(spent)}</b>{budget.policy.monthlyCapMinor ? ` / ${ils(budget.policy.monthlyCapMinor)} (${Math.round((spent / budget.policy.monthlyCapMinor) * 100)}%)` : ""}</p>
            <div className="flex flex-wrap items-end gap-2"><Input label={t("תקרה חודשית (₪, ריק = ללא)", "Monthly cap (₪, empty = none)")} value={cap} onChange={(e) => setCap(e.target.value)} className="w-48" ltr /><Select label={t("בהגעה לתקרה", "At the cap")} value={budget.policy.hardStop ? "stop" : "alert"} onChange={(e) => setBudget({ ...budget, policy: { ...budget.policy, hardStop: e.target.value === "stop" } })} className="w-64"><option value="stop">{t("לעצור פעולות יוצאות חדשות בתשלום", "Stop new outbound paid actions")}</option><option value="alert">{t("התראה בלבד", "Alert only")}</option></Select><Button size="sm" onClick={saveBudget} data-testid="billing-budget-save">{t("שמור", "Save")}</Button></div>
            <p className="text-xs text-muted">{t(`התראות ב-${budget.policy.alertPercents.join("%, ")}%. בעצירה: שיחה פעילה לא מנותקת, שיחות והודעות נכנסות, בקשות הסרה ורישום אירועים ממשיכים – והם עשויים עדיין לעלות כסף (למשל שיחה נכנסת או שיחה שכבר התחילה).`, `Alerts at ${budget.policy.alertPercents.join("%, ")}%. When stopped: an active call is not cut; inbound calls / messages, opt-outs and event logging continue – and may still cost (e.g. an inbound call or a call already started).`)}</p>
          </div>
        </Panel>
      )}

      <Panel title={t("מסמכי חיוב", "Billing documents")}>
        {ov.documents.length === 0 ? <p className="text-sm text-muted">{t("אין מסמכים עדיין.", "No documents yet.")}</p> : (
          <div className="overflow-x-auto"><table className="w-full text-xs min-w-[560px]" data-testid="billing-documents"><thead className="text-muted"><tr><th className="text-start py-1">{t("מספר", "Number")}</th><th className="text-start">{t("סוג", "Kind")}</th><th className="text-start">{t("תקופה", "Period")}</th><th className="text-start">{t("סכום (כולל מע״מ)", "Total (incl. VAT)")}</th><th className="text-start">{t("מצב", "Status")}</th></tr></thead>
            <tbody className="divide-y divide-line">{ov.documents.map((x) => <tr key={x.id}><td className="py-1 ltr text-start">{x.number}</td><td>{({ initial: "רכישה", renewal: "חידוש", proration: "תוספת יחסית", credit: "זיכוי", usage: "שימוש" } as Record<string, string>)[x.kind] ?? x.kind}</td><td>{d(x.periodStart)} – {d(x.periodEnd)}</td><td className="tabular-nums">{ils(x.totalMinor)}</td><td>{x.status === "paid" ? t("שולם", "Paid") : x.status === "failed" ? t("נכשל", "Failed") : x.status === "open" ? <>{t("ממתין לתשלום", "Awaiting payment")}{x.checkoutUrl && <a className="underline ms-1" href={x.checkoutUrl}>{t("לתשלום", "Pay")}</a>}</> : x.status}</td></tr>)}</tbody></table></div>
        )}
        <p className="text-xs mt-2"><a className="underline" href="/settings/offboarding">{t("ייצוא נתונים וסיום התקשרות", "Export data & offboarding")}</a></p>
        <p className="text-[11px] text-muted mt-2">{t("אישור תשלום מהספק אינו קבלה או חשבונית מס. מסמך שהופק אינו משתנה – תיקון נעשה במסמך זיכוי.", "A provider payment confirmation is not a receipt or tax invoice. An issued document never changes – a correction is a credit document.")}</p>
      </Panel>
    </div>
  );
}
