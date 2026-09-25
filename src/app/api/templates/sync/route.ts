import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { syncMetaTemplates, TemplateSyncError } from "@/server/services/template-sync-service";
export const maxDuration = 60;
export const POST = organizationRequest(async function() {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  try { return Response.json(await syncMetaTemplates()); }
  catch (error) {
    return Response.json({ error: error instanceof TemplateSyncError ? error.message : "סנכרון התבניות נכשל; לא בוצע סנכרון חלקי" }, { status: 502 });
  }
});
