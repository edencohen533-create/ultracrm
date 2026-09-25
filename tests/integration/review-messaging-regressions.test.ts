import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import { db } from '@/lib/db';
import { withBusiness } from '@/lib/tenant';
import { createBusiness, destroyBusiness } from './helpers';
vi.mock('@/lib/events', async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));
import { saveChannelCredential } from '@/server/services/channel-credential-service';
import { saveChannelTemplate } from '@/server/services/channel-template-service';
import { sendChannelMessage } from '@/server/services/channel-send-service';
import { MockSmsProvider } from '@/server/channels/mock';
import { ChannelProviderError, ChannelRequestTimeout } from '@/server/channels/types';
import { createCampaign, changeCampaignStatus } from '@/server/services/campaign-service';
import { campaignSchema } from '@/lib/campaigns';
import { processDueCampaigns } from '@/jobs/campaign-runner';
import { sequenceSchema, saveSequence, processDueSequenceRuns } from '@/server/services/sequence-service';
import { processDueAutomationRuns } from '@/jobs/automation-runner';
let a: Awaited<ReturnType<typeof createBusiness>>;
let template: Awaited<ReturnType<typeof saveChannelTemplate>>, n = 0;
const run = <T,>(fn: () => Promise<T>) => withBusiness(a.business.id, fn, a.session);
async function contact() {
    return db.contact.create({ data: { businessId: a.business.id, fullName: 'Messaging Review', phoneRaw: `05012346${String(++n).padStart(2, '0')}`, phoneE164: `+9725012346${String(n).padStart(2, '0')}`, consentStatus: 'OPTED_IN' } });
}
async function campaign(c: {
    id: string;
}) {
    const list = await db.distributionList.create({ data: { businessId: a.business.id, name: 'review', members: { create: [{ contactId: c.id }] } } });
    const campaign = await run(() => createCampaign(campaignSchema.parse({ name: 'Review', channel: 'sms', templateId: template.id, listId: list.id }), a.user.id));
    await run(() => changeCampaignStatus(campaign.id, 'start', undefined, a.user.id));
    return campaign;
}
beforeAll(async () => {
    a = await createBusiness('review-msg');
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] }, minHoursBetweenMarketing: 24 } } } });
    await run(() => saveChannelCredential(a.session, 'sms', { provider: 'mock_sms', label: 'Review', senders: [{ value: '+972501110000', type: 'number', inbound: true }] }));
    template = await run(() => saveChannelTemplate(a.session, { channel: 'sms', name: 'review_sms', category: 'MARKETING', body: 'Hello' }));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
    await destroyBusiness(a.business.id, [a.account.id]);
    await db.$disconnect();
});
it('M01: explicit provider failure must release marketing frequency reservation', async () => {
    const c = await contact();
    const spy = vi.spyOn(MockSmsProvider.prototype, 'send').mockRejectedValueOnce(new ChannelProviderError('rate limited', 429));
    const input = { channel: 'sms' as const, contactId: c.id, templateId: template.id, category: 'marketing' as const, sentByUserId: a.user.id, requestKey: `review-first:${c.id}` };
    const first = await run(() => sendChannelMessage(input));
    expect(first.message.retryable).toBe(true);
    await expect(run(() => sendChannelMessage({ ...input, requestKey: `review-retry:${c.id}` }))).resolves.toMatchObject({ message: { status: 'ACCEPTED' } });
    expect(spy).toHaveBeenCalledTimes(2);
});
it('M02: campaign timeout must remain UNKNOWN rather than SKIPPED', async () => {
    const c = await contact();
    const cp = await campaign(c);
    vi.spyOn(MockSmsProvider.prototype, 'send').mockRejectedValueOnce(new ChannelRequestTimeout());
    await run(() => processDueCampaigns());
    const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: cp.id } });
    const msg = await db.message.findUniqueOrThrow({ where: { id: recipient.messageId! } });
    expect(msg.status).toBe('UNKNOWN');
    expect(recipient.status).toBe('UNKNOWN');
});
it('M03: network failure after dispatch must preserve an uncertain message', async () => {
    const c = await contact();
    const key = `review-network:${c.id}`;
    vi.spyOn(MockSmsProvider.prototype, 'send').mockRejectedValueOnce(new ChannelProviderError('socket reset after provider accepted request'));
    await expect(run(() => sendChannelMessage({ channel: 'sms', contactId: c.id, templateId: template.id, category: 'marketing', sentByUserId: a.user.id, requestKey: key }))).rejects.toThrow();
    expect(await db.message.findUnique({ where: { requestKey: key } })).toMatchObject({ status: 'UNKNOWN' });
});
it('M04: sequence must not mark a rejected send as successfully completed', async () => {
    const c = await contact();
    const seq = await run(() => saveSequence(a.session, sequenceSchema.parse({ name: 'Fail send', trigger: 'CONTACT_CREATED', steps: [{ channel: 'sms', templateId: template.id, waitMinutes: 0 }] })));
    const r = await db.sequenceRun.create({ data: { businessId: a.business.id, sequenceId: seq.id, contactId: c.id, sourceKey: `review:${c.id}`, nextAt: new Date(0) } });
    vi.spyOn(MockSmsProvider.prototype, 'send').mockResolvedValueOnce({ providerMessageId: 'rejected', status: 'FAILED', error: 'Invalid destination' });
    await run(() => processDueSequenceRuns());
    const saved = await db.sequenceRun.findUniqueOrThrow({ where: { id: r.id } });
    expect(saved.status).not.toBe('COMPLETED');
});
it('M05: automation claimed before a process crash must not remain RUNNING forever', async () => {
    const c = await contact();
    const cv = await db.conversation.create({ data: { businessId: a.business.id, contactId: c.id, lastInboundAt: new Date() } });
    const rule = await db.automationRule.create({ data: { businessId: a.business.id, name: 'Stale run', trigger: 'NO_REPLY_TIMEOUT', actionType: 'CREATE_TASK', actionConfig: { title: 'Follow up' } } });
    const r = await db.automationRun.create({ data: { businessId: a.business.id, ruleId: rule.id, conversationId: cv.id, status: 'RUNNING', scheduledFor: new Date(0), createdAt: new Date(0), attempts: 1 } });
    await run(() => processDueAutomationRuns());
    expect((await db.automationRun.findUniqueOrThrow({ where: { id: r.id } })).status).not.toBe('RUNNING');
});
it('M06: rejected campaign start must not consume monthly campaign quota', async () => {
    const { currentUsage } = await import('@/lib/modules');
    const before = await currentUsage(a.business.id, 'campaigns_started');
    await expect(run(() => changeCampaignStatus('missing-campaign-id', 'start', undefined, a.user.id))).rejects.toThrow();
    expect(await currentUsage(a.business.id, 'campaigns_started')).toBe(before);
});
it('M07: a campaign retries a rate-limit rejection and sends exactly once successfully', async () => {
    const c = await contact();
    const cp = await campaign(c);
    const send = vi.spyOn(MockSmsProvider.prototype, 'send').mockRejectedValueOnce(new ChannelProviderError('rate limited', 429));
    await run(() => processDueCampaigns());
    const recipient = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: cp.id } });
    expect(recipient).toMatchObject({ status: 'QUEUED', attempts: 1 });
    await db.campaignRecipient.update({ where: { id: recipient.id }, data: { nextAttemptAt: new Date(0) } });
    await run(() => processDueCampaigns());
    await run(() => processDueCampaigns());
    const sent = await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id }, include: { message: true } });
    expect(sent.status).toBe('SENT');
    expect(sent.message?.status).toBe('ACCEPTED');
    expect(send).toHaveBeenCalledTimes(2);
});
it('M08: quota exhaustion rolls back the campaign transition and counter', async () => {
    const { currentUsage, invalidateEntitlements } = await import('@/lib/modules');
    const before = await currentUsage(a.business.id, 'campaigns_started');
    const plan = await db.plan.create({ data: { key: `review-limit-${a.business.id}`, name: 'Limit', modules: {}, quotas: { campaigns_started: before } } });
    await db.business.update({ where: { id: a.business.id }, data: { planId: plan.id } });
    invalidateEntitlements(a.business.id);
    try {
        const c = await contact();
        const list = await db.distributionList.create({ data: { businessId: a.business.id, name: 'Quota', members: { create: [{ contactId: c.id }] } } });
        const cp = await run(() => createCampaign(campaignSchema.parse({ name: 'Quota', channel: 'sms', templateId: template.id, listId: list.id }), a.user.id));
        await expect(run(() => changeCampaignStatus(cp.id, 'start', undefined, a.user.id))).rejects.toThrow(/מכסת/);
        expect((await db.campaign.findUniqueOrThrow({ where: { id: cp.id } })).status).toBe('DRAFT');
        expect(await currentUsage(a.business.id, 'campaigns_started')).toBe(before);
    }
    finally {
        await db.business.update({ where: { id: a.business.id }, data: { planId: null } });
        invalidateEntitlements(a.business.id);
        await db.plan.delete({ where: { id: plan.id } });
    }
});
it('M09: duplicate start consumes quota only once', async () => {
    const { currentUsage } = await import('@/lib/modules');
    const before = await currentUsage(a.business.id, 'campaigns_started');
    const cp = await campaign(await contact());
    expect(await currentUsage(a.business.id, 'campaigns_started')).toBe(before + 1);
    await expect(run(() => changeCampaignStatus(cp.id, 'start', undefined, a.user.id))).rejects.toThrow();
    expect(await currentUsage(a.business.id, 'campaigns_started')).toBe(before + 1);
});
it('M10: an old scheduled automation with a fresh claim is not reaped', async () => {
    const rule = await db.automationRule.create({ data: { businessId: a.business.id, name: 'Fresh claim', trigger: 'NO_REPLY_TIMEOUT', actionType: 'CREATE_TASK', actionConfig: {} } });
    const active = await db.automationRun.create({ data: { businessId: a.business.id, ruleId: rule.id, status: 'RUNNING', createdAt: new Date(0), scheduledFor: new Date(0), claimedAt: new Date() } });
    await run(() => processDueAutomationRuns());
    expect((await db.automationRun.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('RUNNING');
});
it('M11: repeating an uncertain request never invokes the provider again', async () => {
    const c = await contact();
    const send = vi.spyOn(MockSmsProvider.prototype, 'send').mockRejectedValueOnce(new ChannelProviderError('socket closed'));
    const input = { channel: 'sms' as const, contactId: c.id, templateId: template.id, category: 'marketing' as const, requestKey: `uncertain:${c.id}`, sentByUserId: a.user.id };
    await expect(run(() => sendChannelMessage(input))).rejects.toMatchObject({ code: 'send_outcome_unknown' });
    await expect(run(() => sendChannelMessage(input))).rejects.toMatchObject({ code: 'send_outcome_unknown' });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).lastMarketingAt).not.toBeNull();
});
