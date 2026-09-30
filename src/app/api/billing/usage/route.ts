import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { assertBillingAdmin } from "@/server/billing/subscriptions";
import { usageSummary } from "@/server/billing/usage";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ req, user }) => {
  await assertBillingAdmin(user);
  const m = new URL(req.url).searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new ApiError("חודש לא תקין", 400, "validation");
  return ok(await usageSummary(user.businessId, m));
});
