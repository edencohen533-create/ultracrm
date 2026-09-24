/**
 * Call lifecycle: start (idempotent), state poll + reconciliation, hangup,
 * outcome, DTMF. The provider is the source of truth for "answered".
 */
import { Prisma } from "@/generated/prisma/client";
import type { DialMode, OutcomeKey } from "@/generated/prisma/enums";
import { lockAgent } from "./locking";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { normalizePhone } from "@/lib/phone";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { getTelephony } from "@/lib/telephony";
import { TelephonyRequestTimeout } from "@/lib/telephony/types";
import { dueMockEvents } from "@/lib/telephony/mock";
import { afterCallFinalized, dialLeadLeg, processProviderEvent } from "@/lib/telephony/events";
import { getBusinessSettings, isWithinDialWindow } from "@/lib/settings";
import { OUTCOME_BY_KEY } from "@/lib/outcomes";
import { applyOutcomeToLead, assertListAccess, assertLeadLock, isDnc, listDialWindow } from "@/lib/dialer/queue";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";

export const CALL_INCLUDE = {
  contact: { select: { id: true, fullName: true, phoneE164: true, company: true } },
  lead: { select: { id: true, listId: true, lockToken: true, attempts: true, status: true } },
  phoneNumber: { select: { id: true, e164: true, label: true } },
} satisfies Prisma.CallInclude;

export type CallWithRefs = Prisma.CallGetPayload<{ include: typeof CALL_INCLUDE }>;

export interface StartCallInput {
  idempotencyKey: string;
  mode: DialMode;
  sessionId?: string;
  browserSessionId?: string;
  leadId?: string;
  lockToken?: string;
  contactId?: string;
  phone?: string;
  phoneNumberId?: string;
}

async function resolveFromNumber(businessId: string, phoneNumberId?: string, listId?: string) {
  if (!phoneNumberId && listId) {
    const list = await prisma.dialList.findFirst({ where: { id: listId, businessId }, select: { phoneNumberId: true } });
    if (list?.phoneNumberId) {
      const n = await prisma.phoneNumber.findFirst({ where: { id: list.phoneNumberId, businessId, isActive: true } });
      if (n) return n;
    }
  }
  if (phoneNumberId) {
    const n = await prisma.phoneNumber.findFirst({ where: { id: phoneNumberId, businessId, isActive: true } });
    if (!n) throw new ApiError("המספר היוצא שנבחר אינו מורשה לעסק", 400, "invalid_from_number");
    return n;
  }
  const n =
    (await prisma.phoneNumber.findFirst({ where: { businessId, isActive: true, isDefault: true } })) ??
    (await prisma.phoneNumber.findFirst({ where: { businessId, isActive: true }, orderBy: { createdAt: "asc" } }));
  if (!n) throw new ApiError("לא הוגדר מספר יוצא מורשה לעסק – הוסף מספר בהגדרות", 400, "no_from_number");
  return n;
}

/** Find or create the contact for a manually dialed number. */
async function contactForPhone(businessId: string, userId: string, phoneE164: string, raw: string) {
  return prisma.contact.upsert({
    where: { businessId_phoneE164: { businessId, phoneE164 } },
    update: {},
    create: { businessId, fullName: "מספר לא מזוהה", phoneE164, phoneRaw: raw, source: "manual_dial", ownerUserId: userId },
  });
}

