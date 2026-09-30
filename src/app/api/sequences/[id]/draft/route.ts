import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { saveDraft } from "@/server/automations/journeys";

export const dynamic = "force-dynamic";
/** "שמירה" of an existing journey → only the unpublished draft changes; the live version keeps running. */
export const PUT = withAuth(async ({ req, user, params }) => ok(await saveDraft(user, await req.json(), params.id)), { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
