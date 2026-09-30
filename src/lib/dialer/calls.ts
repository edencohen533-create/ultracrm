import { getAgentSettings, followUpPeers } from "@/lib/agent-settings";
import { businessDayStart } from "@/lib/business-day";
/**
 * Call lifecycle: start (idempotent), state poll + reconciliation, hangup,
 * outcome, DTMF. The provider is the source of truth for "answered".
 */
import { Prisma } from "@/generated/prisma/client";
import type { DialMode, OutcomeKey } from "@/generated/prisma/enums";
import { lockAgent } from "./locking";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { selectOutboundNumber } from "@/lib/numbers/selection";
import { normalizePhone } from "@/lib/phone";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { adapterFor } from "@/lib/telephony";
import { chooseProviderForNewCall } from "@/lib/telephony/routing";
import { dialWithAttempt, attemptLegSeen, attemptNeedsSettlement } from "@/lib/telephony/attempts";
import { TelephonyRequestTimeout, TelephonyUnsupportedError } from "@/lib/telephony/types";
import { dueMockEvents } from "@/lib/telephony/mock";
import { afterCallFinalized, dialLeadLeg, processProviderEvent } from "@/lib/telephony/events";
import { getBusinessSettings, isWithinDialWindow } from "@/lib/settings";
import { OUTCOME_BY_KEY } from "@/lib/outcomes";
import { applyOutcomeToLead, assertListAccess, assertLeadLock, isDnc, listDialWindow, releaseLead } from "@/lib/dialer/queue";
import { afterFollowUpAttempt, applyPendingTransfers, assertDialAllowed } from "@/lib/crm/lead-ops";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { emitEvent, kickEventProcessing } from "@/lib/events";
import { consumeQuota } from "@/lib/modules";
import { callBlockReason } from "@/lib/suppression";

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
  /** The provider the agent's browser is registered with (sent by the dialer). */
  agentProvider?: string;
}

/** Find or create the contact for a manually dialed number. */
async function contactForPhone(businessId: string, userId: string, phoneE164: string, raw: string) {
  const { findOrCreateContactByPhone } = await import("@/lib/crm/contacts");
  return findOrCreateContactByPhone(businessId, phoneE164, { fullName: "מספר לא מזוהה", phoneRaw: raw, source: "manual_dial", ownerUserId: userId });
}

