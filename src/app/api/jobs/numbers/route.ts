import { requireCronSecret } from "@/lib/api";
import { handleError } from "@/lib/response";
import { withBusiness } from "@/lib/tenant";
import { syncNumbers } from "@/lib/numbers/service";
import { numberConfig, isMockNumberProvider } from "@/lib/numbers/providers";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Daily inventory / verification refresh for the business bound to the provider account. Reputation: no authorised API. */
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const businessId = process.env.TELNYX_NUMBERS_BUSINESS_ID;
    if (isMockNumberProvider() || !businessId || !numberConfig(businessId).configured) return Response.json({ inventory: "unconfigured", reputation: "unsupported" });
    try { return Response.json({ ...(await withBusiness(businessId, () => syncNumbers(businessId))), reputation: "unsupported" }); }
    catch { return Response.json({ inventory: "failed", reputation: "unsupported" }, { status: 502 }); }
  } catch (err) { return handleError(err); }
}
