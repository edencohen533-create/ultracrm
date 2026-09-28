import { z } from "zod";
import { organizationRequest } from "@/lib/auth-compat";

const schema = z.object({ displayName: z.string().trim().max(120).nullable() });

/** Rename a WhatsApp template in the app (display name only – the name at Meta is fixed and still used for sending). */
export const PATCH = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { campaignActor } = await import("@/lib/campaign-auth");
  const actor = await campaignActor();
  if (!actor) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "שם לא תקין (עד 120 תווים)" }, { status: 400 });
  const { renameTemplate, withDisplayName } = await import("@/server/services/template-service");
  const { id } = await params;
  const t = await renameTemplate(id, parsed.data.displayName);
  if (!t) return Response.json({ error: "תבנית לא נמצאה" }, { status: 404 });
  const { audit } = await import("@/lib/audit");
  const { requireBusinessId } = await import("@/lib/tenant");
  await audit(requireBusinessId(), actor.id, "template", t.id, "template.renamed", { displayName: t.displayName, metaName: t.name });
  return Response.json({ template: withDisplayName(t) });
}, ["whatsapp.campaign_draft", "whatsapp.automations"]);
