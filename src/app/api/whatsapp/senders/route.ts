import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { listSenderOptions } from "@/server/providers/provider-registry";
export const GET = organizationRequest(async function() {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "אין הרשאה" }, { status: 401 });
  const [senders, active] = await Promise.all([listSenderOptions(session), prisma.providerCredential.count({ where: { isActive: true, provider: "meta_whatsapp_cloud_api" } })]);
  return Response.json({ senders, mockAvailable: active === 0 });
});
