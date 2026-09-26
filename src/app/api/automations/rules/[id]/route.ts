import { requireBusinessId } from "@/lib/tenant";
import { automationRuleSchema } from "@/lib/validation/automation";
import { AutomationPreviewError, validateAutomationReferences } from "@/server/services/automation-preview-service";
import { organizationRequest } from "@/lib/auth-compat";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";

const patchSchema = z.object({ isActive: z.boolean() });

export const PATCH = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!hasRole(session, ROLES_ADMIN_MANAGER)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (parsed.data.isActive) {
    const valid = automationRuleSchema.safeParse(existing);
    if (!valid.success) return NextResponse.json({ error: "החוק אינו תקין להפעלה" }, { status: 400 });
    try { await validateAutomationReferences(valid.data); }
    catch (error) { if (error instanceof AutomationPreviewError) return NextResponse.json({ error: error.message }, { status: 400 }); throw error; }
  }
  const rule = await prisma.$transaction(async (tx) => {
    const updated = await tx.automationRule.update({ where: { id }, data: { isActive: parsed.data.isActive } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: session!.user.id, action: parsed.data.isActive ? "automation.activated" : "automation.paused", entityType: "AutomationRule", entityId: id } });
    return updated;
  });
  return NextResponse.json({ rule });
});

/** Delete a rule (managers). Pending scheduled runs of the rule are cancelled; history (audit + completed runs) is kept. */
export const DELETE = organizationRequest(async function(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!hasRole(session, ROLES_ADMIN_MANAGER)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const existing = await prisma.automationRule.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.$transaction(async (tx) => {
    await tx.automationRule.delete({ where: { id } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: session!.user.id, action: "automation.deleted", entityType: "AutomationRule", entityId: id, payload: { name: existing.name, trigger: existing.trigger, actionType: existing.actionType } } });
  });
  return NextResponse.json({ ok: true });
});

