import { requireBusinessId } from "@/lib/tenant";
import { AutomationPreviewError, validateAutomationReferences } from "@/server/services/automation-preview-service";
import { organizationRequest } from "@/lib/auth-compat";
import type { Prisma } from "@/generated/prisma/client";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { automationRuleSchema } from "@/lib/validation/automation";

export const POST = organizationRequest(async function(request: Request) {
  const session = await auth();
  if (!hasRole(session, ROLES_ADMIN_MANAGER)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = automationRuleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try { await validateAutomationReferences(parsed.data); }
  catch (error) { if (error instanceof AutomationPreviewError) return NextResponse.json({ error: error.message }, { status: 400 }); throw error; }
  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.automationRule.create({ data: { businessId: requireBusinessId(), ...parsed.data, actionConfig: parsed.data.actionConfig as Prisma.InputJsonObject, triggerConfig: parsed.data.triggerConfig as Prisma.InputJsonObject } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: session!.user.id, action: "automation.created", entityType: "AutomationRule", entityId: created.id, payload: { isActive: created.isActive } } });
    return created;
  });
  return NextResponse.json({ rule }, { status: 201 });
});
