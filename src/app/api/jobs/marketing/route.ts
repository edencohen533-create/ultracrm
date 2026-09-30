import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { runMetaSync } from "@/server/marketing/meta-sync";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Every 5 minutes: Meta Ads history chunks and recent-day refreshes for connected ad accounts (read only). */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const results = await runMetaSync({ deadline: Date.now() + 45_000 });
    return Response.json({ steps: results.length });
  } catch (err) { return handleError(err); }
}
