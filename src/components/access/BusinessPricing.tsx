"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Select, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Discount { type: "fixed" | "percent"; amountMinor?: number; bps?: number; startsAt: string; endsAt?: string | null; note?: string }
interface Terms { licensePrices: Record<string, number>; discount: Discount | null; usageRates: Record<string, number> }
interface Priced { lines: Array<{ code: string; name: string; quantity: number; unitPriceMinor: number; amountMinor: number; basePriceMinor?: number }>; licensesMinor: number; discountMinor: number; discountLabel: string | null; creditMinor: number; netMinor: number; taxMinor: number; totalMinor: number }
interface Preview { subscription: { status: string; nextRenewalAt: string } | null; basis: string; currentVersion: number | null; before: Priced; after: Priced; deltaMinor: number; warnings: string[] }
interface Overview {
  priceBook: { version: number; taxRateBps: number; items: Array<{ code: string; name: string; unitPriceMinor: number; kind: string }>; rates: Array<{ service: string; unitPriceMinor: number | null }> } | null;
  services: Array<{ service: string; label: string; unit: string }>;
  current: { version: number | null; terms: Terms };
  versions: Array<{ id: string; version: number; effectiveFrom: string; licensePrices: Record<string, number>; discount: Discount | null; usageRates: Record<string, number>; note: string | null; createdAt: string }>;
  credits: Array<{ id: string; amountMinor: number; remainingMinor: number; reason: string; cancelledAt: string | null; createdAt: string; applied: unknown[] }>;
  log: Array<{ id: string; action: string; createdAt: string; after: unknown }>;
}
const ils = (m: number) => `₪${(m / 100).toLocaleString("he-IL", { minimumFractionDigits: m % 100 ? 2 : 0 })}`;
const toMinor = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Platform admin → business card → custom pricing. Module / license prices, ONE recurring discount (fixed ₪ or %),
 * usage rates, and one-time credits – each change previewed against the next bill before it is saved as a new
 * version (old versions, issued documents and recorded usage are never rewritten).
 */
