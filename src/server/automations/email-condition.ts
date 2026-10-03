import { prisma } from '@/lib/db';
import type { EmailCondition } from '@/lib/journey-email';
/** Negative conditions are absence of provider reports, never proof a person did not read/click. */
export async function emailConditionState(run: { id: string; contactId: string }, condition: EmailCondition, now = new Date()): Promise<'matched' | 'waiting' | 'expired' | 'missing'> {
  const sent = await prisma.message.findFirst({ where: { requestKey: `seq:${run.id}:${condition.sourceStep}`, channel: 'email', direction: 'OUTBOUND', conversation: { contactId: run.contactId } }, select: { id: true, status: true, providerMessageId: true, createdAt: true, acceptedAt: true, openedAt: true, clickedAt: true, deliveredAt: true, bouncedAt: true, failedAt: true, complainedAt: true } });
  if (!sent || (!sent.providerMessageId && condition.event !== 'failed')) return 'missing';
  const expires = new Date((sent.acceptedAt ?? sent.createdAt).getTime() + condition.timeoutMinutes * 60_000);
  const key = { opened: 'openedAt', not_opened: 'openedAt', clicked: 'clickedAt', not_clicked: 'clickedAt', delivered: 'deliveredAt', bounced: 'bouncedAt', failed: 'failedAt', complained: 'complainedAt' } as const;
  const at = sent[key[condition.event]];
  let reported = Boolean(at && at <= expires);
  if (condition.link && ['clicked', 'not_clicked'].includes(condition.event)) {
    reported = Boolean(await prisma.domainEvent.findFirst({ where: { type: 'email.engagement', contactId: run.contactId, occurredAt: { gte: new Date(Math.floor(sent.createdAt.getTime() / 1000) * 1000), lte: expires }, AND: [
      { payload: { path: ['messageId'], equals: sent.id } },
      { payload: { path: ['link'], equals: condition.link } },
      { payload: { path: ['status'], equals: 'CLICKED' } },
    ] }, select: { id: true } }));
  }
  const negative = condition.event === 'not_opened' || condition.event === 'not_clicked';
  if (negative) {
    if (reported) return 'expired';
    // A message rejected by the server is not a marketing non-responder.
    if (['FAILED', 'BOUNCED', 'CANCELLED'].includes(sent.status)) return 'missing';
    return now >= expires ? 'matched' : 'waiting';
  }
  return reported ? 'matched' : now >= expires ? 'expired' : 'waiting';
}