export async function startCall(user: SessionUser, input: StartCallInput): Promise<CallWithRefs> {
  // Idempotency: the same key always returns the same call (double-click / retry / timeout safe).
  const existing = await prisma.call.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: CALL_INCLUDE });
  if (existing) {
    if (existing.userId !== user.id) throw new ApiError("מפתח בקשה לא תקין", 400, "bad_idempotency_key");
    return existing;
  }

  const live = await prisma.call.findUnique({ where: { activeForUser: user.id }, include: CALL_INCLUDE });
  if (live) throw new ApiError("יש לך כבר שיחה פעילה", 409, "call_active", { callId: live.id });

  if (input.mode !== "manual" && (!input.sessionId || !input.leadId || !input.lockToken)) {
    throw new ApiError("נדרש סשן פעיל וליד נעול", 409, "session_required");
  }
  const pending = await pendingWrapUpFor(user.id);
  if (pending) throw new ApiError("יש לשמור את תוצאת השיחה הקודמת", 409, "outcome_required");

  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { sipUsername: true } });
  const telephony = getTelephony();
  const sipUsername = me?.sipUsername ?? (telephony.simulation ? `mock-${user.id.slice(-6)}` : null);
  if (!sipUsername) throw new ApiError("הדפדפן לא מחובר לטלפוניה – רענן את החיבור", 409, "browser_not_registered");

  // Destination
  let contactId: string;
  let toE164: string;
  let leadId: string | undefined;
  let listId: string | undefined;
  if (input.leadId) {
    // DNC first, so a number blocked while the agent held the lead gets the right message.
    const pre = await prisma.listLead.findFirst({ where: { id: input.leadId, businessId: user.businessId }, select: { contact: { select: { phoneE164: true } } } });
    if (pre && (await isDnc(user.businessId, pre.contact.phoneE164))) throw new ApiError("המספר חסום – לא ליצור קשר", 403, "dnc_blocked");
    const lead = await assertLeadLock(user.id, input.leadId, input.lockToken);
    if (lead.status === "in_call") throw new ApiError("כבר יש שיחה לליד זה", 409, "call_active");
    if (lead.businessId !== user.businessId) throw new ApiError("ליד לא נמצא", 404, "not_found");
    await assertListAccess(user.businessId, user.id, user.role, lead.listId);
    const window = await listDialWindow(user.businessId, lead.listId);
    if (!isWithinDialWindow(window)) {
      throw new ApiError("מחוץ לחלון החיוג של הרשימה", 409, "outside_dial_window", { window });
    }
    contactId = lead.contactId;
    toE164 = lead.contact.phoneE164;
    leadId = lead.id;
    listId = lead.listId;
  } else if (input.contactId) {
    const c = await prisma.contact.findFirst({ where: { id: input.contactId, businessId: user.businessId } });
    if (!c) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
    contactId = c.id;
    toE164 = c.phoneE164;
  } else if (input.phone) {
    const e164 = normalizePhone(input.phone);
    if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
    const c = await contactForPhone(user.businessId, user.id, e164, input.phone);
    contactId = c.id;
    toE164 = e164;
  } else {
    throw new ApiError("חסר יעד לחיוג", 400, "missing_destination");
  }

  // DNC is checked again at the moment of dialing – for every mode.
  if (await isDnc(user.businessId, toE164)) {
    throw new ApiError("המספר חסום – לא ליצור קשר", 403, "dnc_blocked");
  }

  const settings = await getBusinessSettings(user.businessId);
  // Business-level kill switch (manager stops all new outbound dials).
  if (settings.dialingPaused) throw new ApiError("החיוג מושהה ברמת העסק על ידי המנהל", 409, "dialing_paused");
  // Destination country restriction.
  if (settings.allowedCountries.length > 0) {
    const country = parsePhoneNumberFromString(toE164)?.country ?? "??";
    if (!settings.allowedCountries.includes(country)) throw new ApiError(`חיוג ליעד ${country} אינו מורשה לעסק`, 403, "country_not_allowed", { country });
  }
  // Per-agent rate limit (counts dials created in the last 60s).
  if (settings.maxDialsPerMinute > 0) {
    const recent = await prisma.call.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 60_000) } } });
    if (recent >= settings.maxDialsPerMinute) throw new ApiError("חרגת ממגבלת קצב החיוג – המתן רגע", 429, "rate_limited", { limit: settings.maxDialsPerMinute });
  }
  // Same normalized number must not be in a live call anywhere in the business (duplicate cards).
  const liveSame = await prisma.call.findFirst({ where: { businessId: user.businessId, toE164, endedAt: null }, select: { id: true, userId: true } });
  if (liveSame) throw new ApiError("המספר הזה כבר בשיחה פעילה אצל נציג אחר", 409, "number_in_call", { callId: liveSame.id });

  const from = await resolveFromNumber(user.businessId, input.phoneNumberId, listId);

  // Session validation (power/preview must run inside a live session owned by this tab)
  let sessionId: string | undefined;
  if (input.sessionId) {
    const s = await prisma.dialerSession.findFirst({ where: { id: input.sessionId, userId: user.id, status: { in: ["active", "paused"] } } });
    if (!s) throw new ApiError("הסשן הסתיים – התחל סשן חדש", 409, "session_ended");
    if (s.browserSessionId !== input.browserSessionId) {
      throw new ApiError("החיוג פעיל בלשונית אחרת", 409, "session_taken");
    }
    if (s.status === "paused") throw new ApiError("הסשן מושהה", 409, "session_paused");
    if (input.mode !== "manual" && (s.mode !== input.mode || s.listId !== listId)) throw new ApiError("הליד אינו שייך לסשן", 409, "session_mismatch");
    sessionId = s.id;
  }

  let call: CallWithRefs;
  let createdHere = false;
  try {
    call = await prisma.$transaction(async (tx) => {
      await lockAgent(tx, user.id);
      // A transaction-scoped destination lock closes the race between different agents.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${user.businessId + ":" + toE164}, 0))`);
      const duplicate = await tx.call.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: CALL_INCLUDE });
      if (duplicate) {
        if (duplicate.userId !== user.id || duplicate.businessId !== user.businessId) throw new ApiError("מפתח בקשה לא תקין", 400, "bad_idempotency_key");
        return duplicate;
      }
      if (await tx.call.findUnique({ where: { activeForUser: user.id } })) throw new ApiError("יש שיחה פעילה", 409, "call_active");
      if (await tx.call.findFirst({ where: { businessId: user.businessId, toE164, endedAt: null } })) throw new ApiError("המספר כבר בשיחה", 409, "number_in_call");
      if (await tx.call.findFirst({ where: { userId: user.id, endedAt: { not: null }, outcomeSavedAt: null } })) throw new ApiError("נדרש תיעוד שיחה", 409, "outcome_required");
      if (!sessionId && await tx.dialerSession.findFirst({ where: { userId: user.id, status: "paused" } })) throw new ApiError("הסשן מושהה", 409, "session_paused");
      if (sessionId) {
        const current = await tx.dialerSession.findUnique({ where: { id: sessionId } });
        if (!current || current.status === "ended") throw new ApiError("הסשן הסתיים", 409, "session_ended");
        if (current.status === "paused") throw new ApiError("הסשן מושהה", 409, "session_paused");
        if (current.browserSessionId !== input.browserSessionId) throw new ApiError("הסשן בלשונית אחרת", 409, "session_taken");
      }
      if (leadId) {
        const lead = await tx.listLead.findUnique({ where: { id: leadId }, include: { list: true } });
        if (!lead || lead.status !== "locked" || lead.lockedByUserId !== user.id || lead.lockToken !== input.lockToken || !lead.lockExpiresAt || lead.lockExpiresAt.getTime() < Date.now()) throw new ApiError("נעילת הליד פגה", 409, "lock_lost");
        if (lead.list.isPaused || !lead.list.isActive || lead.list.archivedAt) throw new ApiError("הרשימה אינה זמינה לחיוג", 409, "list_paused");
      }
      if (await tx.dncEntry.findUnique({ where: { businessId_phoneE164: { businessId: user.businessId, phoneE164: toE164 } } })) throw new ApiError("המספר חסום", 403, "dnc_blocked");
      const created = await tx.call.create({
        data: {
          businessId: user.businessId,
          userId: user.id,
          sessionId,
          listId,
          leadId,
          contactId,
          mode: input.mode,
          provider: telephony.name,
          idempotencyKey: input.idempotencyKey,
          activeForUser: user.id,
          toE164,
          fromE164: from.e164,
          phoneNumberId: from.id,
          status: "created",
        },
        include: CALL_INCLUDE,
      });
      if (leadId) {
        const claimed = await tx.listLead.updateMany({
          where: { id: leadId, status: "locked", lockedByUserId: user.id, lockToken: input.lockToken, lockExpiresAt: { gte: new Date() } },
          data: {
            status: "in_call",
            attempts: { increment: 1 },
            lastAttemptAt: new Date(),
            lockExpiresAt: new Date(Date.now() + (settings.lockTtlSeconds + 3600) * 1000),
          },
        });
        if (!claimed.count) throw new ApiError("נעילת הליד השתנתה", 409, "lock_lost");
      }
      await tx.user.update({ where: { id: user.id }, data: { presence: "in_call", presenceAt: new Date() } });
      if (sessionId) await tx.dialerSession.update({ where: { id: sessionId }, data: { dialsCount: { increment: 1 } } });
      createdHere = true;
      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const again = await prisma.call.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: CALL_INCLUDE });
      if (again && again.userId === user.id && again.businessId === user.businessId) return again;
      throw new ApiError("יש לך כבר שיחה פעילה", 409, "call_active");
    }
    throw err;
  }

  if (!createdHere) return call;

  await audit(user.businessId, user.id, "call", call.id, "call.started", { mode: input.mode, to: toE164, leadId });

  // Dial the agent leg (browser). The lead leg is dialed once the agent leg answers.
  try {
    const r = await telephony.dialAgent({ callId: call.id, sipUsername, fromE164: from.e164, timeoutSeconds: 20 });
    await prisma.call.updateMany({ where: { id: call.id, status: "created", endedAt: null }, data: { status: "dialing_agent" } });
    call = await prisma.call.update({
      where: { id: call.id },
      data: { agentLegId: r.legId, providerSessionId: r.providerSessionId, dialPendingSince: null },
      include: CALL_INCLUDE,
    });
  } catch (err) {
    if (err instanceof TelephonyRequestTimeout) {
      call = await prisma.call.update({ where: { id: call.id }, data: { dialPendingSince: new Date() }, include: CALL_INCLUDE });
      return call;
    }
    call = await prisma.call.update({
      where: { id: call.id },
      data: { status: "failed", endedAt: new Date(), telephonyResult: "failed", failureReason: String((err as Error).message).slice(0, 300), activeForUser: null, talkSeconds: 0 },
      include: CALL_INCLUDE,
    });
    await afterCallFinalized(call.id);
  }
  return call;
}

