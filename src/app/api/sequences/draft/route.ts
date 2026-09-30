import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { saveDraft } from "@/server/automations/journeys";

export const dynamic = "force-dynamic";
/** "שמירה" of a new journey → a draft that never runs until published. */
export const POST = withAuth(async ({ req, user }) => ok(await saveDraft(user, await req.json())), { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
