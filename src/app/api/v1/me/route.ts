import { ok, handleError } from "@/lib/response";
import { authenticateApiKey } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

/** Public API – connection test for Make / Zapier ("Authorization: Bearer uk_live_…"). */
export async function GET(req: Request) {
  try { const a = await authenticateApiKey(req); return ok({ business: { id: a.business.id, name: a.business.name }, key: { id: a.keyId, name: a.keyName } }); }
  catch (e) { return handleError(e); }
}
