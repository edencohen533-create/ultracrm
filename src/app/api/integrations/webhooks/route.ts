import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createEndpoint, endpointSchema, endpointView, WEBHOOK_EVENTS } from "@/server/services/integrations";

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => ok({ items: (await prisma.webhookEndpoint.findMany({ orderBy: { createdAt: "asc" } })).map((e) => endpointView(e)), events: WEBHOOK_EVENTS }), { minRole: "owner" });

export const POST = withAuth(async ({ req, user }) => {
  const e = await createEndpoint(user, await parseBody(req, endpointSchema));
  await audit(user.businessId, user.id, "webhook", e.id, "webhook.created", { url: e.url, events: e.events });
  return ok(endpointView(e, true), 201);
}, { minRole: "owner" });
