"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, ShoppingCart, Trash2, X } from "lucide-react";
import { api } from "@/lib/client/api";

type Store = { id: string; platform: "shopify" | "woocommerce" | "custom"; name: string; domain: string | null; publicKey: string; abandonAfterMinutes: number; isActive: boolean; lastEventAt: string | null; snippet: string; webhookUrl: string | null; webhookSecret: string | null; webhookSecretMasked: string | null };
type Cart = { id: string; status: string; email: string | null; phoneE164: string | null; customerName: string | null; currency: string | null; total: string | null; orderTotal: string | null; items: Array<{ name: string; quantity: number }>; checkoutUrl: string | null; lastActivityAt: string; abandonedAt: string | null; convertedAt: string | null; recoveryMessageAt: string | null; store: { name: string; platform: string }; contact: { id: string; fullName: string } | null };
type Stats = { open: number; abandoned: number; abandonedValue: number; recovered: number; recoveredValue: number; converted: number; recoveryRate: number | null };
const PLATFORM: Record<string, string> = { shopify: "Shopify", woocommerce: "WooCommerce", custom: "אתר אחר" };
const STATUS: Record<string, string> = { open: "פעילה", abandoned: "ננטשה", converted: "נרכשה", recovered: "שוחזרה" };
const money = (v: number | string | null, cur?: string | null) => v === null || v === "" ? "—" : `${Number(v).toLocaleString("he-IL", { maximumFractionDigits: 2 })} ${cur ?? ""}`.trim();
const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); toast.success("הועתק"); } catch { toast.error("לא ניתן להעתיק"); } };