export async function startCall(user: SessionUser, input: StartCallInput): Promise<CallWithRefs> {
  (await import("@/lib/restore-mode")).assertNotRestoreMode("חיוג");
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
  // A call left without a result is closed automatically (AI documents it) – never a reason to block the next call.
  await autoFinalizePendingCalls(user);

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

  // Ownership / existing customer vs. campaign / someone else on the person / follow-up time – the central check,
  // at the moment of dialing (the lead may have moved, or the person bought, since the queue was built).
  try { await assertDialAllowed(user, contactId, input.mode !== "manual", listId); }
  catch (e) { if (leadId) await releaseLead(user.id, leadId, "dial_guard").catch(() => undefined); throw e; }

  // DNC / do-not-contact is checked again at the moment of dialing – for every mode.
  // By the number AND every identifier of the contact (duplicate cards, other phones); a request under review stops
  // automatic dialing only.
  const blocked = await callBlockReason(user.businessId, toE164, undefined, { contactId, automated: input.mode !== "manual" });
  if (blocked) throw new ApiError(blocked, 403, "dnc_blocked");

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

  // Provider for this NEW call – chosen after every other check so a breaker probe slot is not spent on a rejected dial.
  // From here on the call belongs to this provider: every later action and webhook goes back to it.
  const choice = await chooseProviderForNewCall(user.businessId);
  const telephony = adapterFor(choice.provider);
  if (process.env.TELEPHONY_PROVIDER === "telnyx" && telephony.simulation) throw new ApiError("חיבור הטלפוניה אינו מוגדר; חיוג אמיתי לא זמין", 409, "telephony_unconfigured");
  // The agent hears the call through the provider that places it: a browser registered elsewhere must reconnect first.
  if (input.agentProvider && input.agentProvider !== choice.provider) throw new ApiError("ספק הטלפוניה הוחלף – הדפדפן מתחבר מחדש", 409, "agent_reregister_required", { provider: choice.provider });
  const sipUsername = await telephony.agentAddress(user.id);
  if (!sipUsername) throw new ApiError("הדפדפן לא מחובר לטלפוניה – רענן את החיבור", 409, "browser_not_registered");

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

  // Budget (paid subscription): an outbound call reserves its estimated cost under the business lock, so parallel
  // agents / queues can't overrun the monthly cap together; released if the call never starts.
  const budgetKey = `call:${input.idempotencyKey}`;
  const budget = await import("@/server/billing/budget");
  await budget.reserveBudget(user.businessId, { service: "call_minute", units: 5, key: budgetKey, ttlMinutes: 180 });

  let call: CallWithRefs;
  let createdHere = false;
  try {
    call = await prisma.$transaction(async (tx) => {
      await lockAgent(tx, user.id);
      // A transaction-scoped destination lock closes the race between different agents.
      // Try (never wait): an agent blocked on another agent's lock would hold a pooled connection while waiting – a burst
      // of simultaneous dials to one person could starve the pool. Someone else holding it means "already being dialed".
      const tryLock = async (key: string) => (await tx.$queryRaw<Array<{ ok: boolean }>>(Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`))[0]?.ok;
      if (!(await tryLock(user.businessId + ":" + toE164))) throw new ApiError("המספר נמצא כרגע בחיוג אצל נציג אחר", 409, "number_in_call");
      // …and per person: two agents on two numbers of the same contact are serialized too.
      if (!(await tryLock(user.businessId + ":contact:" + contactId))) throw new ApiError("איש הקשר נמצא כרגע בחיוג אצל נציג אחר", 409, "contact_in_call");
      const duplicate = await tx.call.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: CALL_INCLUDE });
      if (duplicate) {
        if (duplicate.userId !== user.id || duplicate.businessId !== user.businessId) throw new ApiError("מפתח בקשה לא תקין", 400, "bad_idempotency_key");
        return duplicate;
      }
      if (await tx.call.findUnique({ where: { activeForUser: user.id } })) throw new ApiError("יש שיחה פעילה", 409, "call_active");
      if (await tx.call.findFirst({ where: { businessId: user.businessId, toE164, endedAt: null } })) throw new ApiError("המספר כבר בשיחה", 409, "number_in_call");
      if (await tx.call.findFirst({ where: { businessId: user.businessId, contactId, endedAt: null } })) throw new ApiError("איש הקשר כבר בשיחה או בחיוג אצל נציג אחר", 409, "contact_in_call");
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
      const personal = await getAgentSettings(user.businessId, user.id, tx);
      if (personal && input.mode !== "manual") {
        const unanswered = await tx.call.count({ where: { businessId: user.businessId, toE164, direction: "outbound", mode: { not: "manual" }, createdAt: { gte: businessDayStart(settings.timezone) }, answeredAt: null, telephonyResult: { in: ["no_answer", "busy", "rejected"] } } });
        if (unanswered >= personal.maxDailyUnanswered) throw new ApiError("הושגה מגבלת הניסיונות היומית ללא מענה לליד", 409, "daily_unanswered_limit");
      }
      // Usage is counted in the same transaction as the call row: a rejected / duplicate dial never counts (no double charge).
      await consumeQuota(user.businessId, "calls_started", 1, tx);
      // Caller id is chosen under the number-pool lock, in the same transaction as the call row.
      // A per-business provider account (e.g. Zadarma) presents the caller ID its owner approved there; Telnyx numbers
      // are never presented through another provider. Its plan's concurrent-call limit is enforced here.
      let selection: { number: { id: string | null; e164: string }; reason: string };
      if (telephony.businessReadiness) {
        const cred = await tx.telephonyProviderCredential.findUnique({ where: { businessId_provider: { businessId: user.businessId, provider: choice.provider } } });
        if (!cred?.callerIdE164 || !cred.callerIdApprovedAt) throw new ApiError("לספק הגיבוי אין מספר יוצא מאושר", 409, "backup_caller_id_missing");
        if (cred.maxConcurrent && await tx.call.count({ where: { businessId: user.businessId, provider: choice.provider, endedAt: null } }) >= cred.maxConcurrent) throw new ApiError("כל הקווים אצל ספק הגיבוי תפוסים – נסה שוב בעוד רגע", 409, "backup_capacity");
        selection = { number: { id: null, e164: cred.callerIdE164 }, reason: "provider_account_caller_id" };
      } else selection = await selectOutboundNumber(tx, { businessId: user.businessId, userId: user.id, listId, phoneNumberId: input.phoneNumberId, toE164, simulation: telephony.simulation, provider: choice.provider });
      const from = selection.number;
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
          numberSelectionReason: selection.reason,
          status: "created",
        },
        include: CALL_INCLUDE,
      });
      if (leadId) {
        const cycle = await tx.listLead.findUniqueOrThrow({ where: { id: leadId }, select: { followUpAttempts: true } });
        const claimed = await tx.listLead.updateMany({
          where: { id: leadId, status: "locked", lockedByUserId: user.id, lockToken: input.lockToken, lockExpiresAt: { gte: new Date() } },
          data: {
            status: "in_call",
            attempts: { increment: 1 },
            ...(cycle.followUpAttempts !== null ? { followUpAttempts: { increment: 1 } } : {}),
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
    await budget.settleReservation(user.businessId, budgetKey, "released").catch(() => undefined);
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
    const r = await dialWithAttempt({ businessId: call.businessId, callId: call.id, leg: "agent", provider: choice.provider, commandKey: `${call.id}-agent`, fromE164: call.fromE164 },
      () => telephony.dialAgent({ callId: call.id, businessId: call.businessId, toE164: call.toE164, sipUsername, fromE164: call.fromE164, timeoutSeconds: 20 }));
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
    await budget.settleReservation(user.businessId, budgetKey, "released").catch(() => undefined);
    await afterCallFinalized(call.id);
  }
  return call;
}

const AGENT_LEG_TIMEOUT_MS = 30_000;
const DIAL_PENDING_RETRY_MS = 12_000;
/** After this long without proof either way, a timed-out dial is closed and left for settlement. */
const SETTLEMENT_AFTER_MS = 45_000;
/** Callback providers: first look-up after this long without events; settlement after the second; give up on a live call after the third. */
const CALLBACK_EVENTS_MS = 60_000;
const CALLBACK_SETTLE_MS = 180_000;
const CALLBACK_NO_END_MS = 3 * 3600_000;
const HANGUP_GRACE_MS = 15_000;

/**
 * Advance simulation, then reconcile with the provider when something looks stuck.
 * Called by the state poll. Cheap on the happy path.
 */
export async function reconcileCall(callId: string): Promise<CallWithRefs | null> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: CALL_INCLUDE });
  if (!call) return null;
  if (call.endedAt) return call;
  const telephony = adapterFor(call.provider);
  const now = Date.now();

  if (telephony.simulation && call.provider === "mock") {
    for (const ev of dueMockEvents(call)) {
      await processProviderEvent(ev);
      const fresh = await prisma.call.findUnique({ where: { id: callId } });
      if (fresh?.endedAt) break;
    }
    return prisma.call.findUnique({ where: { id: callId }, include: CALL_INCLUDE });
  }

  // 1. A dial request timed out: the provider may or may not have created the leg. Never dial again (Telnyx does not
  //    document command_id de-duplication for POST /calls). Wait for a webhook; then look the leg up by our reference;
  //    if it cannot be proven, stop and leave the attempt for settlement.
  if (call.dialPendingSince && now - call.dialPendingSince.getTime() > DIAL_PENDING_RETRY_MS) {
    const leg: "agent" | "lead" = call.agentLegId ? "lead" : "agent";
    const found = telephony.capabilities.legLookupByReference ? await telephony.findLegByReference({ callId: call.id, leg }) : null;
    if (found && found !== "none") {
      // Callback providers: what the lookup finds is the provider's outgoing (customer) call; the request itself was the agent leg.
      const callback = telephony.capabilities.dialModel === "callback";
      const data = callback ? { agentLegId: call.agentLegId ?? `cb-${call.id}`, leadLegId: found.legId, leadDialedAt: new Date() } : leg === "agent" ? { agentLegId: found.legId } : { leadLegId: found.legId, leadDialedAt: new Date() };
      await prisma.call.update({ where: { id: call.id }, data: { ...data, dialPendingSince: null } });
      await attemptLegSeen(call.id, callback ? "agent" : leg, call.provider, found.legId);
      return prisma.call.findUnique({ where: { id: call.id }, include: CALL_INCLUDE });
    }
    if (now - call.dialPendingSince.getTime() < SETTLEMENT_AFTER_MS) return call;
    // No live leg carries our reference (or the provider could not be asked): close the call for the agent, do not redial.
    const detail = found === "none" ? "no live leg with our reference; creation unproven" : "provider could not be queried";
    await attemptNeedsSettlement(call.id, leg, detail);
    return finalizeLocally(call.id, "failed", "provider_unconfirmed");
  }

  // 1b. Callback providers (Zadarma): the request succeeded but the provider sends events only for the customer leg.
  //     No event → look the call up in its statistics; still unknown → close for the agent and leave it for settlement.
  if (telephony.capabilities.dialModel === "callback" && call.agentLegId && !call.leadLegId && now - call.createdAt.getTime() > CALLBACK_EVENTS_MS) {
    const found = telephony.capabilities.legLookupByReference ? await telephony.findLegByReference({ callId: call.id, leg: "lead" }) : null;
    if (found && found !== "none") {
      await prisma.call.update({ where: { id: call.id }, data: { leadLegId: found.legId, leadDialedAt: new Date(), lastEventAt: new Date() } });
      await attemptLegSeen(call.id, "agent", call.provider, found.legId);
      return prisma.call.findUnique({ where: { id: call.id }, include: CALL_INCLUDE });
    }
    if (now - call.createdAt.getTime() < CALLBACK_SETTLE_MS) return call;
    await prisma.callAttempt.updateMany({ where: { callId: call.id, status: { in: ["requested", "uncertain", "created"] } }, data: { status: "needs_settlement", failureDetail: "callback accepted, but no call events arrived from the provider" } });
    return finalizeLocally(call.id, "failed", "provider_unconfirmed");
  }
  // A callback call whose end event never came: after a long silence it is closed (the provider cannot be asked).
  if (telephony.capabilities.dialModel === "callback" && call.leadLegId && now - (call.lastEventAt?.getTime() ?? call.createdAt.getTime()) > CALLBACK_NO_END_MS) {
    return finalizeLocally(call.id, "ended", "provider_no_end_event");
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
  const telephony = adapterFor(call.provider);
  // Callback providers (Zadarma) cannot end a live call from the server: say so instead of pretending it was done.
  if (!telephony.capabilities.serverHangup) throw new TelephonyUnsupportedError("בגיבוי Zadarma מנתקים בחלון הטלפון של Zadarma שבצד המסך – המערכת תעודכן אוטומטית כשהשיחה תסתיים", "hangup");
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
  if (!adapterFor(call.provider).capabilities.dtmf) throw new TelephonyUnsupportedError("בגיבוי Zadarma מקישים מקשים בחלון הטלפון של Zadarma", "dtmf");
  await adapterFor(call.provider).sendDtmf(call.leadLegId, digits, `${callId}-dtmf-${Date.now()}`);
}

export interface SaveOutcomeInput {
  callId: string;
  outcome: OutcomeKey;
  note?: string;
  callbackAt?: Date;
  callbackUserId?: string;
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
    const callbackUserId = input.callbackUserId || user.id;
    if (def.requiresCallbackTime && callbackUserId !== user.id) {
      const preferences = await getAgentSettings(user.businessId, user.id, tx);
      if (!preferences?.assignFollowUps || !(await followUpPeers(user)).some(p => p.id === callbackUserId)) throw new ApiError("אין הרשאה לשייך פולו־אפ לנציג זה", 403, "forbidden");
      if (call.listId) {
        const assignments = await tx.dialListAgent.findMany({ where: { listId: call.listId } });
        if (assignments.length && !assignments.some(a => a.userId === callbackUserId)) throw new ApiError("לנציג אין גישה לרשימת החיוג", 403, "forbidden");
      }
    }
    const u = await tx.call.update({
      where: { id: call.id },
      data: { outcome: input.outcome, outcomeNote: input.note?.trim() || null, outcomeSavedAt: new Date(), callbackAt: input.callbackAt ?? null },
      include: CALL_INCLUDE,
    });
    if (input.contactUpdates && call.contactId) {
      const cu = Object.fromEntries(Object.entries(input.contactUpdates).filter(([, v]) => v !== undefined));
      if (cu.email !== undefined) {
        const { findDuplicateByEmail } = await import("@/lib/crm/contacts");
        const email = cu.email.trim().toLowerCase() || null;
        if (email && await findDuplicateByEmail(user.businessId, email, call.contactId, tx)) throw new ApiError("האימייל שייך לאיש קשר אחר", 409, "duplicate_email");
        const contact = await tx.contact.findUniqueOrThrow({ where: { id: call.contactId }, select: { email: true } });
        await tx.contact.update({ where: { id: call.contactId }, data: { email, ...(email !== contact.email ? { emailStatus: null, emailBouncedAt: null } : {}) } });
        delete cu.email;
      }
      if (Object.keys(cu).length) await tx.contact.update({ where: { id: call.contactId }, data: cu });
    }
    if (def.requiresCallbackTime && call.contactId) {
      await tx.task.create({
        data: {
          businessId: user.businessId,
          userId: callbackUserId,
          contactId: call.contactId,
          listLeadId: call.leadId,
          callId: call.id,
          type: "callback",
          dueAt: input.callbackAt!,
          note: input.note?.trim() || null,
        },
      });
    }
    if (call.contactId) await tx.noteDraft.deleteMany({ where: { userId: user.id, contactId: call.contactId } });
    if (call.leadId) {
      await applyOutcomeToLead({ businessId: user.businessId, userId: user.id, leadId: call.leadId, outcome: input.outcome, callbackAt: input.callbackAt, callbackUserId, note: input.note }, tx);
    } else if (def.addsToDnc) {
      const { addToDnc } = await import("@/lib/dialer/queue");
      await addToDnc(user.businessId, user.id, call.toE164, `outcome:${input.outcome}`, tx);
    }

    // The follow-up that was due gets its result recorded (moved to the retry time, closed, or replaced by the new callback).
    if (call.contactId) await afterFollowUpAttempt(tx, { businessId: user.businessId, userId: user.id, callId: call.id, contactId: call.contactId, listLeadId: call.leadId, outcome: input.outcome, retry: Boolean(def.retry) && !def.addsToDnc, callbackTaskCreated: Boolean(def.requiresCallbackTime) });

    // A real dial attempt clears a "זמינה עכשיו" priority; what happens next follows the outcome and the dialer rules.
    if (call.contactId && call.leadDialedAt) {
      const { markSignalsHandled } = await import("@/lib/dialer/availability");
      await markSignalsHandled(user.businessId, call.contactId, call.id, tx);
    }

    // Unanswered-attempt quota (agent → campaign → business setting): an unanswered lead without a future follow-up
    // moves to "לא רלוונטי" and leaves the dial queues. Never for answered calls, follow-ups, qualified or closed leads.
    if (call.contactId && def.retry && !def.addsToDnc && !call.answeredAt) {
      const { exhaustLeadIfNeeded } = await import("@/lib/dialer/exhaustion");
      await exhaustLeadIfNeeded(tx, { businessId: user.businessId, userId: user.id, listId: call.listId, contactId: call.contactId });
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
    await emitEvent(tx, {
      businessId: user.businessId, type: "call.outcome_saved", contactId: call.contactId, actorUserId: user.id, source: "user",
      dedupeKey: `call.outcome_saved:${call.id}`, payload: { callId: call.id, outcome: input.outcome, userId: user.id, callbackAt: input.callbackAt?.toISOString() ?? null, listLeadId: call.leadId },
    });
    return u;
  });
  // A manager's transfer that waited for this call is applied now that the call is documented.
  if (call.contactId) await applyPendingTransfers(user.businessId, call.contactId).catch((e: Error) => console.error("pending transfer failed", { callId: call.id, error: e.message }));
  kickEventProcessing(user.businessId);
  return updated;
}

/** The agent's live call, if any (advanced/reconciled). */
export async function activeCallFor(userId: string) {
  const c = await prisma.call.findUnique({ where: { activeForUser: userId }, select: { id: true } });
  if (!c) return null;
  return reconcileCall(c.id);
}

/** The most recent ended call that still needs an outcome (wrap-up). */
/**
 * Documentation is done by the AI, so an agent is never blocked by an unlogged call: before the next call / lead /
 * session, calls the agent left without a result are closed automatically through the regular outcome path (queue,
 * retries, follow-ups and exhaustion behave exactly as with a manual result). The result follows what the provider
 * reported: answered → "answered" (documented automatically), busy → busy, anything else → no answer.
 */
export async function autoFinalizePendingCalls(user: SessionUser) {
  const pending = await prisma.call.findMany({ where: { userId: user.id, businessId: user.businessId, endedAt: { not: null }, outcomeSavedAt: null }, orderBy: { createdAt: "asc" }, take: 10, select: { id: true, answeredAt: true, telephonyResult: true } });
  let closed = 0;
  for (const c of pending) {
    const outcome: OutcomeKey = c.answeredAt ? "answered" : c.telephonyResult === "busy" ? "busy" : "no_answer";
    try { await saveOutcome(user, { callId: c.id, outcome }); closed++; }
    catch (e) { console.error("[dialer] auto wrap-up failed", c.id, (e as Error).message); }
  }
  return closed;
}

export async function pendingWrapUpFor(userId: string) {
  return prisma.call.findFirst({
    where: { userId, endedAt: { not: null }, outcomeSavedAt: null },
    orderBy: { createdAt: "desc" },
    include: CALL_INCLUDE,
  });
}
