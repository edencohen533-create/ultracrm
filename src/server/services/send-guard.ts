import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";

export class SendConflictError extends Error {}

/** Lease only serializes in-flight sends. A crash expires it; a persisted
 * request key is separately retained forever and is never automatically retried. */
export async function acquireSendLease(conversationId: string) {
  const token = randomUUID();
  const now = new Date();
  const claim = await prisma.conversation.updateMany({
    where: { id: conversationId, OR: [{ sendLockUntil: null }, { sendLockUntil: { lt: now } }] },
    data: { sendLockToken: token, sendLockUntil: new Date(now.getTime() + 120_000) },
  });
  if (!claim.count) throw new SendConflictError("הודעה אחרת נשלחת כעת בשיחה. המתן ובדוק את ההיסטוריה לפני מענה");
  return async () => { await prisma.conversation.updateMany({ where: { id: conversationId, sendLockToken: token }, data: { sendLockToken: null, sendLockUntil: null } }); };
}
