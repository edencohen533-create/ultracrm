import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { sendPaymentLink } from "@/server/services/payment-service";

export const dynamic = "force-dynamic";
export const POST = withAuth(async ({ user, params }) => ok(await sendPaymentLink(user, params.id)), { perm: ["crm.payments"] });
