import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { getBusinessSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * For the campaign wizard's "sending" step: the business time zone, the default window (a starting point only – each
 * campaign keeps its own) and the business-wide limits the runner always enforces on top of the chosen pace.
 */
export const GET = withAuth(async ({ user }) => {
  const s = await getBusinessSettings(user.businessId);
  return ok({ timezone: s.timezone, window: { start: s.marketing.window.start, end: s.marketing.window.end, days: s.marketing.window.days }, maxPerMinute: s.marketing.maxPerMinute, minHoursBetweenMarketing: s.marketing.minHoursBetweenMarketing });
}, { minRole: "manager" });
