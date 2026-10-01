import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { assertMarketing } from "@/server/marketing/meta-connection";
import { messagingPerformance } from "@/server/reports/messaging";

export const dynamic = "force-dynamic";
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schema = z.object({ from: day, to: day });

/** שיווק ומכירות ← ביצועי דיוור: delivery statuses per sender and channel (same access as the marketing report). */
export const GET = withAuth(async ({ req, user }) => {
  await assertMarketing(user, "view");
  return ok(await messagingPerformance(user, parseQuery(req, schema)));
}, { module: "crm" });
