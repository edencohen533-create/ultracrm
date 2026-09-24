import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { checkConnection } from "@/server/services/embedded-signup-service";
import { metaAppEnv } from "@/lib/meta/graph";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Daily WhatsApp connection health: re-validates every active Meta credential (token validity,
 * scopes, subscription, phone state) so an expired/revoked token is surfaced before a campaign
 * fails. Marks `revoked` / `needs_action` exactly as the on-demand "בדוק חיבור" does.
 */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    if (!metaAppEnv().appSecret) return Response.json({ checked: 0, skipped: "META_APP_SECRET not configured" });
    const credentials = await db.providerCredential.findMany({ where: { channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true }, select: { id: true, businessId: true } });
    const results: Array<{ id: string; status: string; error: string | null }> = [];
    const deadline = Date.now() + 45_000;
    for (const c of credentials) {
      if (Date.now() > deadline) break;
      try {
        const r = await withBusiness(c.businessId, () => checkConnection({ id: null, businessId: c.businessId }, c.id));
        results.push({ id: c.id, status: r.status, error: r.error });
      } catch (err) { results.push({ id: c.id, status: "error", error: (err as Error).message.slice(0, 200) }); }
    }
    return Response.json({ checked: results.length, results });
  } catch (err) { return handleError(err); }
}
