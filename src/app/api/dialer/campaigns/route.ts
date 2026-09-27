import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { campaignsFor } from "@/lib/dialer/exhaustion";

export const dynamic = "force-dynamic";
/** Campaigns this user may dial in, with how many leads are dialable for them right now. */
export const GET = withAuth(async ({ user }) => ok({ items: await campaignsFor(user) }), { module: "telephony" });
