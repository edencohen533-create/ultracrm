import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { cancelFollowUp, followUpSchema, scheduleFollowUp } from "@/lib/crm/lead-ops";

export const dynamic = "force-dynamic";

/** Set / move the follow-up (date + time in the business timezone are mandatory; note optional). */
export const PUT = withAuth(async ({ req, user, params }) => ok(await scheduleFollowUp(user, params.id, await parseBody(req, followUpSchema))), { module: "crm" });

/** Cancel the follow-up (the lead returns to "נוצר קשר" and leaves the callback queue). */
export const DELETE = withAuth(async ({ user, params }) => { await cancelFollowUp(user, params.id); return ok({ cancelled: true }); }, { module: "crm" });
