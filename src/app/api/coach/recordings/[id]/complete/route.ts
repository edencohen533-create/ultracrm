import { after } from "next/server";
import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { completeUpload, runSalesCoachJob } from "@/server/coach/sales";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** All chunks received → checks + duplicate detection; processing starts in the background (the cron picks up leftovers). */
export const POST = withAuth(async ({ user, params }) => {
  const r = await completeUpload(user, params.id);
  if (!r.duplicateOf) after(() => runSalesCoachJob({ deadline: Date.now() + 240_000, businessId: user.businessId }).catch(() => undefined));
  return ok(r);
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
