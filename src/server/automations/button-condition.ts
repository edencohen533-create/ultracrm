import { prisma } from '@/lib/db';
import type { WhatsAppButtonCondition } from '@/lib/journey-buttons';
/** Correlate the callback to this run's exact outbound message, contact and sender. Text messages never qualify. */
export async function whatsappButtonState(run: { id: string; contactId: string }, condition: WhatsAppButtonCondition, now = new Date()): Promise<'matched' | 'waiting' | 'expired' | 'missing'> {
  const sent = await prisma.message.findFirst({ where: { requestKey: `seq:${run.id}:${condition.sourceStep}`, direction: 'OUTBOUND', channel: 'whatsapp', conversation: { contactId: run.contactId } }, select: { providerMessageId: true, providerCredentialId: true, createdAt: true, acceptedAt: true, status: true } });
  if (!sent?.providerMessageId || !['ACCEPTED', 'SENT', 'DELIVERED', 'READ'].includes(sent.status)) return 'missing';
  const start = sent.acceptedAt ?? sent.createdAt;
  const expires = new Date(start.getTime() + condition.timeoutMinutes * 60_000);
  const reply = await prisma.domainEvent.findFirst({ where: { type: 'message.received', contactId: run.contactId, occurredAt: { gte: new Date(Math.floor(sent.createdAt.getTime() / 1000) * 1000), lte: expires }, AND: [
    { payload: { path: ['channel'], equals: 'whatsapp' } },
    { payload: { path: ['providerCredentialId'], equals: sent.providerCredentialId ?? '' } },
    { payload: { path: ['whatsappReply', 'contextMessageId'], equals: sent.providerMessageId } },
    { payload: { path: ['whatsappReply', 'buttonText'], equals: condition.buttonText } },
  ] }, select: { id: true } });
  if (reply) return 'matched';
  return now >= expires ? 'expired' : 'waiting';
}
