import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { agentSettingsSchema } from "@/lib/agent-settings-schema";
import { settingsOverview, saveAgentSettings } from "@/lib/agent-settings";
export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ req, user }) => ok(await settingsOverview(user, req.nextUrl.searchParams.get("userId") || user.id)), { module: "crm" });
export const PUT = withAuth(async ({ req, user }) => {
  const body = await parseBody(req, z.object({ userId: z.string().optional(), settings: agentSettingsSchema }));
  return ok(await saveAgentSettings(user, body.userId || user.id, body.settings));
}, { module: "crm" });
