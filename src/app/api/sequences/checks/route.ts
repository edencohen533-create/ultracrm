import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { publishChecks } from "@/server/automations/journeys";

export const dynamic = "force-dynamic";
/** Pre-activation checks + what the journey will do (external actions, audience, cost, running policy). Read-only. */
export const POST = withAuth(async ({ req, user }) => { const r = await publishChecks(user, await req.json()); return ok({ checks: r.checks, summary: r.summary }); }, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
