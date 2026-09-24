import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { getTelephony } from "@/lib/telephony";
import { processProviderEvent } from "@/lib/telephony/events";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** SIMULATION ONLY: pretend a customer calls one of the business numbers. */
export const POST = withAuth(async ({ req, user }) => {
  if (!getTelephony().simulation) throw new ApiError("זמין רק במצב הדמיה", 400, "not_simulation");
  const b = await parseBody(req, z.object({ from: z.string().min(3), to: z.string().optional() }));
  const to = b.to ?? (await prisma.phoneNumber.findFirst({ where: { businessId: user.businessId, isActive: true, isDefault: true } }))?.e164;
  if (!to) throw new ApiError("לעסק אין מספר", 400, "no_number");
  const ownNumber = await prisma.phoneNumber.findFirst({ where: { businessId: user.businessId, e164: to, isActive: true } });
  if (!ownNumber) throw new ApiError("המספר אינו שייך לעסק", 400, "invalid_from_number");
  const legId = `mock-inbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await processProviderEvent({
    provider: "mock",
    eventId: `mock:inbound:${legId}`,
    type: "leg.initiated",
    legId,
    direction: "incoming",
    from: b.from,
    to,
    occurredAt: new Date(),
    raw: { simulated: true, inbound: true },
  });
  const call = r.callId ? await prisma.call.findUnique({ where: { id: r.callId }, select: { id: true, userId: true, status: true, routingNote: true, telephonyResult: true, contactId: true } }) : null;
  return ok(call);
}, { minRole: "manager" });
