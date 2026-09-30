"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";

type Access = { orders: boolean; customers: boolean; products: boolean; webhooksRead: boolean; webhooksWrite: boolean | null } | null;
type Res = { page: number; totalPages: number | null; total: number | null; done: number; failed: number; finished: boolean };
interface Health {
  api: { status: string; checkedAt: string | null; error: string | null; access: Access };
  webhooks: { status: string; error: string | null; lastVerifiedEventAt: string | null; note: string | null; manual: null | { deliveryUrl: string; secret: string | null; apiVersion: string; topics: Array<{ topic: string; label: string }> } };
  sync: null | { mode: string; status: string; resources: Partial<Record<"customers" | "products" | "orders", Res>>; startedAt: string; finishedAt: string | null; error: string | null; nextAt: string | null; errors: string[] };
  lastSyncAt: string | null; lastSyncError: string | null;
  events: { failed: number; pending: number; recentFailures: Array<{ id: string; topic: string; resourceId: string | null; error: string | null; receivedAt: string }> };
  sources: Record<"payments" | "receipts" | "shipping" | "bundles", { status: string; detail: string[]; note?: string }>;
  freshness: { fresh: boolean; asOf: string | null };
  actions: string[];
}
const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "—");
const API_LABEL: Record<string, string> = { none: "לא חובר", ok: "תקין", failed: "נכשל" };
const HOOK_LABEL: Record<string, string> = { none: "לא הוגדר", waiting_verification: "הוגדר – ממתין לאימות", verified: "תקין (התקבל אירוע חתום)", manual_required: "נדרשת הגדרה ידנית", failed: "נכשל" };
const RES_LABEL = { customers: "לקוחות", products: "מוצרים", orders: "הזמנות" } as const;
const tone = (s: string) => (["ok", "verified", "done", "seen", "links_seen"].includes(s) ? "text-good" : ["failed", "error"].includes(s) ? "text-bad" : "text-warn");

