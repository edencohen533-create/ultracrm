/**
 * "אינטגרציה כללית" – not a ready connector for any specific CRM. The external system (its own code, Make / Zapier /
 * n8n) pushes contacts / opportunities to /api/v1/crm/* with a scoped integration key, and – optionally – receives
 * our write-back (call activity, AI summary, follow-up task, status, block request) as signed JSON POSTs to a callback
 * URL it exposes. Everything here needs configuration on the external side; nothing is assumed about its API.
 */
import crypto from "node:crypto";
import { safeFetch } from "@/lib/safe-url";
import { ConnectorError, type ConnectorCtx, type ConnectorDef } from "../types";

export const signBody = (secret: string, ts: string, body: string) => `sha256=${crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

async function callback(ctx: ConnectorCtx, action: string, correlationId: string, data: unknown): Promise<{ externalId?: string }> {
  const url = ctx.auth.callbackUrl; const secret = ctx.auth.callbackSecret;
  if (!url || !secret) throw new ConnectorError("לא הוגדרה כתובת חזרה (callback) – כתיבה חזרה אינה פעילה", "invalid");
  const body = JSON.stringify({ action, correlationId, idempotencyKey: correlationId, data });
  const ts = String(Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await safeFetch(url, { method: "POST", body, timeoutMs: 15_000, headers: { "Content-Type": "application/json", "User-Agent": "UltraCRM-CRM-Sync/1", "X-UltraCRM-Action": action, "X-UltraCRM-Correlation": correlationId, "X-UltraCRM-Timestamp": ts, "X-UltraCRM-Signature": signBody(secret, ts, body) } });
  } catch (e) {
    // A timeout after sending may mean the receiver already applied it – the correlation id lets it ignore the retry.
    throw new ConnectorError(`הקריאה לכתובת החזרה נכשלה: ${(e as Error).message}`.slice(0, 300), "ambiguous");
  }
  if (res.status === 429) throw new ConnectorError("המערכת החיצונית ביקשה להאט", "rate_limit", Number(res.headers.get("retry-after")) || 60);
  if (res.status === 401 || res.status === 403) throw new ConnectorError(`המערכת החיצונית דחתה את החתימה / ההרשאה (HTTP ${res.status})`, "auth");
  if (res.status >= 500) throw new ConnectorError(`שגיאה במערכת החיצונית (HTTP ${res.status})`, "ambiguous");
  if (res.status >= 400) throw new ConnectorError(`המערכת החיצונית דחתה את הבקשה (HTTP ${res.status})`, "invalid");
  const j = (await res.json().catch(() => ({}))) as { externalId?: unknown };
  return { externalId: typeof j.externalId === "string" && j.externalId.length <= 200 ? j.externalId : undefined };
}

export const genericConnector: ConnectorDef = {
  key: "generic_api",
  name: "אינטגרציה כללית (API + Webhooks)",
  description: "המערכת החיצונית שולחת אנשי קשר ופניות ל-API שלנו עם מזהים חיצוניים, ומקבלת בחזרה תוצאות שיחה, סיכומים ופולואפים לכתובת שהיא מגדירה. דורש הגדרה במערכת החיצונית – אינו מחבר מוכן ל-CRM מסוים.",
  availability: "needs_setup",
  authFields: [{ key: "callbackUrl", label: "כתובת חזרה (HTTPS) לקבלת תוצאות – אופציונלי", secret: false, required: false, placeholder: "https://example.com/ultracrm-callback", help: "נקבל כאן POST חתום (X-UltraCRM-Signature = HMAC-SHA256 של \"timestamp.body\") לכל תוצאת שיחה, סיכום, פולואפ, שינוי סטטוס ובקשת חסימה." }],
  capabilities: ["test", "push_api", "write_call", "update_call", "upsert_task", "update_status", "request_block"],
  async test(ctx) {
    const hasCallback = Boolean(ctx.auth.callbackUrl);
    if (hasCallback) {
      try { await callback(ctx, "ping", `ping_${Date.now()}`, { message: "בדיקת חיבור מ-UltraCRM" }); }
      catch (e) { return { ok: false, message: `כתובת החזרה לא אישרה את בקשת הבדיקה: ${(e as Error).message}` }; }
    }
    return { ok: true, message: hasCallback ? "כתובת החזרה אישרה בקשה חתומה. קליטה דרך ה-API פעילה עם מפתח האינטגרציה." : "קליטה דרך ה-API פעילה עם מפתח האינטגרציה. לא הוגדרה כתובת חזרה – תוצאות לא ייכתבו חזרה.", permissions: hasCallback ? ["push_api", "callback"] : ["push_api"] };
  },
  async writeCall(ctx, call) { const r = await callback(ctx, "call.logged", call.correlationId, call); return { externalId: r.externalId ?? call.correlationId }; },
  async updateCall(ctx, externalId, patch) { await callback(ctx, "call.updated", `${patch.correlationId ?? externalId}:update`, { externalId, ...patch }); },
  async upsertTask(ctx, task, externalId) { const r = await callback(ctx, externalId ? "task.updated" : "task.created", task.correlationId, { ...task, externalId }); return { externalId: r.externalId ?? externalId ?? task.correlationId }; },
  async updateStatus(ctx, leadExternalId, status, correlationId) { await callback(ctx, "lead.status", correlationId, { leadExternalId, status }); },
  async requestBlock(ctx, contactExternalId, reason, correlationId) { await callback(ctx, "contact.block", correlationId, { contactExternalId, reason }); },
};
