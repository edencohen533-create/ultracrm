import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { getPaymentRequest } from "@/server/services/payment-service";

export const dynamic = "force-dynamic";

/** Current status – confirmed by the provider (a pending request is re-checked with it). */
export const GET = withAuth(async ({ user, params }) => ok(await getPaymentRequest(user, params.id)), { perm: "crm.payments" });
