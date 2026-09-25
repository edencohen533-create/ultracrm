import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { organizationRequest } from "@/lib/auth-compat";
import { automationRuleSchema } from "@/lib/validation/automation";
import { AutomationPreviewError, previewAutomation } from "@/server/services/automation-preview-service";
export const maxDuration = 60;
export const POST = organizationRequest(async function(request: Request) {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parsed = z.object({ rule: automationRuleSchema, conversationId: z.string().min(1).max(200) }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "יש למלא פרטי חוק ושיחת בדיקה תקינים" }, { status: 400 });
  try { return NextResponse.json(await previewAutomation(parsed.data.rule, parsed.data.conversationId)); }
  catch (error) { if (error instanceof AutomationPreviewError) return NextResponse.json({ error: error.message }, { status: 400 }); throw error; }
});
