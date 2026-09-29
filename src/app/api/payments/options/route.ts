import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { paymentOptions } from "@/server/services/payment-service";

export const dynamic = "force-dynamic";

/** For the in-call payment window: provider, customer, products / quotes / open deals, requests of this call. */
export const GET = withAuth(async ({ req, user }) => {
  const u = new URL(req.url); const contactId = u.searchParams.get("contactId");
  if (!contactId) throw new ApiError("חסר איש קשר", 400, "validation");
  return ok(await paymentOptions(user, contactId, u.searchParams.get("callId")));
}, { perm: "crm.payments" });
