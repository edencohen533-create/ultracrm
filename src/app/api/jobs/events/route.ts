import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { processDomainEvents } from "@/lib/events";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Cross-module event worker (safety net for the inline kick) – every minute. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    return Response.json(await processDomainEvents({ limit: 100, deadline: Date.now() + 45_000 }));
  } catch (err) {
    return handleError(err);
  }
}
