import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings, mergeSettings } from "@/lib/settings";
import { telephonyStatus } from "@/lib/telephony";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const b = await prisma.business.findUnique({ where: { id: user.businessId }, select: { id: true, name: true, timezone: true } });
  return ok({ business: b, settings: await getBusinessSettings(user.businessId), telephony: telephonyStatus() });
});

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().optional(),
  settings: z
    .object({
      wrapUpSeconds: z.number().int().min(0).max(600).optional(),
      autoDialCountdownSeconds: z.number().int().min(0).max(60).optional(),
      maxAttempts: z.number().int().min(1).max(20).optional(),
      retryIntervalMinutes: z.number().int().min(1).max(10080).optional(),
      busyRetryMinutes: z.number().int().min(1).max(1440).optional(),
      lockTtlSeconds: z.number().int().min(30).max(600).optional(),
      ringTimeoutSeconds: z.number().int().min(10).max(90).optional(),
      recordingEnabled: z.boolean().optional(),
      recordingAnnouncement: z.string().max(500).optional(),
      recordingRetentionDays: z.number().int().min(0).max(3650).optional(),
      technicalFailureRetryMinutes: z.number().int().min(1).max(1440).optional(),
      amdEnabled: z.boolean().optional(),
      stickyOwner: z.boolean().optional(),
      removeFromOtherListsOnSale: z.boolean().optional(),
      dialingPaused: z.boolean().optional(),
      allowedCountries: z.array(z.string().length(2)).max(50).optional(),
      maxDialsPerMinute: z.number().int().min(0).max(120).optional(),
      prioritization: z.object({
        callbackDue: z.number().min(0).max(1000), priority: z.number().min(0).max(100), newLeadPerHour: z.number().min(0).max(100), newLeadMaxHours: z.number().min(0).max(720),
        agingPerHour: z.number().min(0).max(100), agingMaxHours: z.number().min(0).max(2000), attemptPenalty: z.number().min(0).max(1000), ownerMatch: z.number().min(0).max(1000),
        sourceWeights: z.record(z.string().max(100), z.number().min(-1000).max(1000)), interestedBefore: z.number().min(0).max(1000),
      }).partial().optional(),
      inbound: z.object({ preferOwner: z.boolean(), noAgentAction: z.literal("hangup"), createCallbackTask: z.boolean(), respectDialWindow: z.boolean() }).partial().optional(),
      dialWindow: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), days: z.array(z.number().int().min(0).max(6)), timezone: z.string().optional() }).optional(),
    })
    .optional(),
});

export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const current = await prisma.business.findUnique({ where: { id: user.businessId }, select: { settings: true, name: true, timezone: true } });
  const before = mergeSettings(current?.settings);
  const merged = mergeSettings({ ...before, ...(b.settings ?? {}), prioritization: { ...before.prioritization, ...(b.settings?.prioritization ?? {}) }, inbound: { ...before.inbound, ...(b.settings?.inbound ?? {}) } });
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(merged) as (keyof typeof merged)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(merged[k])) changed[k] = { from: before[k], to: merged[k] };
  }
  if (b.name && b.name !== current?.name) changed.name = { from: current?.name, to: b.name };
  if (b.timezone && b.timezone !== current?.timezone) changed.timezone = { from: current?.timezone, to: b.timezone };
  if (Object.keys(changed).length) await audit(user.businessId, user.id, "settings", user.businessId, "settings.updated", { changed });
  const updated = await prisma.business.update({
    where: { id: user.businessId },
    data: { ...(b.name ? { name: b.name } : {}), ...(b.timezone ? { timezone: b.timezone } : {}), settings: merged as unknown as Prisma.InputJsonValue },
    select: { id: true, name: true, timezone: true, settings: true },
  });
  return ok(updated);
}, { minRole: "admin" });
