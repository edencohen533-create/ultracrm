import type { MetaWhatsAppConfig } from "@/server/providers/meta-whatsapp-provider";
export class MetaConnectionError extends Error {}

/** Read-only preflight: validates number ownership and both management resources. */
export async function checkMetaConnection(config: MetaWhatsAppConfig) {
  if (!config.businessAccountId) throw new MetaConnectionError("Business Account ID נדרש לחיבור מלא");
  const base = `https://graph.facebook.com/${config.apiVersion ?? "v21.0"}`;
  async function get(path: string) {
    try {
      const res = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${config.accessToken}` }, signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store" });
      if (!res.ok) throw new Error("Meta rejected request");
      return await res.json();
    } catch { throw new MetaConnectionError("לא ניתן לאמת גישה לחשבון Meta. בדוק Token, מזהים והרשאות whatsapp_business_management ו־whatsapp_business_messaging"); }
  }
  let after: string | undefined;
  let phone: { id: string; display_phone_number?: string; verified_name?: string } | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await get(`${config.businessAccountId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!Array.isArray(response.data)) throw new MetaConnectionError("תשובת מספרי הטלפון של Meta אינה תקינה");
    phone = response.data.find((item: { id: string }) => item.id === config.phoneNumberId);
    if (phone || !response.paging?.next) break;
    const next = response.paging?.cursors?.after;
    if (!next || next === after) break;
    after = next;
  }
  if (!phone) throw new MetaConnectionError("Phone Number ID אינו שייך ל־Business Account ID שהוזן");
  const templates = await get(`${config.businessAccountId}/message_templates?fields=id&limit=1`);
  if (!Array.isArray(templates.data)) throw new MetaConnectionError("לא ניתן לקרוא תבניות מחשבון Meta");
  const subscriptions = await get(`${config.businessAccountId}/subscribed_apps`);
  return { phoneNumber: phone.display_phone_number ?? null, verifiedName: phone.verified_name ?? null, hasSubscribedApp: Array.isArray(subscriptions.data) && subscriptions.data.length > 0 };
}
