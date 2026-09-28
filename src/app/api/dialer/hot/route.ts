import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { hotSignalsFor } from "@/lib/dialer/availability";

export const dynamic = "force-dynamic";
/** WhatsApp availability replies for the agent's leads (managers: within their data scope). */
export const GET = withAuth(async ({ user }) => ok({ items: await hotSignalsFor(user) }), { perm: "telephony.use" });
