"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";

type Health = { active: boolean; lastVerifiedEventAt: string | null; cart: { externalId: string; lastActivityAt: string } | null; purchase: { externalId: string; orderId: string } | null; failed: number; pending: number };
export function StoreInstructions({ id, platform, serverEventsUrl, secret }: { id: string; platform: string; serverEventsUrl: string; secret: string | null }) {
  const t = useT(); const [health, setHealth] = useState<Health | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function refresh() { setBusy(true); setError(""); try { setHealth(await api.get<Health>(`/api/stores/${id}/health`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  useEffect(() => { let cancelled = false; api.get<Health>(`/api/stores/${id}/health`).then(v => { if (!cancelled) setHealth(v); }).catch(e => { if (!cancelled) setError((e as Error).message); }); return () => { cancelled = true; }; }, [id]);
  return <section className="carts-api">
    {platform !== "shopify" && <>
      <h3>{t("קליטת עגלות ורכישות מהשרת", "Server cart and purchase tracking")}</h3>
      {platform === "woocommerce" ? <>
        <p>{t("חיבור ה־API למעלה מסנכרן הזמנות. כדי לעקוב גם אחרי עגלה לפני הזמנה, התקן את התוסף:", "The API connection above syncs orders. Install this plugin to also track carts before an order exists:")}</p>
        <ol><li><a className="cmp-btn" href="/integrations/ultracrm-woocommerce.zip" download>{t("הורדת תוסף WooCommerce", "Download WooCommerce plugin")}</a></li><li>{t("WordPress ← תוספים ← תוסף חדש ← העלאת תוסף. העלה את קובץ ה־ZIP והפעל אותו.", "WordPress → Plugins → Add New → Upload Plugin. Upload the ZIP and activate it.")}</li><li>{t("בהגדרות WordPress ← UltraCRM, הדבק את הכתובת ומפתח החתימה שלמטה, שמור ולחץ Test signed connection.", "In WordPress Settings → UltraCRM, paste the URL and signing secret below, save, then click Test signed connection.")}</li></ol>
        <p className="wz-hint">{t("התוסף משתמש בתור המשימות של WooCommerce. יש להשאיר WP-Cron פעיל. קישורי שחזור תקפים ל־7 ימים ומשחזרים מוצרים בלבד, בכפוף למלאי ומחירים עדכניים. הסר סקריפט מעקב ישן של UltraCRM מהתבנית כדי למנוע עגלות כפולות.", "The plugin uses WooCommerce Action Scheduler; keep WP-Cron running. Recovery links expire after 7 days and restore products only, subject to current stock and pricing. Remove the old UltraCRM tracking script from your theme to prevent duplicate carts.")}</p>
      </> : <>
        <p>{t("המפתח סודי ונשאר בשרת האתר. שלח cart בכל שינוי או פעילות אמיתית, ו־order רק לאחר אימות תשלום בשרת. השתמש באותו externalId בשני האירועים; לרכישה הבאה צור מזהה עגלה חדש.", "Keep the secret on your server. Send cart on changes or real activity, and order only after server-side payment verification. Use the same externalId for both; create a new cart ID for the next purchase.")}</p>
        <a className="cmp-btn" href="/integrations/ultracrm-server.mjs" download>{t("הורדת SDK לדוגמה ל־Node.js", "Download Node.js example SDK")}</a>
        <details><summary>{t("דוגמת קוד למפתח האתר", "Code example for your developer")}</summary><pre className="carts-code" dir="ltr">{`import { sendUltraCRMEvent } from './ultracrm-server.mjs';\nawait sendUltraCRMEvent({\n  endpoint: process.env.ULTRACRM_ENDPOINT,\n  secret: process.env.ULTRACRM_SECRET,\n  eventId: 'cart-42-change-1',\n  event: { type: 'cart', externalId: 'cart-42',\n    activityAt: new Date().toISOString(),\n    total: 120, currency: 'ILS',\n    items: [{ name: 'Product', quantity: 2, price: 60 }] }\n});\n// After verified payment, with a NEW eventId:\n// event: { type: 'order', externalId: 'cart-42',\n//          orderId: 'order-91', total: 120, currency: 'ILS' }`}</pre></details>
        <p className="wz-hint">{t("פרטי לקוח וקישור שחזור הם אופציונליים: email, phone, name, checkoutUrl. אל תשלח פרטים מומצאים או קישור כללי לקופה. שמור eventId ו־activityAt המקוריים בניסיונות חוזרים. תשובת 202 היא קבלה לתור, לא אישור עיבוד.", "Customer details and a real recovery URL are optional: email, phone, name, checkoutUrl. Do not fabricate visitor details or send a generic checkout URL. Preserve eventId and original activityAt on retries. HTTP 202 means queued, not processed.")}</p>
        <p dir="ltr" className="wz-hint">POST JSON · X-UltraCRM-Event-Id: unique stable ID · X-UltraCRM-Timestamp: Unix seconds · X-UltraCRM-Signature: base64(HMAC-SHA256(secret, timestamp + &quot;.&quot; + eventId + &quot;.&quot; + raw JSON)). Timestamp tolerance: 5 minutes. Probe body: {`{"type":"probe"}`}.</p>
      </>}
      <label className="wz-field">{t("כתובת אירועי שרת (מזהה החנות כלול בכתובת)", "Server events URL (includes the store ID)")}<input dir="ltr" readOnly value={serverEventsUrl} onFocus={e => e.target.select()} /></label>
      <label className="wz-field">{t("מפתח חתימה — לשרת בלבד", "Signing secret — server only")}<input type="password" dir="ltr" readOnly value={secret ?? ""} onFocus={e => e.target.select()} /></label>
    </>}
    <h3>{t("בדיקת חיבור מקצה לקצה", "End-to-end connection check")}</h3>
    <p>{t("הוסף מוצר בחנות, המשך לקופה ועדכן פרטי לקוח. בדוק שהעגלה מופיעה כאן. השאר אותה ללא פעילות לפי זמן הנטישה, ואז בצע תשלום בדיקה: אותה עגלה צריכה להפוך לנרכשה. בדיקת חתימה לבדה לא מוכיחה שהאירועים הותקנו.", "Add a product, proceed to checkout and update customer details. Verify the cart appears here. Leave it idle for the abandonment threshold, then complete a test payment: that same cart must become purchased. A signature probe alone does not prove event installation.")}</p>
    {health && <ul className="jr-checks"><li>{health.active ? t("קליטה פעילה", "Ingestion enabled") : t("החנות מושהית", "Store paused")}</li><li>{health.lastVerifiedEventAt ? t("התקבל אירוע עם חתימה תקינה", "Signed event received") : t("טרם התקבל אירוע חתום", "No signed event received yet")}</li><li>{health.cart ? `${t("עגלה נקלטה:", "Cart received:")} ${health.cart.externalId}` : t("טרם נקלטה עגלה", "No cart received yet")}</li><li>{health.purchase ? `${t("רכישה משויכת:", "Correlated purchase:")} ${health.purchase.orderId} ← ${health.purchase.externalId}` : t("טרם אומתה רכישה משויכת לעגלה", "No correlated purchase verified yet")}</li><li>{t(`בתור: ${health.pending} · נכשלו: ${health.failed}`, `Queued: ${health.pending} · Failed: ${health.failed}`)}</li></ul>}
    {error && <p role="alert" className="wz-err">{error}</p>}
    <button className="cmp-btn" disabled={busy} onClick={refresh}>{busy ? t("בודק…", "Checking…") : t("רענון בדיקת קליטה", "Refresh ingestion status")}</button>
  </section>;
}
