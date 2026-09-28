"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, ShoppingCart, Trash2, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";

type T = ((he: string, en: string) => string) & { lang: string };

type Store = { api?: { connectedAt: string; target: string; webhooks: string[] } | null; id: string; platform: "shopify" | "woocommerce" | "custom"; name: string; domain: string | null; publicKey: string; abandonAfterMinutes: number; isActive: boolean; lastEventAt: string | null; snippet: string; webhookUrl: string | null; webhookSecret: string | null; webhookSecretMasked: string | null };
type Cart = { id: string; status: string; email: string | null; phoneE164: string | null; customerName: string | null; currency: string | null; total: string | null; orderTotal: string | null; items: Array<{ name: string; quantity: number }>; checkoutUrl: string | null; lastActivityAt: string; abandonedAt: string | null; convertedAt: string | null; recoveryMessageAt: string | null; store: { name: string; platform: string }; contact: { id: string; fullName: string } | null };
type Stats = { open: number; abandoned: number; abandonedValue: number; recovered: number; recoveredValue: number; converted: number; recoveryRate: number | null };
const PLATFORM: Record<string, [string, string]> = { shopify: ["Shopify", "Shopify"], woocommerce: ["WooCommerce", "WooCommerce"], custom: ["אתר אחר", "Other website"] };
const STATUS: Record<string, [string, string]> = { open: ["פעילה", "Active"], abandoned: ["ננטשה", "Abandoned"], converted: ["נרכשה", "Purchased"], recovered: ["שוחזרה", "Recovered"] };
const money = (t: T, v: number | string | null, cur?: string | null) => v === null || v === "" ? "—" : `${Number(v).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL", { maximumFractionDigits: 2 })} ${cur ?? ""}`.trim();
const copy = async (text: string, t: T) => { try { await navigator.clipboard.writeText(text); toast.success(t("הועתק", "Copied")); } catch { toast.error(t("לא ניתן להעתיק", "Could not copy")); } };

