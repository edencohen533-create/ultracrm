import { z } from "zod";
import { after } from "next/server";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { recordingFromCall, runSalesCoachJob } from "@/server/coach/sales";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Use an existing recorded call. The same call is never added (or processed) twice. */
export const POST = withAuth(async ({ req, user }) => {
  const r = await recordingFromCall(user, (await parseBody(req, z.object({ callId: z.string().min(1) }))).callId);
  if (!r.existing) after(() => runSalesCoachJob({ deadline: Date.now() + 240_000, businessId: user.businessId }).catch(() => undefined));
  return ok(r);
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
