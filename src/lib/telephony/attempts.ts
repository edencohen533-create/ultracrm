/**
 * Provider attempts: one row per provider request that may create a call leg (agent / lead / supervisor).
 * The business call (Call) keeps one provider for life; an attempt never moves to another provider.
 *
 * Outcome of the request:
 *   success          → created (leg id stored) · breaker success
 *   timeout          → uncertain – the provider may have created the leg. No new dial: reconciliation looks for the
 *                      leg by our reference (client_state), else the attempt waits for settlement.
 *   provider error   → failed with its class · breaker failure when the class counts (never for busy / no answer).
 */
import type { TelephonyProvider as ProviderName } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { classifyError } from "./classify";
import { recordProviderResult } from "./routing";
import { adapterFor } from "./registry";
import { TelephonyProviderError, TelephonyRequestTimeout, type DialResult } from "./types";

export interface AttemptContext {
  businessId: string;
  callId: string;
  leg: "agent" | "lead" | "supervisor";
  provider: ProviderName;
  /** Same key as the command_id the adapter sends – a retry to the same provider reuses the row. */
  commandKey: string;
  fromE164?: string;
  toE164?: string;
}

export async function dialWithAttempt<T extends DialResult>(ctx: AttemptContext, request: () => Promise<T>): Promise<T> {
  const accountRef = adapterFor(ctx.provider).configStatus().accountRef;
  const attempt = await prisma.callAttempt.upsert({
    where: { commandKey: ctx.commandKey },
    create: { businessId: ctx.businessId, callId: ctx.callId, leg: ctx.leg, provider: ctx.provider, providerAccount: accountRef, commandKey: ctx.commandKey, fromE164: ctx.fromE164, toE164: ctx.toE164 },
    update: {},
  });
  if (attempt.provider !== ctx.provider || attempt.callId !== ctx.callId) throw new Error("attempt key reused across calls or providers");
  try {
    const r = await request();
    await prisma.callAttempt.update({ where: { id: attempt.id }, data: { status: "created", providerLegId: r.legId, providerSessionId: r.providerSessionId ?? null, respondedAt: new Date(), failureClass: null, failureDetail: null } });
    await recordProviderResult(ctx.businessId, ctx.provider, { ok: true });
    return r;
  } catch (err) {
    const failureClass = classifyError(err);
    const detail = String((err as Error)?.message ?? err).slice(0, 300);
    const uncertain = err instanceof TelephonyRequestTimeout;
    await prisma.callAttempt.update({
      where: { id: attempt.id },
      data: { status: uncertain ? "uncertain" : "failed", failureClass, failureDetail: detail, httpStatus: err instanceof TelephonyProviderError ? err.httpStatus : null, respondedAt: new Date() },
    });
    await recordProviderResult(ctx.businessId, ctx.provider, { ok: false, failureClass, detail });
    throw err;
  }
}

/** A webhook proved the leg exists (it may arrive before, after or instead of the HTTP response). */
export async function attemptLegSeen(callId: string, leg: "agent" | "lead", provider: ProviderName, legId: string) {
  await prisma.callAttempt.updateMany({
    where: { callId, leg, provider, status: { in: ["requested", "uncertain", "needs_settlement"] } },
    data: { status: "created", providerLegId: legId, settledAt: new Date() },
  });
}

/** Reconciliation could not prove the leg was never created: stop, and leave it for a manager to settle. */
export async function attemptNeedsSettlement(callId: string, leg: "agent" | "lead", detail: string) {
  await prisma.callAttempt.updateMany({ where: { callId, leg, status: { in: ["requested", "uncertain"] } }, data: { status: "needs_settlement", failureDetail: detail.slice(0, 300) } });
}
