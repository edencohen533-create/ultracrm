import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { sendTestWebhook } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

/** Send a sample payload now (e.g. so Make/Zapier can learn the data structure). */
export const POST = withAuth(async ({ params }) => {
  const e = await prisma.webhookEndpoint.findUnique({ where: { id: params.id } });
  if (!e) throw new ApiError("ה-Webhook לא נמצא", 404, "not_found");
  return ok(await sendTestWebhook(e));
}, { minRole: "owner" });