/** WooCommerce: credentials (with exact key instructions) + a status panel where every part stands on its own. */
export function WooConnection({ storeId, siteHint }: { storeId: string; siteHint: string }) {
  const t = useT();
  const [h, setH] = useState<Health | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [site, setSite] = useState(siteHint); const [ck, setCk] = useState(""); const [cs, setCs] = useState("");
  const [scope, setScope] = useState({ orders: "365" as "none" | "30" | "90" | "365" | "all", customers: true, products: true });
  const [preview, setPreview] = useState<Partial<Record<"customers" | "products" | "orders", number | null>> | null>(null);
  const load = useCallback(async (reveal = false) => { try { setH(await api.get<Health>(`/api/stores/${storeId}/woo${reveal ? "?reveal=1" : ""}`)); } catch (e) { toast.error((e as Error).message); } }, [storeId]);
  useEffect(() => { void load(); }, [load]);
  const act = async (action: string, body: Record<string, unknown> = {}, label = action) => {
    setBusy(label);
    try { const r = await api.post<Health & { counts?: typeof preview }>(`/api/stores/${storeId}/woo`, { action, ...body }); if (r.counts) setPreview(r.counts); else setH(r); return r; }
    catch (e) { toast.error((e as Error).message); await load(); return null; } finally { setBusy(null); }
  };
  // While an import / reconcile runs and this screen is open, keep it moving (the job continues it too).
  const running = h?.sync?.status === "running";
  const stepping = useRef(false);
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(async () => { if (stepping.current || document.visibilityState !== "visible") return; stepping.current = true; try { setH(await api.post<Health>(`/api/stores/${storeId}/woo`, { action: "step" })); } catch { /* next tick */ } finally { stepping.current = false; } }, 4000);
    return () => clearInterval(iv);
  }, [running, storeId]);

  async function connect() {
    setBusy("connect");
    try {
      const r = await api.post<{ access: Access; problems: string[]; webhookStatus: string; failed: string[] }>(`/api/stores/${storeId}/connect-api`, { siteUrl: site, consumerKey: ck, consumerSecret: cs });
      setCk(""); setCs("");
      toast.success(r.webhookStatus === "manual_required" ? t("החיבור ל-API תקין. למפתח אין הרשאת כתיבה – הגדר את ה-Webhooks ידנית לפי ההנחיות", "API OK. The key has no write permission – set up the webhooks manually") : t("החיבור נבדק ונשמר", "Connection verified and saved"));
      await load(r.webhookStatus === "manual_required");
    } catch (e) { toast.error((e as Error).message); await load(); } finally { setBusy(null); }
  }

  if (!h) return <p className="wz-hint">{t("טוען מצב חיבור…", "Loading connection status…")}</p>;
  const a = h.api.access;
  return (
    <section className="carts-api space-y-3" data-testid="woo-connection">
      <h3>WooCommerce – {t("חיבור ומצב", "Connection & status")} {h.freshness.fresh ? <span className="cmp-badge sent">{t("מעודכן", "Current")}</span> : <span className="cmp-badge">{t("לא מעודכן", "Not current")}</span>}</h3>
      {h.actions.length > 0 && <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="woo-actions"><b>{t("פעולות נדרשות:", "Actions needed:")}</b><ul className="list-disc ps-5">{h.actions.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}

      <details open={h.api.status !== "ok"} className="rounded border p-2" data-testid="woo-api">
        <summary className="cursor-pointer text-sm"><b>{t("1. הרשאות וגישה ל-API", "1. API access")}</b> · <span className={tone(h.api.status)}>{API_LABEL[h.api.status] ?? h.api.status}</span>{h.api.checkedAt ? ` · ${t("נבדק", "checked")} ${when(h.api.checkedAt)}` : ""}</summary>
        {a && <p className="text-xs mt-1" data-testid="woo-access">{t("הזמנות", "Orders")} {a.orders ? "✓" : "✗"} · {t("לקוחות", "Customers")} {a.customers ? "✓" : "✗"} · {t("מוצרים", "Products")} {a.products ? "✓" : "✗"} · Webhooks {a.webhooksRead ? "✓" : "✗"} · {t("יצירת Webhooks", "Create webhooks")} {a.webhooksWrite === null ? "—" : a.webhooksWrite ? "✓" : "✗"}</p>}
        {h.api.error && <p className="text-xs text-bad mt-1" data-testid="woo-api-error">{h.api.error}</p>}
        <ol className="wz-hint list-decimal ps-5 mt-1 space-y-0.5">
          <li>{t("בלוח הבקרה של WordPress: WooCommerce → Settings → Advanced → REST API → Add key.", "In WordPress: WooCommerce → Settings → Advanced → REST API → Add key.")}</li>
          <li>{t("User: משתמש בתפקיד Administrator או Shop manager. Permissions:", "User: an Administrator or Shop manager. Permissions:")} <b>Read/Write</b> {t("– הכתיבה נדרשת רק כדי שניצור את ה-Webhooks בשבילך (לא נשנה הזמנות). עם Read בלבד החיבור יעבוד, וה-Webhooks יוגדרו ידנית.", "– write is needed only so we can create the webhooks for you (we never change orders). With Read only it works, and the webhooks are set up manually.")}</li>
          <li>{t("העתק את Consumer key ו-Consumer secret (מוצגים פעם אחת בלבד). הם שונים מסוד ה-Webhook – את הסוד אנחנו יוצרים.", "Copy the Consumer key and Consumer secret (shown once). They are not the webhook secret – we generate that.")}</li>
        </ol>
        <div className="carts-api-grid mt-1">
          <label className="wz-field"><span className="wz-label">{t("כתובת האתר", "Site URL")}</span><input dir="ltr" value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://shop.example.com" data-testid="woo-site" /></label>
          <label className="wz-field"><span className="wz-label">Consumer key</span><input dir="ltr" type="password" autoComplete="off" value={ck} onChange={(e) => setCk(e.target.value)} placeholder="ck_…" data-testid="woo-ck" /></label>
          <label className="wz-field"><span className="wz-label">Consumer secret</span><input dir="ltr" type="password" autoComplete="off" value={cs} onChange={(e) => setCs(e.target.value)} placeholder="cs_…" data-testid="woo-cs" /></label>
        </div>
        <div className="flex flex-wrap gap-2 mt-1">
          <button className="wz-btn primary" disabled={!!busy || !site.trim() || ck.trim().length < 8 || cs.trim().length < 8} onClick={() => void connect()} data-testid="woo-connect">{busy === "connect" ? t("בודק…", "Checking…") : h.api.status === "ok" ? t("החלף מפתחות ובדוק", "Replace keys and check") : t("חבר ובדוק", "Connect and check")}</button>
          {h.api.status !== "none" && <button className="wz-btn ghost" disabled={!!busy} onClick={() => void act("test")} data-testid="woo-test">{busy === "test" ? t("בודק…", "Checking…") : t("בדיקת חיבור", "Test connection")}</button>}
        </div>
        <p className="wz-hint">{t("המפתחות נשמרים מוצפנים בשרת ולא מוצגים שוב. החלפת מפתחות אינה מוחקת נתונים.", "Keys are stored encrypted on the server and never shown again. Replacing keys deletes nothing.")}</p>
      </details>

      <details open={h.webhooks.status !== "verified"} className="rounded border p-2" data-testid="woo-webhooks">
        <summary className="cursor-pointer text-sm"><b>{t("2. Webhooks (עדכונים בזמן אמת)", "2. Webhooks (live updates)")}</b> · <span className={tone(h.webhooks.status)}>{HOOK_LABEL[h.webhooks.status] ?? h.webhooks.status}</span> · {t("אירוע מאומת אחרון:", "Last verified event:")} {when(h.webhooks.lastVerifiedEventAt)}</summary>
        {h.webhooks.note && <p className="wz-hint">{h.webhooks.note}</p>}
        {h.webhooks.error && <p className="text-xs text-bad">{h.webhooks.error}</p>}
        {h.api.status === "ok" && <button className="wz-btn ghost mt-1" disabled={!!busy} onClick={() => void act("webhooks")} data-testid="woo-hooks">{busy === "webhooks" ? t("מגדיר…", "Setting up…") : t("הגדר / תקן Webhooks", "Set up / repair webhooks")}</button>}
        {h.webhooks.manual && <div className="mt-1 text-xs space-y-1" data-testid="woo-manual">
          <p>{t("הגדרה ידנית: WooCommerce → Settings → Advanced → Webhooks → Add webhook, פעם אחת לכל נושא:", "Manual setup: WooCommerce → Settings → Advanced → Webhooks → Add webhook, once per topic:")}</p>
          <p>Status: <b>Active</b> · API version: <b>{h.webhooks.manual.apiVersion}</b></p>
          <p>Delivery URL: <code dir="ltr" className="break-all">{h.webhooks.manual.deliveryUrl}</code></p>
          <p>Secret: {h.webhooks.manual.secret ? <code dir="ltr" className="break-all">{h.webhooks.manual.secret}</code> : <button className="underline" onClick={() => void load(true)}>{t("הצג סוד", "Show secret")}</button>}</p>
          <p>Topic: {h.webhooks.manual.topics.map((x) => x.label).join(" · ")}</p>
        </div>}
      </details>

      <details open={!h.lastSyncAt || running || h.sync?.status === "paused" || h.sync?.status === "error"} className="rounded border p-2" data-testid="woo-sync">
        <summary className="cursor-pointer text-sm"><b>{t("3. ייבוא ראשוני וסנכרון", "3. Initial import & sync")}</b> · {h.sync ? <span className={tone(h.sync.status)}>{h.sync.mode === "initial" ? t("ייבוא", "Import") : t("השלמה", "Reconcile")}: {h.sync.status}</span> : t("טרם הורץ", "not run yet")} · {t("סנכרון מוצלח אחרון:", "Last successful sync:")} {when(h.lastSyncAt)}</summary>
        {h.sync && <ul className="text-xs mt-1" data-testid="woo-progress">{(Object.entries(h.sync.resources) as Array<[keyof typeof RES_LABEL, Res]>).map(([k, r]) => <li key={k}>{RES_LABEL[k]}: {r.done}{r.total ? ` / ${r.total}` : ""}{r.failed ? ` · ${r.failed} ${t("שגיאות", "errors")}` : ""}{r.finished ? " ✓" : ""}</li>)}</ul>}
        {h.sync?.error && <p className="text-xs text-bad">{h.sync.error}</p>}
        {h.sync?.nextAt && running && <p className="text-xs text-muted">{t("ממתין לפני ניסיון נוסף עד", "Waiting before retrying until")} {when(h.sync.nextAt)}</p>}
        {h.sync && h.sync.errors.length > 0 && <details className="text-xs"><summary>{t("שגיאות אחרונות", "Recent errors")}</summary><ul>{h.sync.errors.map((e, i) => <li key={i} dir="auto">{e}</li>)}</ul></details>}
        {h.api.status === "ok" && !running && <div className="mt-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label>{t("הזמנות:", "Orders:")} <select value={scope.orders} onChange={(e) => { setScope({ ...scope, orders: e.target.value as typeof scope.orders }); setPreview(null); }} data-testid="woo-scope-orders"><option value="30">{t("30 יום", "30 days")}</option><option value="90">{t("90 יום", "90 days")}</option><option value="365">{t("שנה", "1 year")}</option><option value="all">{t("הכול", "All")}</option><option value="none">{t("ללא", "None")}</option></select></label>
            <label><input type="checkbox" checked={scope.customers} onChange={(e) => { setScope({ ...scope, customers: e.target.checked }); setPreview(null); }} /> {t("לקוחות", "Customers")}</label>
            <label><input type="checkbox" checked={scope.products} onChange={(e) => { setScope({ ...scope, products: e.target.checked }); setPreview(null); }} /> {t("מוצרים", "Products")}</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="wz-btn ghost" disabled={!!busy} onClick={() => void act("preview", { scope })} data-testid="woo-preview">{busy === "preview" ? t("סופר…", "Counting…") : t("תצוגה מקדימה", "Preview")}</button>
            <button className="wz-btn primary" disabled={!!busy || !preview} onClick={() => void act("start", { scope })} data-testid="woo-start">{t("התחל ייבוא", "Start import")}</button>
            {(h.sync?.status === "paused" || h.sync?.status === "error") && <button className="wz-btn ghost" disabled={!!busy} onClick={() => void act("resume")} data-testid="woo-resume">{t("המשך מנקודת העצירה", "Resume")}</button>}
            {h.lastSyncAt && <button className="wz-btn ghost" disabled={!!busy} onClick={() => void act("sync_now")} data-testid="woo-sync-now">{t("סנכרן עכשיו", "Sync now")}</button>}
          </div>
          {preview && <p className="text-xs" data-testid="woo-preview-counts">{t("ייובאו:", "Will import:")} {(Object.entries(preview) as Array<[keyof typeof RES_LABEL, number | null]>).map(([k, v]) => `${RES_LABEL[k]} ${v ?? "?"}`).join(" · ")}. {t("ייבוא היסטורי אינו מפעיל הודעות, חיוג, קמפיינים או מסעות.", "A historical import triggers no messages, dialing, campaigns or journeys.")}</p>}
        </div>}
      </details>

      <details open={h.events.failed > 0} className="rounded border p-2" data-testid="woo-events">
        <summary className="cursor-pointer text-sm"><b>{t("4. כשלים", "4. Failures")}</b> · <span className={h.events.failed ? "text-bad" : "text-good"}>{h.events.failed} {t("נכשלו", "failed")}</span> · {h.events.pending} {t("בתור", "queued")}</summary>
        {h.events.recentFailures.length > 0 && <ul className="text-xs">{h.events.recentFailures.map((f) => <li key={f.id} dir="auto">{f.topic} #{f.resourceId ?? "?"} · {when(f.receivedAt)} · {f.error}</li>)}</ul>}
        {h.events.failed > 0 && <button className="wz-btn ghost mt-1" disabled={!!busy} onClick={() => void act("reprocess")} data-testid="woo-reprocess">{t("עבד מחדש", "Reprocess")}</button>}
      </details>

      <details className="rounded border p-2" data-testid="woo-sources">
        <summary className="cursor-pointer text-sm"><b>{t("5. מקורות נוספים", "5. Other sources")}</b></summary>
        <ul className="text-xs space-y-0.5">
          <li>{t("אישור תשלום (אינו קבלה):", "Payment confirmation (not a receipt):")} <span className={tone(h.sources.payments.status)}>{h.sources.payments.detail.join(", ") || t("טרם נראה", "not seen yet")}</span></li>
          <li>{t("קבלות:", "Receipts:")} <span className={tone(h.sources.receipts.status)}>{h.sources.receipts.status === "not_connected" ? t("לא מחובר", "not connected") : h.sources.receipts.detail.join(", ")}</span> {h.sources.receipts.note && <span className="text-muted">– {h.sources.receipts.note}</span>}</li>
          <li>{t("משלוחים:", "Shipping:")} <span className={tone(h.sources.shipping.status)}>{h.sources.shipping.status === "not_connected" ? t("לא מחובר", "not connected") : h.sources.shipping.detail.join(", ")}</span> {h.sources.shipping.note && <span className="text-muted">– {h.sources.shipping.note}</span>}</li>
          <li>{t("מארזים:", "Bundles:")} {h.sources.bundles.detail.join(", ") || t("טרם נראו", "not seen yet")}</li>
        </ul>
      </details>
    </section>
  );
}
