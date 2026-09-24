import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { listSendableTemplates } from "@/server/services/template-service";
export const GET = organizationRequest(async function() {
  if (!(await auth())?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ templates: await listSendableTemplates() });
});

export const POST = organizationRequest(async function(request: Request) {
  const { campaignActor } = await import("@/lib/campaign-auth");
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { submitTemplateSchema } = await import("@/lib/validation/template");
  const { submitMetaTemplate, TemplateSubmissionError } = await import("@/server/services/template-submit-service");
  const parsed = submitTemplateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "תבנית לא תקינה" }, { status: 400 });
  try { return Response.json({ template: await submitMetaTemplate(parsed.data) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof TemplateSubmissionError ? error.message : "הגשת התבנית נכשלה" }, { status: 502 }); }
});

export const maxDuration = 60;