const AGENT_LEG_TIMEOUT_MS = 30_000;
const DIAL_PENDING_RETRY_MS = 12_000;
const HANGUP_GRACE_MS = 15_000;

/**
 * Advance simulation, then reconcile with the provider when something looks stuck.
 * Called by the state poll. Cheap on the happy path.
 */
export async function reconcileCall(callId: string): Promise<CallWithRefs | null> {
  let call = await prisma.call.findUnique({ where: { id: callId }, include: CALL_INCLUDE });
  if (!call) return null;
  if (call.endedAt) return call;
  const telephony = getTelephony();
  const now = Date.now();

  if (telephony.simulation && call.provider === "mock") {
    for (const ev of dueMockEvents(call)) {
      await processProviderEvent(ev);
      const fresh = await prisma.call.findUnique({ where: { id: callId } });
      if (fresh?.endedAt) break;
    }
    return prisma.call.findUnique({ where: { id: callId }, include: CALL_INCLUDE });
  }

  // 1. Dial request timed out earlier: wait for a webhook; then retry with the SAME command_id.
  if (call.dialPendingSince && now - call.dialPendingSince.getTime() > DIAL_PENDING_RETRY_MS) {
    // Never recreate a possibly-live call after the provider's deduplication window.
    // Claim at most one retry persistently so concurrent polls cannot multiply it.
    const origin = call.agentLegId ? (call.agentAnsweredAt ?? call.createdAt) : call.createdAt;
    if (call.hangupRequestedAt || now - origin.getTime() > 45_000 || call.failureReason === "dial_retry_attempted") {
      await prisma.call.updateMany({ where: { id: call.id, endedAt: null }, data: { failureReason: "provider_confirmation_required" } });
      return prisma.call.findUnique({ where: { id: call.id }, include: CALL_INCLUDE });
    }
    if (call.failureReason === "provider_confirmation_required") return call;
    const claimed = await prisma.call.updateMany({ where: { id: call.id, endedAt: null, failureReason: null }, data: { failureReason: "dial_retry_attempted" } });
    if (!claimed.count) return call;
    if (!call.agentLegId) {
      const me = await prisma.user.findUnique({ where: { id: call.userId }, select: { sipUsername: true } });
      try {
        const r = await telephony.dialAgent({ callId: call.id, sipUsername: me?.sipUsername ?? "", fromE164: call.fromE164, timeoutSeconds: 20 });
        call = await prisma.call.update({ where: { id: call.id }, data: { agentLegId: r.legId, dialPendingSince: null }, include: CALL_INCLUDE });
      } catch (err) {
        if (!(err instanceof TelephonyRequestTimeout)) {
          call = await finalizeLocally(call.id, "failed", String((err as Error).message));
        } else {
          await prisma.call.update({ where: { id: call.id }, data: { failureReason: "provider_confirmation_required" } });
        }
      }
    } else if (!call.leadLegId) {
      await prisma.call.update({ where: { id: call.id }, data: { dialPendingSince: null } });
      await dialLeadLeg(call.id);
      call = (await prisma.call.findUnique({ where: { id: callId }, include: CALL_INCLUDE }))!;
    }
    return call;
  }

  // 2. Agent leg never answered within the timeout → confirm with provider, then fail.
  if (call.agentLegId && !call.agentAnsweredAt && now - call.createdAt.getTime() > AGENT_LEG_TIMEOUT_MS) {
    const alive = await telephony.isLegAlive(call.agentLegId);
    if (alive === false) return finalizeLocally(call.id, "failed", "agent_leg_not_answered");
  }

  // 3. We asked for a hangup but never got the webhook → confirm with provider.
  if (call.hangupRequestedAt && now - call.hangupRequestedAt.getTime() > HANGUP_GRACE_MS) {
    const legId = call.leadLegId ?? call.agentLegId;
    const alive = legId ? await telephony.isLegAlive(legId) : false;
    if (alive === false) return finalizeLocally(call.id, "ended", "hangup_confirmed_by_poll");
  }

  // 4. Long silence on a live lead leg → confirm it is still alive.
  const lastEvent = call.lastEventAt?.getTime() ?? call.createdAt.getTime();
  if (call.leadLegId && now - lastEvent > 120_000) {
    const alive = await telephony.isLegAlive(call.leadLegId);
    if (alive === false) return finalizeLocally(call.id, "ended", "lead_leg_gone");
    await prisma.call.update({ where: { id: call.id }, data: { lastEventAt: new Date() } });
  }
  return call;
}

