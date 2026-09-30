import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { setJourneyStatus } from "@/server/automations/journeys";

export const dynamic = "force-dynamic";
/** Explicit pause / resume from the automations list. */
export const POST = withAuth(async ({ req, user, params }) => ok(await setJourneyStatus(user, params.id, (await parseBody(req, z.object({ status: z.enum(["active", "paused"]) }))).status)), { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
