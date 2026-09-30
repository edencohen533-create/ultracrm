import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { publish } from "@/server/automations/journeys";

export const dynamic = "force-dynamic";
/** "שמירה והפעלה": the server re-runs every check and publishes a new version (or refuses with the checks). */
export const POST = withAuth(async ({ req, user, params }) => { const body = await req.json().catch(() => null) as { definition?: unknown } | null; return ok(await publish(user, params.id, body?.definition)); }, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
