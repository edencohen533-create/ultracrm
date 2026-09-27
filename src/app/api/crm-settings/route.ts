import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { agentSettingsSchema } from "@/lib/agent-settings-schema";
import { settingsOverview, saveAgentSettings } from "@/lib/agent-settings";
import { assertAccess } from "@/lib/access/engine";
export const dynamic = "force-dynamic";
/** Own settings: "שינוי הגדרות אישיות"; another user's settings: "ניהול הגדרות צוות" (and within the data scope). */
async function assertTarget(user: Parameters<typeof assertAccess>[0], targetId: string) {
  await assertAccess(user, targetId === user.id ? ["telephony.personal_settings", "telephony.team_settings"] : "telephony.team_settings");
}
export const GET = withAuth(async ({ req, user }) => { const target = req.nextUrl.searchParams.get("userId") || user.id; await assertTarget(user, target); return ok(await settingsOverview(user, target)); }, { perm: ["telephony.personal_settings", "telephony.team_settings"] });
export const PUT = withAuth(async ({ req, user }) => {
  const body = await parseBody(req, z.object({ userId: z.string().optional(), settings: agentSettingsSchema }));
  await assertTarget(user, body.userId || user.id);
  return ok(await saveAgentSettings(user, body.userId || user.id, body.settings));
}, { perm: ["telephony.personal_settings", "telephony.team_settings"] });
