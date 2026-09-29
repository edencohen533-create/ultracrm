import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ params }) => ok({ items: await prisma.webhookDelivery.findMany({ where: { endpointId: params.id }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, event: true, status: true, attempts: true, responseCode: true, error: true, createdAt: true, deliveredAt: true, nextAttemptAt: true } }) }), { minRole: "owner" });