export function BusinessPricing({ businessId }: { businessId: string }) {
  const t = useT();
  const [o, setO] = useState<Overview | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const [dType, setDType] = useState<"none" | "fixed" | "percent">("none");
  const [dValue, setDValue] = useState("");
  const [dStart, setDStart] = useState(today());
  const [dEnd, setDEnd] = useState("");
  const [dNote, setDNote] = useState("");
  const [effective, setEffective] = useState(today());
  const [note, setNote] = useState("");
  const [credit, setCredit] = useState({ amount: "", reason: "" });
  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get<Overview>(`/api/platform/businesses/${businessId}/pricing`); setO(r);
      const c = r.current.terms;
      setPrices(Object.fromEntries(Object.entries(c.licensePrices).map(([k, v]) => [k, String(v / 100)])));
      setRates(Object.fromEntries(Object.entries(c.usageRates).map(([k, v]) => [k, String(v / 100)])));
      if (c.discount) { setDType(c.discount.type); setDValue(c.discount.type === "fixed" ? String((c.discount.amountMinor ?? 0) / 100) : String((c.discount.bps ?? 0) / 100)); setDStart(c.discount.startsAt.slice(0, 10)); setDEnd(c.discount.endsAt?.slice(0, 10) ?? ""); setDNote(c.discount.note ?? ""); } else setDType("none");
    } catch (e) { toast.error((e as Error).message); }
  }, [businessId]);
  useEffect(() => { void load(); }, [load]);

  const terms: Terms = useMemo(() => ({
    licensePrices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, toMinor(v)]).filter(([, v]) => v !== null)) as Record<string, number>,
    usageRates: Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, toMinor(v)]).filter(([, v]) => v !== null)) as Record<string, number>,
    discount: dType === "none" || !dValue ? null : { type: dType, ...(dType === "fixed" ? { amountMinor: Math.round(Number(dValue) * 100) } : { bps: Math.round(Number(dValue) * 100) }), startsAt: new Date(`${dStart}T00:00:00`).toISOString(), endsAt: dEnd ? new Date(`${dEnd}T00:00:00`).toISOString() : null, ...(dNote ? { note: dNote } : {}) },
  }), [prices, rates, dType, dValue, dStart, dEnd, dNote]);
  const creditMinor = toMinor(credit.amount) ?? 0;
  const key = JSON.stringify({ terms, creditMinor });
  const previewed = preview?.key === key;

  async function runPreview() {
    setBusy("preview");
    try { setPreview({ key, data: await api.post<Preview>(`/api/platform/businesses/${businessId}/pricing/preview`, { terms, creditMinor }) }); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function save() {
    if (!preview || !previewed) return;
    setBusy("save");
    try {
      const from = effective === today() ? new Date().toISOString() : new Date(`${effective}T00:00:00`).toISOString();
      const r = await api.post<{ version: number }>(`/api/platform/businesses/${businessId}/pricing`, { terms, effectiveFrom: from, note: note || undefined, expectedTotalMinor: preview.data.after.totalMinor, creditMinor });
      toast.success(t(`נשמרה גרסת תמחור ${r.version}`, `Pricing version ${r.version} saved`)); setPreview(null); await load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function addCredit() {
    if (!previewed || !creditMinor) return;
    setBusy("credit");
    try { await api.post(`/api/platform/businesses/${businessId}/pricing/credits`, { amountMinor: creditMinor, reason: credit.reason }); toast.success(t("הזיכוי נוסף – ינוצל בחיוב הבא", "Credit added – used on the next bill")); setCredit({ amount: "", reason: "" }); setPreview(null); await load(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function cancelCredit(id: string) {
    try { await api.delete(`/api/platform/businesses/${businessId}/pricing/credits/${id}`); await load(); } catch (e) { toast.error((e as Error).message); }
  }
  if (!o) return <Panel title={t("תמחור מותאם", "Custom pricing")}><Spinner /></Panel>;
  const baseRate = (svc: string) => o.priceBook?.rates.find((r) => r.service === svc)?.unitPriceMinor ?? null;

  return (
    <Panel title={<span className="flex items-center gap-2">{t("תמחור מותאם", "Custom pricing")}{o.current.version ? <Badge tone="info">{t(`גרסה ${o.current.version} בתוקף`, `Version ${o.current.version} in force`)}</Badge> : <Badge>{t("לפי המחירון", "Price book")}</Badge>}</span>}>
      <div className="space-y-4 text-sm" data-testid="business-pricing">
        {!o.priceBook && <p className="text-warn">{t("אין מחירון מפורסם – אפשר לשמור תמחור, והוא יחול כשיהיה מחירון ומנוי.", "No published price book – pricing can be saved and applies once there is one and a subscription.")}</p>}
        <p className="text-xs text-muted">{t("סדר החישוב: מחיר רישיון (מותאם או מהמחירון) → הנחה חוזרת אחת (קבועה או אחוז, עד 0) → זיכויים חד-פעמיים (עד 0) → מע״מ. שינוי חל מהמועד שנבחר והלאה – חשבוניות ושימוש שכבר נרשמו לא משתנים.", "Order: license price (custom or price book) → one recurring discount (fixed or %, down to 0) → one-time credits (down to 0) → VAT. A change applies from the chosen date on – issued invoices and recorded usage never change.")}</p>

        <section><h4 className="mb-1 font-medium">{t("דמי מודול ורישיונות (לחודש, לפני מע״מ)", "Module & license fees (monthly, before VAT)")}</h4>
          <table className="w-full text-xs"><thead className="text-muted"><tr><th className="text-start">{t("פריט", "Item")}</th><th className="text-start">{t("מחירון", "Price book")}</th><th className="text-start">{t("מחיר מותאם (₪)", "Custom price (₪)")}</th></tr></thead>
            <tbody>{(o.priceBook?.items ?? []).map((it) => <tr key={it.code} className="border-t border-line"><td className="py-1">{it.name}</td><td>{ils(it.unitPriceMinor)}{it.kind === "per_license" ? t(" לרישיון", " / license") : t(" לעסק", " / business")}</td><td><input className="h-8 w-28 rounded-md border border-line px-2 ltr" inputMode="decimal" placeholder={t("כמו המחירון", "As price book")} value={prices[it.code] ?? ""} onChange={(e) => setPrices({ ...prices, [it.code]: e.target.value })} data-testid={`pricing-license-${it.code}`} /></td></tr>)}</tbody></table>
        </section>

        <section><h4 className="mb-1 font-medium">{t("הנחה חוזרת (חודשית)", "Recurring discount (monthly)")}</h4>
          <div className="flex flex-wrap items-end gap-2">
            <Select aria-label={t("סוג הנחה", "Discount type")} value={dType} onChange={(e) => setDType(e.target.value as typeof dType)} className="w-40" data-testid="pricing-discount-type"><option value="none">{t("ללא הנחה", "No discount")}</option><option value="fixed">{t("סכום קבוע (₪)", "Fixed amount (₪)")}</option><option value="percent">{t("אחוז", "Percent")}</option></Select>
            {dType !== "none" && <>
              <Input label={dType === "fixed" ? t("₪ לחודש", "₪ per month") : t("% מסכום הרישיונות", "% of licenses")} value={dValue} onChange={(e) => setDValue(e.target.value)} className="w-28" ltr inputMode="decimal" data-testid="pricing-discount-value" />
              <Input label={t("מתחיל", "Starts")} type="date" value={dStart} onChange={(e) => setDStart(e.target.value)} className="w-40" ltr />
              <Input label={t("מסתיים (ריק = ללא)", "Ends (empty = none)")} type="date" value={dEnd} min={dStart} onChange={(e) => setDEnd(e.target.value)} className="w-40" ltr />
              <Input label={t("סיבה / הערה", "Reason / note")} value={dNote} onChange={(e) => setDNote(e.target.value)} className="w-56" />
            </>}
          </div>
          {dType !== "none" && <p className="mt-1 text-xs text-muted">{t("בסיס ההנחה: סכום הרישיונות החודשי של העסק (לפני מע״מ, לפני זיכויים). הנחה אחת בלבד בכל גרסה – לא נצברת עם הנחה קודמת.", "Discount base: the business's monthly licenses total (before VAT and credits). One discount per version – it never stacks with an earlier one.")}</p>}
        </section>

        <section><h4 className="mb-1 font-medium">{t("תעריפי שימוש מותאמים", "Custom usage rates")}</h4>
          <table className="w-full text-xs"><thead className="text-muted"><tr><th className="text-start">{t("שירות", "Service")}</th><th className="text-start">{t("מחירון", "Price book")}</th><th className="text-start">{t("תעריף מותאם (₪ ליחידה)", "Custom rate (₪ / unit)")}</th></tr></thead>
            <tbody>{o.services.map((s) => { const b = baseRate(s.service); return <tr key={s.service} className="border-t border-line"><td className="py-1">{s.label}</td><td>{b === null ? t("ללא תעריף", "Unrated") : ils(b)}</td><td><input className="h-8 w-28 rounded-md border border-line px-2 ltr" inputMode="decimal" placeholder={t("כמו המחירון", "As price book")} value={rates[s.service] ?? ""} onChange={(e) => setRates({ ...rates, [s.service]: e.target.value })} /></td></tr>; })}</tbody></table>
          <p className="mt-1 text-xs text-muted">{t("שינוי מחיר שימוש חל רק על שימוש שיירשם מהמועד שנבחר.", "A usage price change applies only to usage recorded from the chosen date.")}</p>
        </section>

        <section className="grid gap-2 sm:grid-cols-3">
          <Input label={t("בתוקף מ-", "Effective from")} type="date" min={today()} value={effective} onChange={(e) => setEffective(e.target.value)} ltr />
          <Input label={t("הערה לגרסה", "Version note")} value={note} onChange={(e) => setNote(e.target.value)} className="sm:col-span-2" />
        </section>

        <section className="rounded-lg border border-line p-2"><h4 className="mb-1 font-medium">{t("זיכוי חד-פעמי", "One-time credit")}</h4>
          <div className="flex flex-wrap items-end gap-2"><Input label={t("₪", "₪")} value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} className="w-28" ltr inputMode="decimal" data-testid="pricing-credit-amount" /><Input label={t("סיבה", "Reason")} value={credit.reason} onChange={(e) => setCredit({ ...credit, reason: e.target.value })} className="w-64" /></div>
          <p className="mt-1 text-xs text-muted">{t("מנוצל בחיוב הבא בלבד (לא חוזר). אם גדול מהחיוב – היתרה נשארת לחיוב שאחריו, ואף פעם לא מתחת ל-0.", "Used on the next bill only (not recurring). If larger than the bill, the rest stays for the one after – never below 0.")}</p>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={runPreview} loading={busy === "preview"} data-testid="pricing-preview">{t("תצוגה מקדימה של החיוב הבא", "Preview the next bill")}</Button>
          <Button onClick={save} disabled={!previewed} loading={busy === "save"} data-testid="pricing-save">{t("שמור גרסת תמחור", "Save pricing version")}</Button>
          {creditMinor > 0 && <Button variant="secondary" onClick={addCredit} disabled={!previewed || credit.reason.trim().length < 2} loading={busy === "credit"} data-testid="pricing-credit-add">{t("הוסף זיכוי", "Add credit")}</Button>}
          {!previewed && <span className="self-center text-xs text-muted">{t("יש להציג תצוגה מקדימה לפני שמירה", "Preview before saving")}</span>}
        </div>

        {preview && <PreviewView p={preview.data} stale={!previewed} />}

        {o.credits.length > 0 && <section><h4 className="mb-1 font-medium">{t("זיכויים", "Credits")}</h4><ul className="space-y-1 text-xs">{o.credits.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2"><span>{ils(c.amountMinor)} · {c.reason}</span><span className="text-muted">{t(`נותר ${ils(c.remainingMinor)}`, `${ils(c.remainingMinor)} left`)}</span>{c.cancelledAt ? <Badge>{t("בוטל", "Cancelled")}</Badge> : c.applied.length === 0 && <button type="button" className="underline" onClick={() => void cancelCredit(c.id)}>{t("בטל", "Cancel")}</button>}</li>)}</ul></section>}
        {o.versions.length > 0 && <section><h4 className="mb-1 font-medium">{t("גרסאות", "Versions")}</h4><ul className="space-y-1 text-xs" data-testid="pricing-versions">{o.versions.map((v) => <li key={v.id}>{t(`גרסה ${v.version}`, `Version ${v.version}`)} · {t("בתוקף מ-", "from")} {new Date(v.effectiveFrom).toLocaleDateString("he-IL")}{v.discount ? ` · ${v.discount.type === "fixed" ? t(`הנחה ${ils(v.discount.amountMinor ?? 0)}`, `discount ${ils(v.discount.amountMinor ?? 0)}`) : t(`הנחה ${(v.discount.bps ?? 0) / 100}%`, `discount ${(v.discount.bps ?? 0) / 100}%`)}` : ""}{Object.keys(v.licensePrices).length ? ` · ${t(`${Object.keys(v.licensePrices).length} מחירי רישיון`, `${Object.keys(v.licensePrices).length} license prices`)}` : ""}{Object.keys(v.usageRates).length ? ` · ${t(`${Object.keys(v.usageRates).length} תעריפי שימוש`, `${Object.keys(v.usageRates).length} usage rates`)}` : ""}{v.note ? ` · ${v.note}` : ""}</li>)}</ul></section>}
        {o.log.length > 0 && <details className="text-xs"><summary className="cursor-pointer">{t("יומן ביקורת", "Audit log")}</summary><ul className="mt-1 space-y-1">{o.log.map((l) => <li key={l.id}>{new Date(l.createdAt).toLocaleString("he-IL")} · {l.action}</li>)}</ul></details>}
      </div>
    </Panel>
  );
}

function PreviewView({ p, stale }: { p: Preview; stale: boolean }) {
  const t = useT();
  const col = (x: Priced) => <ul className="space-y-0.5">{x.lines.map((l) => <li key={l.code}>{l.name} × {l.quantity} = {ils(l.amountMinor)}{l.basePriceMinor !== undefined ? <span className="text-muted"> ({t("במקום", "instead of")} {ils(l.basePriceMinor * l.quantity)})</span> : null}</li>)}
    {x.discountMinor > 0 && <li className="text-good">{x.discountLabel}: −{ils(x.discountMinor)}</li>}
    {x.creditMinor > 0 && <li className="text-good">{t("זיכוי", "Credit")}: −{ils(x.creditMinor)}</li>}
    <li>{t("לפני מע״מ", "Before VAT")}: {ils(x.netMinor)} · {t("מע״מ", "VAT")} {ils(x.taxMinor)}</li><li className="font-semibold">{t("סה״כ", "Total")}: {ils(x.totalMinor)}</li></ul>;
  return (
    <div className={`rounded-lg border p-3 text-xs ${stale ? "border-warn opacity-60" : "border-accent/40"}`} data-testid="pricing-preview-result">
      <p className="mb-1">{p.basis}{p.subscription ? t(` · החיוב הבא: ${new Date(p.subscription.nextRenewalAt).toLocaleDateString("he-IL")}`, ` · next bill: ${new Date(p.subscription.nextRenewalAt).toLocaleDateString("en-GB")}`) : ""}{stale ? t(" · השתנו נתונים מאז – יש להציג שוב", " · changed since – preview again") : ""}</p>
      <div className="grid gap-3 sm:grid-cols-2"><div><b>{t("היום", "Now")}</b>{col(p.before)}</div><div><b>{t("אחרי השינוי", "After the change")}</b>{col(p.after)}</div></div>
      <p className="mt-2 font-medium" data-testid="pricing-delta">{t("השפעה על החיוב הבא:", "Effect on the next bill:")} {p.deltaMinor === 0 ? t("ללא שינוי", "none") : `${p.deltaMinor < 0 ? "−" : "+"}${ils(Math.abs(p.deltaMinor))}`}</p>
      {p.warnings.map((w) => <p key={w} className="text-warn">{w}</p>)}
    </div>
  );
}