/** "עגלות נטושות": connected stores (site script + Shopify / WooCommerce webhooks) and the carts they report. */
export function CartsScreen() {
  const [stores, setStores] = useState<Store[] | null>(null);
  const [data, setData] = useState<{ items: Cart[]; total: number; stats: Stats } | null>(null);
  const [status, setStatus] = useState(""); const [q, setQ] = useState(""); const [days, setDays] = useState(30);
  const [setup, setSetup] = useState<Store | "new" | null>(null);
  const loadStores = useCallback(() => api.get<{ items: Store[] }>("/api/stores").then((r) => setStores(r.items)).catch(() => setStores([])), []);
  const loadCarts = useCallback(() => api.get<{ items: Cart[]; total: number; stats: Stats }>(`/api/carts?days=${days}${status ? `&status=${status}` : ""}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then(setData).catch(() => undefined), [days, status, q]);
  useEffect(() => { loadStores(); }, [loadStores]);
  useEffect(() => { const t = setTimeout(loadCarts, 300); return () => clearTimeout(t); }, [loadCarts]);
  const s = data?.stats;
  return (
    <div className="carts" data-testid="carts-screen">
      <header className="cmp-head"><h1>עגלות נטושות</h1><div className="cmp-head-actions"><Link href="/automations/journeys/new?trigger=CART_ABANDONED" className="cmp-btn" data-testid="carts-journey">מסע שחזור עגלה</Link><button className="cmp-btn primary" onClick={() => setSetup("new")} data-testid="store-connect">חיבור חנות</button></div></header>
      <section className="carts-stores">
        {stores === null ? <p className="cmp-note">טוען…</p> : stores.length === 0 ? <div className="carts-empty"><ShoppingCart size={28} /><p>עדיין לא חיברת חנות. חבר Shopify, WooCommerce או כל אתר אחר כדי לזהות עגלות נטושות ולשלוח תזכורות אוטומטיות ב-WhatsApp, SMS או אימייל.</p><button className="cmp-btn primary" onClick={() => setSetup("new")}>חיבור חנות</button></div>
          : stores.map((st) => <button key={st.id} className="carts-store" onClick={() => api.get<Store>(`/api/stores/${st.id}?reveal=1`).then(setSetup)} data-testid={`store-${st.id}`}><strong>{st.name}</strong><span>{PLATFORM[st.platform]}{st.domain ? ` · ${st.domain}` : ""}</span><em className={st.lastEventAt ? "ok" : "wait"}>{st.lastEventAt ? `אירוע אחרון ${new Date(st.lastEventAt).toLocaleString("he-IL")}` : "ממתין לאירוע ראשון מהאתר"}</em></button>)}
      </section>
      <section className="lead-stats carts-stats">
        {[["עגלות שננטשו", s ? String(s.abandoned) : "…", s ? money(s.abandonedValue) : ""], ["שוחזרו (נרכשו אחרי תזכורת)", s ? String(s.recovered) : "…", s ? money(s.recoveredValue) : ""], ["אחוז שחזור", s ? (s.recoveryRate === null ? "—" : `${s.recoveryRate}%`) : "…", "מתוך עגלות שננטשו"], ["נרכשו בלי תזכורת", s ? String(s.converted) : "…", `עגלות פעילות: ${s?.open ?? "…"}`]].map(([l, v, sub]) => <article className="lead-stat" key={l}><strong>{v}</strong><span>{l}</span><small>{sub}</small></article>)}
      </section>
      <section className="lead-filters"><div className="lead-search"><input placeholder="חיפוש לפי שם, אימייל או טלפון" value={q} onChange={(e) => setQ(e.target.value)} aria-label="חיפוש עגלות" /></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="סטטוס" data-testid="carts-status"><option value="">כל הסטטוסים</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="תקופה"><option value={7}>7 ימים</option><option value={30}>30 ימים</option><option value={90}>90 ימים</option></select></section>
      <section className="lead-table-card"><div className="lead-table-scroll"><table className="leads-table"><thead><tr><th>לקוח</th><th>חנות</th><th>מוצרים</th><th>סכום</th><th>סטטוס</th><th>פעילות אחרונה</th><th /></tr></thead><tbody>
        {data?.items.map((c) => <tr key={c.id} data-testid={`cart-${c.id}`}>
          <td>{c.contact ? <Link href={`/contacts/${c.contact.id}`} className="lead-name">{c.contact.fullName}</Link> : <span>{c.customerName ?? c.email ?? "אנונימי"}</span>}<div className="text-xs text-muted" dir="ltr">{c.phoneE164 ?? c.email ?? ""}</div>{!c.contact && <div className="text-xs text-warn">אין טלפון – לא ניתן לשלוח תזכורת</div>}</td>
          <td>{c.store.name}</td>
          <td className="carts-items">{c.items.slice(0, 3).map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ")}{c.items.length > 3 ? ` ועוד ${c.items.length - 3}` : ""}</td>
          <td dir="ltr">{money(c.status === "converted" || c.status === "recovered" ? c.orderTotal ?? c.total : c.total, c.currency)}</td>
          <td><span className={`cmp-badge ${c.status === "abandoned" ? "failed" : c.status === "recovered" ? "sent" : c.status === "converted" ? "completed" : "draft"}`}>{STATUS[c.status]}</span>{c.recoveryMessageAt && <div className="text-xs text-muted">תזכורת נשלחה</div>}</td>
          <td className="lead-created">{new Date(c.lastActivityAt).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}</td>
          <td>{c.checkoutUrl && <a href={c.checkoutUrl} target="_blank" rel="noreferrer" className="lead-button">קישור לעגלה</a>}</td>
        </tr>)}
      </tbody></table></div>{data && !data.items.length && <p className="cmp-empty">אין עגלות בתקופה הזו.</p>}</section>
      {setup && <StoreSetup store={setup === "new" ? null : setup} onClose={() => setSetup(null)} onSaved={(st) => { setSetup(st); loadStores(); }} onDeleted={() => { setSetup(null); loadStores(); loadCarts(); }} />}
    </div>
  );
}

function Code({ value, testid }: { value: string; testid?: string }) { return <div className="carts-code"><code dir="ltr" data-testid={testid}>{value}</code><button onClick={() => copy(value)} aria-label="העתקה"><Copy size={14} /></button></div>; }

function StoreSetup({ store, onClose, onSaved, onDeleted }: { store: Store | null; onClose: () => void; onSaved: (s: Store) => void; onDeleted: () => void }) {
  const [platform, setPlatform] = useState<Store["platform"]>(store?.platform ?? "shopify");
  const [name, setName] = useState(store?.name ?? ""); const [domain, setDomain] = useState(store?.domain ?? "");
  const [minutes, setMinutes] = useState(store?.abandonAfterMinutes ?? 60); const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() { setBusy(true); try { onSaved(await api.post<Store>("/api/stores", { platform, name, domain: domain || undefined, abandonAfterMinutes: minutes, webhookSecret: platform === "shopify" && secret ? secret : undefined })); toast.success("החנות חוברה"); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function update(patch: Record<string, unknown>) { if (!store) return; setBusy(true); try { await api.patch(`/api/stores/${store.id}`, patch); onSaved(await api.get<Store>(`/api/stores/${store.id}?reveal=1`)); toast.success("נשמר"); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  async function remove() { if (!store || !confirm(`לנתק את "${store.name}"? העגלות שלה יימחקו.`)) return; await api.delete(`/api/stores/${store.id}`); onDeleted(); }
  return (
    <div className="wz-modal" role="dialog" aria-label="חיבור חנות"><div className="wz-modal-box carts-setup">
      <header><strong>{store ? `חנות: ${store.name}` : "חיבור חנות"}</strong><button onClick={onClose} aria-label="סגור"><X size={18} /></button></header>
      <div className="carts-setup-body">
        {!store ? <>
          <div className="wz-seg" role="tablist">{(["shopify", "woocommerce", "custom"] as const).map((p) => <button key={p} className={platform === p ? "active" : ""} onClick={() => setPlatform(p)} data-testid={`platform-${p}`}>{PLATFORM[p]}</button>)}</div>
          <label className="wz-field"><span className="wz-label">שם החנות</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="למשל: החנות שלנו" data-testid="store-name" /></label>
          <label className="wz-field"><span className="wz-label">דומיין האתר</span><input dir="ltr" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="shop.example.com" /><span className="wz-hint">אירועים מהדפדפן יתקבלו רק מהדומיין הזה.</span></label>
          <label className="wz-field"><span className="wz-label">עגלה נחשבת נטושה אחרי</span><select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}><option value={30}>חצי שעה</option><option value={60}>שעה</option><option value={120}>שעתיים</option><option value={240}>4 שעות</option><option value={1440}>יום</option></select></label>
          {platform === "shopify" && <label className="wz-field"><span className="wz-label">מפתח החתימה של Shopify (אפשר להוסיף גם אחר כך)</span><input dir="ltr" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Settings → Notifications → Webhooks: “Your webhooks will be signed with …”" /></label>}
          <div className="wz-modal-actions"><button className="wz-btn primary" disabled={!name.trim() || busy} onClick={create} data-testid="store-create">חיבור</button></div>
        </> : <>
          <ol className="carts-steps">
            <li><strong>1. הוסף את הקוד לאתר</strong>{store.platform === "shopify" ? " – Online Store → Themes → Edit code → theme.liquid, לפני </head>." : store.platform === "woocommerce" ? " – WordPress: תוסף כמו “Insert Headers and Footers” / WPCode → Header, או functions.php של התבנית." : " – לפני </head> בכל עמודי האתר."}<Code value={store.snippet} testid="store-snippet" />
              {store.platform === "custom" && <p className="wz-hint">באתר מותאם, קרא מהקוד שלך: <code dir="ltr">{"UltraCRM.cart({ externalId, email, phone, name, total, currency, checkoutUrl, items: [{ name, quantity, price }] })"}</code>, ובסיום רכישה <code dir="ltr">{"UltraCRM.order({ orderId, total })"}</code>. טלפון ואימייל שהגולש מקליד בטפסים נקלטים אוטומטית.</p>}
              {store.platform !== "custom" && <p className="wz-hint">הקוד קורא את העגלה מהחנות ({store.platform === "shopify" ? "/cart.js" : "WooCommerce Store API"}) וקולט טלפון ואימייל שהלקוח מקליד.</p>}
            </li>
            {store.platform === "shopify" && <li><strong>2. הוסף Webhooks ב-Shopify</strong> – Settings → Notifications → Webhooks → Create webhook, פורמט JSON, לכל אחד מהאירועים: <b>Checkout creation</b>, <b>Checkout update</b>, <b>Order creation</b>, עם הכתובת:<Code value={store.webhookUrl!} testid="store-webhook-url" />
              <label className="wz-field"><span className="wz-label">מפתח החתימה שמוצג ב-Shopify מתחת לרשימת ה-Webhooks</span><div className="wz-inline"><input dir="ltr" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={store.webhookSecretMasked ?? "הדבק כאן"} /><button className="wz-btn small" disabled={secret.length < 8 || busy} onClick={() => update({ webhookSecret: secret })}>שמירה</button></div>{!store.webhookSecretMasked && <span className="wz-err">עדיין לא הוזן מפתח – Shopify יידחה עד שיוזן.</span>}</label></li>}
            {store.platform === "woocommerce" && <li><strong>2. הוסף Webhooks ב-WooCommerce</strong> – WooCommerce → Settings → Advanced → Webhooks → Add webhook. צור שניים: <b>Order created</b> ו-<b>Order updated</b>, סטטוס Active, API version WP REST API v3, עם:<div className="carts-kv"><span>Delivery URL</span><Code value={store.webhookUrl!} testid="store-webhook-url" /><span>Secret</span><Code value={store.webhookSecret ?? ""} testid="store-webhook-secret" /></div></li>}
            <li><strong>{store.platform === "custom" ? "2" : "3"}. בנה מסע שחזור</strong> – <Link href="/automations/journeys/new?trigger=CART_ABANDONED">מסע לקוח עם הטריגר &quot;עגלה ננטשה&quot;</Link>: המתנה → הודעת WhatsApp/SMS/אימייל. בהודעות אפשר להשתמש ב-<code dir="ltr">{"{{cart_url}}"}</code>, <code dir="ltr">{"{{cart_total}}"}</code>, <code dir="ltr">{"{{cart_items}}"}</code> (ובמשתני WhatsApp: <code dir="ltr">{"{cart_url}"}</code>). המסע נעצר אוטומטית כשהעגלה נרכשת.</li>
          </ol>
          <p className="wz-hint">תזכורות נשלחות רק לאנשי קשר עם טלפון/אימייל ועם הסכמה לדיוור (ב-Shopify: &quot;Email me with news and offers&quot; בקופה). הסרות נכבדות תמיד.</p>
          <div className="carts-setup-foot"><label className="jr-check"><input type="checkbox" checked={store.isActive} onChange={(e) => update({ isActive: e.target.checked })} /> פעיל</label><label className="jr-check">נטושה אחרי <select value={store.abandonAfterMinutes} onChange={(e) => update({ abandonAfterMinutes: Number(e.target.value) })}><option value={30}>חצי שעה</option><option value={60}>שעה</option><option value={120}>שעתיים</option><option value={240}>4 שעות</option><option value={1440}>יום</option></select></label><button className="cmp-btn" onClick={remove}><Trash2 size={14} /> ניתוק</button></div>
        </>}
      </div>
    </div></div>
  );
}