async function finalizeLocally(callId: string, status: "ended" | "failed", reason: string): Promise<CallWithRefs> {
  const c = await prisma.call.findUnique({ where: { id: callId } });
  if (!c || c.endedAt) return (await prisma.call.findUnique({ where: { id: callId }, include: CALL_INCLUDE }))!;
  const endedAt = new Date();
  const answered = Boolean(c.answeredAt);
  const updated = await prisma.call.update({
    where: { id: callId },
    data: {
      status,
      endedAt,
      telephonyResult: answered ? "answered" : status === "failed" ? "failed" : "cancelled",
      failureReason: reason,
      activeForUser: null,
      talkSeconds: answered && c.answeredAt ? Math.round((endedAt.getTime() - c.answeredAt.getTime()) / 1000) : 0,
    },
    include: CALL_INCLUDE,
  });
  await afterCallFinalized(callId);
  return updated;
}

/** Agent pressed hang-up. Never marks the call ended by itself – the provider event does. */
export async function hangupCall(user: SessionUser, callId: string) {
  const call = await prisma.call.findFirst({ where: { id: callId, userId: user.id }, include: CALL_INCLUDE });
  if (!call) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  if (call.endedAt) return call;
  const telephony = getTelephony();
  await prisma.call.updateMany({ where: { id: callId, hangupRequestedAt: null }, data: { hangupRequestedAt: new Date() } });
  const legs = [call.leadLegId, call.agentLegId].filter(Boolean) as string[];
  if (legs.length === 0) {
    // A timed-out request may still have created a provider leg; await its webhook.
    if (call.dialPendingSince) return prisma.call.update({ where: { id: callId }, data: { failureReason: "provider_confirmation_required" }, include: CALL_INCLUDE });
    return finalizeLocally(callId, "ended", "hangup_before_dial");
  }
  for (const leg of legs) {
    try {
      await telephony.hangupLeg(leg, `${callId}-hangup-${leg === call.leadLegId ? "lead" : "agent"}`);
    } catch (err) {
      console.error("[calls] hangup failed", err);
    }
  }
  await audit(user.businessId, user.id, "call", callId, "call.hangup_requested");
  return reconcileCall(callId);
}

