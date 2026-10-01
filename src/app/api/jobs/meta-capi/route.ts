import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { runCapiJob } from "@/server/marketing/capi";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Every minute: confirmed payments → events, then send due events (retries with backoff) for every business. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const r = await runCapiJob({ deadline: Date.now() + 45_000 });
    return Response.json({ businesses: r.length, sent: r.reduce((t, x) => t + x.sent, 0) });
  } catch (err) { return handleError(err); }
}
