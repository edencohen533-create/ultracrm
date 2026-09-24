import { z } from "zod";
import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { checkMetaConnection, MetaConnectionError } from "@/server/services/meta-connection-service";
import type { MetaWhatsAppConfig } from "@/server/providers/meta-whatsapp-provider";
export const POST = organizationRequest(async function(request: Request) {
  const session = await auth();
  if (session?.user?.role !== "owner") return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = z.object({ credentialId: z.string().min(1).optional() }).safeParse(await request.json().catch(() => ({})) ?? {});
  if (!parsed.success) return Response.json({ error: "מזהה מספר לא תקין" }, { status: 400 });
  const body = parsed.data;
  const active = await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api", ...(body.credentialId ? { id: body.credentialId } : {}) }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  if (!active) return Response.json({ error: "Meta אינו מחובר; המערכת במצב דמו" }, { status: 409 });
  try {
    const report = await checkMetaConnection(active.config as unknown as MetaWhatsAppConfig);
    await prisma.providerCredential.update({ where: { id: active.id }, data: { lastCheckedAt: new Date(), lastConnectionError: null, displayPhoneNumber: report.phoneNumber } });
    return Response.json(report);
  }
  catch (error) {
    await prisma.providerCredential.update({ where: { id: active.id }, data: { sendingBlocked: true, lastCheckedAt: new Date(), lastConnectionError: "אימות הגישה נכשל. בדוק Token והרשאות" } });
    return Response.json({ error: error instanceof MetaConnectionError ? error.message : "בדיקת החיבור נכשלה" }, { status: 502 }); }
});

export const maxDuration = 60;
