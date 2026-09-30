import { z } from "zod";
import { after } from "next/server";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { reprocess, runSalesCoachJob } from "@/server/coach/sales";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Retry a failed recording, or (force) re-process a finished one – explicit, because it costs transcription again. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ force: z.boolean().default(false) }));
  const r = await reprocess(user, params.id, b.force);
  after(() => runSalesCoachJob({ deadline: Date.now() + 240_000, businessId: user.businessId }).catch(() => undefined));
  return ok(r);
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
