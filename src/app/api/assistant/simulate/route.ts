import crypto from "node:crypto";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertCanManageLink } from "@/server/assistant/access";
import { handleAssistantInbound } from "@/server/assistant/inbound";

export const dynamic = "force-dynamic";
const schema = z.object({ linkId: z.string(), text: z.string().trim().min(1).max(1000) });

/** Demo only (no live WhatsApp connection): runs the exact inbound path as if the linked phone had written. */
export const POST = withAuth(async ({ req, user }) => {
  if (await prisma.providerCredential.findFirst({ where: { businessId: user.businessId, channel: "whatsapp", isActive: true, provider: { not: "mock" } }, select: { id: true } })) throw new ApiError("סימולציה זמינה במצב דמו בלבד – בחיבור אמיתי שלח הודעה מהטלפון", 409, "live_connection");
  const b = await parseBody(req, schema);
  const link = await prisma.assistantLink.findFirst({ where: { id: b.linkId, businessId: user.businessId } });
  if (!link) throw new ApiError("לא נמצא", 404, "not_found");
  assertCanManageLink(user, link);
  const since = new Date();
  const handled = await handleAssistantInbound({ businessId: user.businessId, phoneE164: link.phoneE164, text: b.text, providerMessageId: `sim-${crypto.randomUUID()}` });
  const replies = await prisma.assistantMessage.findMany({ where: { linkId: link.id, direction: "out", createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { text: true, status: true, intent: true, tools: true, model: true } });
  return ok({ handled, replies });
}, { minRole: "manager" });