export async function sendDtmf(user: SessionUser, callId: string, digits: string) {
  if (!/^[0-9A-D*#wW]{1,32}$/.test(digits)) throw new ApiError("תווים לא חוקיים", 400, "invalid_dtmf");
  const call = await prisma.call.findFirst({ where: { id: callId, userId: user.id } });
  if (!call || call.endedAt || !call.answeredAt || !call.leadLegId) throw new ApiError("אין שיחה פעילה שנענתה", 409, "call_not_answered");
  await getTelephony().sendDtmf(call.leadLegId, digits, `${callId}-dtmf-${Date.now()}`);
}

export interface SaveOutcomeInput {
  callId: string;
  outcome: OutcomeKey;
  note?: string;
  callbackAt?: Date;
  contactUpdates?: { fullName?: string; email?: string; company?: string; city?: string };
}

/** Save the business outcome. Blocked while the call is still alive at the provider. */
export async function saveOutcome(user: SessionUser, input: SaveOutcomeInput): Promise<CallWithRefs> {
  const owned = await prisma.call.findFirst({ where: { id: input.callId, userId: user.id, businessId: user.businessId }, select: { id: true } });
  if (!owned) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  const call = await reconcileCall(input.callId);
  if (!call || call.userId !== user.id) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  if (!call.endedAt) throw new ApiError("השיחה עדיין פעילה – נתק לפני שמירת תוצאה", 409, "call_still_active");
  if (call.outcomeSavedAt) return call;

  const def = OUTCOME_BY_KEY[input.outcome];
  if (!def) throw new ApiError("תוצאה לא חוקית", 400, "invalid_outcome");
  if (def.requiresCallbackTime && !input.callbackAt) throw new ApiError("יש לבחור מועד לחזרה", 400, "callback_time_required");
  if (input.callbackAt && input.callbackAt.getTime() < Date.now() - 60_000) throw new ApiError("מועד החזרה חייב להיות בעתיד", 400, "callback_in_past");

  const updated = await prisma.$transaction(async (tx) => {
    await lockAgent(tx, user.id);
    const fresh = await tx.call.findUniqueOrThrow({ where: { id: call.id }, include: CALL_INCLUDE });
    if (fresh.outcomeSavedAt) return fresh;
    const u = await tx.call.update({
      where: { id: call.id },
      data: { outcome: input.outcome, outcomeNote: input.note?.trim() || null, outcomeSavedAt: new Date(), callbackAt: input.callbackAt ?? null },
      include: CALL_INCLUDE,
    });
    if (input.contactUpdates && call.contactId) {
      const cu = Object.fromEntries(Object.entries(input.contactUpdates).filter(([, v]) => v !== undefined));
      if (Object.keys(cu).length) await tx.contact.update({ where: { id: call.contactId }, data: cu });
    }
    if (def.requiresCallbackTime && call.contactId) {
      await tx.task.create({
        data: {
          businessId: user.businessId,
          userId: user.id,
          contactId: call.contactId,
          leadId: call.leadId,
          callId: call.id,
          type: "callback",
          dueAt: input.callbackAt!,
          note: input.note?.trim() || null,
        },
      });
    }
    if (call.contactId) await tx.noteDraft.deleteMany({ where: { userId: user.id, contactId: call.contactId } });
    if (call.leadId) {
      await applyOutcomeToLead({ businessId: user.businessId, userId: user.id, leadId: call.leadId, outcome: input.outcome, callbackAt: input.callbackAt, note: input.note }, tx);
    } else if (def.addsToDnc) {
      const { addToDnc } = await import("@/lib/dialer/queue");
      await addToDnc(user.businessId, user.id, call.toE164, `outcome:${input.outcome}`, tx);
    }

    // Automation: a sale closes the contact's pending leads in every other list of the business.
    if (def.isSale && call.contactId) {
      const settings = await getBusinessSettings(user.businessId, tx);
      if (settings.removeFromOtherListsOnSale) {
        const r = await tx.listLead.updateMany({
          where: { businessId: user.businessId, contactId: call.contactId, status: { in: ["pending", "callback", "locked"] }, ...(call.leadId ? { NOT: { id: call.leadId } } : {}) },
          data: { status: "completed", lockedByUserId: null, lockToken: null, lockExpiresAt: null, nextAttemptAt: null, preferredUserId: null },
        });
        await tx.task.updateMany({ where: { businessId: user.businessId, contactId: call.contactId, status: "open", NOT: { callId: call.id } }, data: { status: "cancelled" } });
        await audit(user.businessId, user.id, "automation", call.contactId, "automation.sale_removed_from_lists", { trigger: "outcome:sale", callId: call.id, leadsClosed: r.count, result: "ok" }, tx);
      }
    }

    const session = await tx.dialerSession.findFirst({ where: { userId: user.id, status: { in: ["active", "paused"] } } });
    await tx.user.updateMany({ where: { id: user.id, presence: "wrap_up" }, data: { presence: session?.status === "paused" ? "paused" : "available", presenceAt: new Date() } });
    await audit(user.businessId, user.id, "call", call.id, "call.outcome_saved", { outcome: input.outcome }, tx);
    return u;
  });
  return updated;
}

/** The agent's live call, if any (advanced/reconciled). */
export async function activeCallFor(userId: string) {
  const c = await prisma.call.findUnique({ where: { activeForUser: userId }, select: { id: true } });
  if (!c) return null;
  return reconcileCall(c.id);
}

/** The most recent ended call that still needs an outcome (wrap-up). */
export async function pendingWrapUpFor(userId: string) {
  return prisma.call.findFirst({
    where: { userId, endedAt: { not: null }, outcomeSavedAt: null },
    orderBy: { createdAt: "desc" },
    include: CALL_INCLUDE,
  });
}