/** "עגלות נטושות": connected stores (site script + Shopify / WooCommerce webhooks) and the carts they report. */
export function CartsScreen() {
  const t = useT();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [data, setData] = useState<{ items: Cart[]; total: number; stats: Stats } | null>(null);
  const [status, setStatus] = useState(""); const [q, setQ] = useState(""); const [days, setDays] = useState(30);
  const [setup, setSetup] = useState<Store | "new" | null>(null);
  const loadStores = useCallback(() => api.get<{ items: Store[] }>("/api/stores").then((r) => setStores(r.items)).catch(() => setStores([])), []);
  const loadCarts = useCallback(() => api.get<{ items: Cart[]; total: number; stats: Stats }>(`/api/carts?days=${days}${status ? `&status=${status}` : ""}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then(setData).catch(() => undefined), [days, status, q]);
  useEffect(() => { loadStores(); }, [loadStores]);
  useEffect(() => { const timer = setTimeout(loadCarts, 300); return () => clearTimeout(timer); }, [loadCarts]);
  const s = data?.stats;
  return (
    <div className="carts" data-testid="carts-screen">
      <header className="cmp-head"><h1>{t("עגלות נטושות", "Abandoned carts")}</h1><div className="cmp-head-actions"><Link href="/automations/journeys/new?trigger=CART_ABANDONED" className="cmp-btn" data-testid="carts-journey">{t("מסע שחזור עגלה", "Cart recovery journey")}</Link><button className="cmp-btn primary" onClick={() => setSetup("new")} data-testid="store-connect">{t("חיבור חנות", "Connect store")}</button></div></header>
      <section className="carts-stores">
        {stores === null ? <p className="cmp-note">{t("טוען…", "Loading…")}</p> : stores.length === 0 ? <div className="carts-empty"><ShoppingCart size={28} /><p>{t("עדיין לא חיברת חנות. חבר Shopify, WooCommerce או כל אתר אחר כדי לזהות עגלות נטושות ולשלוח תזכורות אוטומטיות ב-WhatsApp, SMS או אימייל.", "You haven't connected a store yet. Connect Shopify, WooCommerce or any other website to detect abandoned carts and send automatic reminders via WhatsApp, SMS or email.")}</p><button className="cmp-btn primary" onClick={() => setSetup("new")}>{t("חיבור חנות", "Connect store")}</button></div>
          : stores.map((st) => <button key={st.id} className="carts-store" onClick={() => api.get<Store>(`/api/stores/${st.id}?reveal=1`).then(setSetup)} data-testid={`store-${st.id}`}><strong>{st.name}</strong><span>{PLATFORM[st.platform] ? t(...PLATFORM[st.platform]) : st.platform}{st.domain ? ` · ${st.domain}` : ""}</span><em className={st.lastEventAt ? "ok" : "wait"}>{st.lastEventAt ? t(`אירוע אחרון ${new Date(st.lastEventAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL")}`, `Last event ${new Date(st.lastEventAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL")}`) : t("ממתין לאירוע ראשון מהאתר", "Waiting for the first event from the site")}</em></button>)}
      </section>
      <section className="lead-stats carts-stats">
        {[[t("עגלות שננטשו", "Abandoned carts"), s ? String(s.abandoned) : "…", s ? money(t, s.abandonedValue) : ""], [t("שוחזרו (נרכשו אחרי תזכורת)", "Recovered (purchased after reminder)"), s ? String(s.recovered) : "…", s ? money(t, s.recoveredValue) : ""], [t("אחוז שחזור", "Recovery rate"), s ? (s.recoveryRate === null ? "—" : `${s.recoveryRate}%`) : "…", t("מתוך עגלות שננטשו", "of abandoned carts")], [t("נרכשו בלי תזכורת", "Purchased without reminder"), s ? String(s.converted) : "…", t(`עגלות פעילות: ${s?.open ?? "…"}`, `Active carts: ${s?.open ?? "…"}`)]].map(([l, v, sub]) => <article className="lead-stat" key={l}><strong>{v}</strong><span>{l}</span><small>{sub}</small></article>)}
      </section>
      <section className="lead-filters"><div className="lead-search"><input placeholder={t("חיפוש לפי שם, אימייל או טלפון", "Search by name, email or phone")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("חיפוש עגלות", "Search carts")} /></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("סטטוס", "Status")} data-testid="carts-status"><option value="">{t("כל הסטטוסים", "All statuses")}</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{t(...v)}</option>)}</select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t("תקופה", "Period")}><option value={7}>{t("7 ימים", "7 days")}</option><option value={30}>{t("30 ימים", "30 days")}</option><option value={90}>{t("90 ימים", "90 days")}</option></select></section>
      <section className="lead-table-card"><div className="lead-table-scroll"><table className="leads-table"><thead><tr><th>{t("לקוח", "Customer")}</th><th>{t("חנות", "Store")}</th><th>{t("מוצרים", "Products")}</th><th>{t("סכום", "Amount")}</th><th>{t("סטטוס", "Status")}</th><th>{t("פעילות אחרונה", "Last activity")}</th><th /></tr></thead><tbody>
        {data?.items.map((c) => <tr key={c.id} data-testid={`cart-${c.id}`}>
          <td>{c.contact ? <Link href={`/contacts/${c.contact.id}`} className="lead-name">{c.contact.fullName}</Link> : <span>{c.customerName ?? c.email ?? t("אנונימי", "Anonymous")}</span>}<div className="text-xs text-muted" dir="ltr">{c.phoneE164 ?? c.email ?? ""}</div>{!c.contact && <div className="text-xs text-warn">{t("אין טלפון – לא ניתן לשלוח תזכורת", "No phone – cannot send a reminder")}</div>}</td>
          <td>{c.store.name}</td>
          <td className="carts-items">{c.items.slice(0, 3).map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ")}{c.items.length > 3 ? t(` ועוד ${c.items.length - 3}`, ` and ${c.items.length - 3} more`) : ""}</td>
          <td dir="ltr">{money(t, c.status === "converted" || c.status === "recovered" ? c.orderTotal ?? c.total : c.total, c.currency)}</td>
          <td><span className={`cmp-badge ${c.status === "abandoned" ? "failed" : c.status === "recovered" ? "sent" : c.status === "converted" ? "completed" : "draft"}`}>{STATUS[c.status] ? t(...STATUS[c.status]) : c.status}</span>{c.recoveryMessageAt && <div className="text-xs text-muted">{t("תזכורת נשלחה", "Reminder sent")}</div>}</td>
          <td className="lead-created">{new Date(c.lastActivityAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL", { dateStyle: "short", timeStyle: "short" })}</td>
          <td>{c.checkoutUrl && <a href={c.checkoutUrl} target="_blank" rel="noreferrer" className="lead-button">{t("קישור לעגלה", "Cart link")}</a>}</td>
        </tr>)}
      </tbody></table></div>{data && !data.items.length && <p className="cmp-empty">{t("אין עגלות בתקופה הזו.", "No carts in this period.")}</p>}</section>
      {setup && <StoreSetup store={setup === "new" ? null : setup} onClose={() => setSetup(null)} onSaved={(st) => { setSetup(st); loadStores(); }} onDeleted={() => { setSetup(null); loadStores(); loadCarts(); }} />}
    </div>
  );
}

function Code({ value, testid }: { value: string; testid?: string }) { const t = useT(); return <div className="carts-code"><code dir="ltr" data-testid={testid}>{value}</code><button onClick={() => copy(value, t)} aria-label={t("העתקה", "Copy")}><Copy size={14} /></button></div>; }

function StoreSetup({ store, onClose, onSaved, onDeleted }: { store: Store | null; onClose: () => void; onSaved: (s: Store) => void; onDeleted: () => void }) {
  const [platform, setPlatform] = useState<Store["platform"]>(store?.platform ?? "shopify");
  const [name, setName] = useState(store?.name ?? ""); const [domain, setDomain] = useState(store?.domain ?? "");
  const [minutes, setMinutes] = useState(store?.abandonAfterMinutes ?? 60); const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  async function create() { setBusy(true); try { onSaved(await api.post<Store>("/api/stores", { platform, name, domain: domain || undefined, abandonAfterMinutes: minutes, webhookSecret: platform === "shopify" && secret ? secret : undefined })); toast.success(t("החנות חוברה", "Store connected")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function update(patch: Record<string, unknown>) { if (!store) return; setBusy(true); try { await api.patch(`/api/stores/${store.id}`, patch); onSaved(await api.get<Store>(`/api/stores/${store.id}?reveal=1`)); toast.success(t("נשמר", "Saved")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function remove() { if (!store || !confirm(t(`לנתק את "${store.name}"? העגלות שלה יימחקו.`, `Disconnect "${store.name}"? Its carts will be deleted.`))) return; await api.delete(`/api/stores/${store.id}`); onDeleted(); }
  return (
    <div className="wz-modal" role="dialog" aria-label={t("חיבור חנות", "Connect store")}><div className="wz-modal-box carts-setup">
      <header><strong>{store ? t(`חנות: ${store.name}`, `Store: ${store.name}`) : t("חיבור חנות", "Connect store")}</strong><button onClick={onClose} aria-label={t("סגור", "Close")}><X size={18} /></button></header>
      <div className="carts-setup-body">
        {!store ? <>
          <div className="wz-seg" role="tablist">{(["shopify", "woocommerce", "custom"] as const).map((p) => <button key={p} className={platform === p ? "active" : ""} onClick={() => setPlatform(p)} data-testid={`platform-${p}`}>{t(...PLATFORM[p])}</button>)}</div>
          <label className="wz-field"><span className="wz-label">{t("שם החנות", "Store name")}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("למשל: החנות שלנו", "e.g. Our store")} data-testid="store-name" /></label>
          <label className="wz-field"><span className="wz-label">{t("דומיין האתר", "Site domain")}</span><input dir="ltr" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="shop.example.com" /><span className="wz-hint">{t("אירועים מהדפדפן יתקבלו רק מהדומיין הזה.", "Browser events will only be accepted from this domain.")}</span></label>
          <label className="wz-field"><span className="wz-label">{t("עגלה נחשבת נטושה אחרי", "A cart is considered abandoned after")}</span><select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}><option value={30}>{t("חצי שעה", "30 minutes")}</option><option value={60}>{t("שעה", "1 hour")}</option><option value={120}>{t("שעתיים", "2 hours")}</option><option value={240}>{t("4 שעות", "4 hours")}</option><option value={1440}>{t("יום", "1 day")}</option></select></label>
          {platform === "shopify" && <label className="wz-field"><span className="wz-label">{t("מפתח החתימה של Shopify (אפשר להוסיף גם אחר כך)", "Shopify signing secret (can also be added later)")}</span><input dir="ltr" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Settings → Notifications → Webhooks: “Your webhooks will be signed with …”" /></label>}
          <div className="wz-modal-actions"><button className="wz-btn primary" disabled={!name.trim() || busy} onClick={create} data-testid="store-create">{t("חיבור", "Connect")}</button></div>
        </> : <>
          {store.platform !== "custom" && <ApiConnect store={store} onConnected={onSaved} />}
          <ol className="carts-steps">
            <li><strong>{t("1. הוסף את הקוד לאתר", "1. Add the code to your site")}</strong>{store.platform === "shopify" ? t(" – Online Store → Themes → Edit code → theme.liquid, לפני </head>.", " – Online Store → Themes → Edit code → theme.liquid, before </head>.") : store.platform === "woocommerce" ? t(" – WordPress: תוסף כמו “Insert Headers and Footers” / WPCode → Header, או functions.php של התבנית.", " – WordPress: a plugin like “Insert Headers and Footers” / WPCode → Header, or the theme's functions.php.") : t(" – לפני </head> בכל עמודי האתר.", " – before </head> on every page of the site.")}<Code value={store.snippet} testid="store-snippet" />
              {store.platform === "custom" && <p className="wz-hint">{t("באתר מותאם, קרא מהקוד שלך:", "On a custom site, call from your code:")} <code dir="ltr">{"UltraCRM.cart({ externalId, email, phone, name, total, currency, checkoutUrl, items: [{ name, quantity, price }] })"}</code>{t(", ובסיום רכישה", ", and on purchase completion")} <code dir="ltr">{"UltraCRM.order({ orderId, total })"}</code>. {t("טלפון ואימייל שהגולש מקליד בטפסים נקלטים אוטומטית.", "Phone and email that visitors type into forms are captured automatically.")}</p>}
              {store.platform !== "custom" && <p className="wz-hint">{t("הקוד קורא את העגלה מהחנות", "The code reads the cart from the store")} ({store.platform === "shopify" ? "/cart.js" : "WooCommerce Store API"}) {t("וקולט טלפון ואימייל שהלקוח מקליד.", "and captures the phone and email the customer types.")}</p>}
            </li>
            {store.platform === "shopify" && <li><strong>{t("2. הוסף Webhooks ב-Shopify", "2. Add webhooks in Shopify")}</strong> {t("– Settings → Notifications → Webhooks → Create webhook, פורמט JSON, לכל אחד מהאירועים:", "– Settings → Notifications → Webhooks → Create webhook, JSON format, for each of the events:")} <b>Checkout creation</b>, <b>Checkout update</b>, <b>Order creation</b>, {t("עם הכתובת:", "with the URL:")}<Code value={store.webhookUrl!} testid="store-webhook-url" />
              <label className="wz-field"><span className="wz-label">{t("מפתח החתימה שמוצג ב-Shopify מתחת לרשימת ה-Webhooks", "The signing secret shown in Shopify below the webhooks list")}</span><div className="wz-inline"><input dir="ltr" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={store.webhookSecretMasked ?? t("הדבק כאן", "Paste here")} /><button className="wz-btn small" disabled={secret.length < 8 || busy} onClick={() => update({ webhookSecret: secret })}>{t("שמירה", "Save")}</button></div>{!store.webhookSecretMasked && <span className="wz-err">{t("עדיין לא הוזן מפתח – Shopify יידחה עד שיוזן.", "No secret entered yet – Shopify events will be rejected until it is.")}</span>}</label></li>}
            {store.platform === "woocommerce" && <li><strong>{t("2. הוסף Webhooks ב-WooCommerce", "2. Add webhooks in WooCommerce")}</strong> {t("– WooCommerce → Settings → Advanced → Webhooks → Add webhook. צור שניים:", "– WooCommerce → Settings → Advanced → Webhooks → Add webhook. Create two:")} <b>Order created</b> {t("ו-", "and ")}<b>Order updated</b>{t(", סטטוס Active, API version WP REST API v3, עם:", ", status Active, API version WP REST API v3, with:")}<div className="carts-kv"><span>Delivery URL</span><Code value={store.webhookUrl!} testid="store-webhook-url" /><span>Secret</span><Code value={store.webhookSecret ?? ""} testid="store-webhook-secret" /></div></li>}
            <li><strong>{store.platform === "custom" ? "2" : "3"}. {t("בנה מסע שחזור", "Build a recovery journey")}</strong> – <Link href="/automations/journeys/new?trigger=CART_ABANDONED">{t("מסע לקוח עם הטריגר \"עגלה ננטשה\"", "A customer journey with the \"Cart abandoned\" trigger")}</Link>: {t("המתנה → הודעת WhatsApp/SMS/אימייל. בהודעות אפשר להשתמש ב-", "wait → WhatsApp/SMS/email message. In messages you can use ")}<code dir="ltr">{"{{cart_url}}"}</code>, <code dir="ltr">{"{{cart_total}}"}</code>, <code dir="ltr">{"{{cart_items}}"}</code> ({t("ובמשתני WhatsApp:", "and in WhatsApp variables:")} <code dir="ltr">{"{cart_url}"}</code>). {t("המסע נעצר אוטומטית כשהעגלה נרכשת.", "The journey stops automatically when the cart is purchased.")}</li>
          </ol>
          <p className="wz-hint">{t("תזכורות נשלחות רק לאנשי קשר עם טלפון/אימייל ועם הסכמה לדיוור (ב-Shopify: \"Email me with news and offers\" בקופה). הסרות נכבדות תמיד.", "Reminders are sent only to contacts with a phone/email who opted in to marketing (in Shopify: \"Email me with news and offers\" at checkout). Unsubscribes are always respected.")}</p>
          <div className="carts-setup-foot"><label className="jr-check"><input type="checkbox" checked={store.isActive} onChange={(e) => update({ isActive: e.target.checked })} /> {t("פעיל", "Active")}</label><label className="jr-check">{t("נטושה אחרי", "Abandoned after")} <select value={store.abandonAfterMinutes} onChange={(e) => update({ abandonAfterMinutes: Number(e.target.value) })}><option value={30}>{t("חצי שעה", "30 minutes")}</option><option value={60}>{t("שעה", "1 hour")}</option><option value={120}>{t("שעתיים", "2 hours")}</option><option value={240}>{t("4 שעות", "4 hours")}</option><option value={1440}>{t("יום", "1 day")}</option></select></label><button className="cmp-btn" onClick={remove}><Trash2 size={14} /> {t("ניתוק", "Disconnect")}</button></div>
        </>}
      </div>
    </div></div>
  );
}

/** Recommended: paste the store's API credentials – we verify them and register the webhooks in the store. */
function ApiConnect({ store, onConnected }: { store: Store; onConnected: (s: Store) => void }) {
  const shopify = store.platform === "shopify";
  const [a, setA] = useState(shopify ? (store.api?.target ?? store.domain ?? "") : (store.api?.target ?? (store.domain ? `https://${store.domain}` : "")));
  const [b, setB] = useState(""); const [c, setC] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  async function connect() {
    setBusy(true);
    try {
      const r = await api.post<{ store: Store; registered: string[]; failed: string[]; shopName: string }>(`/api/stores/${store.id}/connect-api`, shopify ? { shop: a, accessToken: b, apiSecret: c } : { siteUrl: a, consumerKey: b, consumerSecret: c });
      if (r.failed.length) toast.error(t(`מחובר ל-${r.shopName}, אבל חלק מה-Webhooks לא נרשמו: ${r.failed.join(", ")}`, `Connected to ${r.shopName}, but some webhooks were not registered: ${r.failed.join(", ")}`)); else toast.success(t(`מחובר ל-${r.shopName} · ${r.registered.length} Webhooks נרשמו אוטומטית`, `Connected to ${r.shopName} · ${r.registered.length} webhooks registered automatically`));
      setB(""); setC(""); onConnected(await api.get<Store>(`/api/stores/${store.id}?reveal=1`));
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className="carts-api" data-testid="store-api">
      <h3>{t("חיבור אוטומטי עם API", "Automatic API connection")} <span className="cmp-badge sent">{t("מומלץ", "Recommended")}</span></h3>
      {store.api ? <p className="carts-api-ok" data-testid="store-api-status">✓ {t("מחובר ל-", "Connected to ")}<b dir="ltr">{store.api.target}</b> {t("מאז", "since")} {new Date(store.api.connectedAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL", { dateStyle: "short", timeStyle: "short" })} · {t("Webhooks רשומים:", "Registered webhooks:")} <span dir="ltr">{store.api.webhooks.join(", ") || "—"}</span></p>
        : <p className="wz-hint">{t("הדבק פעם אחת את פרטי ה-API של החנות – נבדוק אותם מול החנות ונרשום בה את ה-Webhooks לבד. אין צורך להעתיק כתובות ידנית.", "Paste the store's API credentials once – we'll verify them with the store and register the webhooks for you. No need to copy URLs manually.")}</p>}
      {shopify ? <p className="wz-hint">{t("ב-Shopify: Settings → Apps and sales channels → Develop apps → Create an app → הרשאות Admin API:", "In Shopify: Settings → Apps and sales channels → Develop apps → Create an app → Admin API scopes:")} <b dir="ltr">read_orders, read_checkouts</b> → Install. {t("העתק את", "Copy the")} <b>Admin API access token</b> {t("ואת", "and the")} <b>API secret key</b>.</p>
        : <p className="wz-hint">{t("ב-WooCommerce: Settings → Advanced → REST API → Add key, הרשאה", "In WooCommerce: Settings → Advanced → REST API → Add key, permission")} <b>Read/Write</b>. {t("העתק את", "Copy the")} <b dir="ltr">Consumer key</b> {t("ו-", "and ")}<b dir="ltr">Consumer secret</b>.</p>}
      <div className="carts-api-grid">
        <label className="wz-field"><span className="wz-label">{shopify ? t("כתובת החנות", "Store URL") : t("כתובת האתר", "Site URL")}</span><input dir="ltr" value={a} onChange={(e) => setA(e.target.value)} placeholder={shopify ? "your-store.myshopify.com" : "https://shop.example.com"} data-testid="store-api-target" /></label>
        <label className="wz-field"><span className="wz-label">{shopify ? "Admin API access token" : "Consumer key"}</span><input dir="ltr" type="password" autoComplete="off" value={b} onChange={(e) => setB(e.target.value)} placeholder={shopify ? "shpat_…" : "ck_…"} data-testid="store-api-key" /></label>
        <label className="wz-field"><span className="wz-label">{shopify ? "API secret key" : "Consumer secret"}</span><input dir="ltr" type="password" autoComplete="off" value={c} onChange={(e) => setC(e.target.value)} placeholder={shopify ? t("shpss_… / מפתח הסוד של האפליקציה", "shpss_… / the app's secret key") : "cs_…"} data-testid="store-api-secret" /></label>
      </div>
      <div className="wz-modal-actions"><button className="wz-btn primary" disabled={busy || !a.trim() || b.trim().length < 8 || c.trim().length < 8} onClick={connect} data-testid="store-api-connect">{busy ? t("מתחבר…", "Connecting…") : store.api ? t("חבר מחדש ובדוק", "Reconnect and verify") : t("חבר ובדוק", "Connect and verify")}</button></div>
      <p className="wz-hint">{t("המפתחות נשמרים מוצפנים ולא מוצגים שוב. אפשר גם לחבר ידנית לפי השלבים למטה.", "Keys are stored encrypted and never shown again. You can also connect manually using the steps below.")}</p>
    </section>
  );
}
