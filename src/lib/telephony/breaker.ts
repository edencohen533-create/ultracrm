/**
 * Circuit breaker (pure state machine; persistence lives in routing.ts).
 *   closed    – calls allowed; failures inside `windowSeconds` are counted; reaching `failureThreshold` opens.
 *   open      – no calls until `cooldownSeconds` pass, then half_open.
 *   half_open – at most `probeCalls` trial calls; all succeed → closed; any counted failure → open again.
 */
import { opensImmediately } from "./classify";
import type { FailureClass } from "./types";

export interface BreakerConfig { failureThreshold: number; windowSeconds: number; cooldownSeconds: number; probeCalls: number }
export interface BreakerSnapshot {
  state: "closed" | "open" | "half_open";
  failuresInWindow: number;
  windowStartedAt: Date | null;
  openedAt: Date | null;
  nextProbeAt: Date | null;
  probeSuccesses: number;
  probesStarted: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 5, windowSeconds: 120, cooldownSeconds: 300, probeCalls: 3 };
export const CLOSED: BreakerSnapshot = { state: "closed", failuresInWindow: 0, windowStartedAt: null, openedAt: null, nextProbeAt: null, probeSuccesses: 0, probesStarted: 0 };

function open(now: Date, cfg: BreakerConfig): BreakerSnapshot {
  return { state: "open", failuresInWindow: 0, windowStartedAt: null, openedAt: now, nextProbeAt: new Date(now.getTime() + cfg.cooldownSeconds * 1000), probeSuccesses: 0, probesStarted: 0 };
}

/** Time passing: an open breaker whose cooldown ended becomes half_open. */
export function advance(s: BreakerSnapshot, now: Date, cfg: BreakerConfig = DEFAULT_BREAKER): BreakerSnapshot {
  if (s.state === "open" && s.nextProbeAt && now >= s.nextProbeAt) return { ...s, state: "half_open", probeSuccesses: 0, probesStarted: 0 };
  // Probe slots whose calls never reported back (rejected before dialing) are released after another cooldown.
  if (s.state === "half_open" && s.nextProbeAt && now.getTime() - s.nextProbeAt.getTime() > cfg.cooldownSeconds * 1000) return { ...s, probeSuccesses: 0, probesStarted: 0, nextProbeAt: now };
  return s;
}

/** May a new call use this provider now? Reserving a probe slot is part of the decision. */
export function tryAcquire(s: BreakerSnapshot, cfg: BreakerConfig, now: Date): { allowed: boolean; probe: boolean; next: BreakerSnapshot } {
  const cur = advance(s, now, cfg);
  if (cur.state === "closed") return { allowed: true, probe: false, next: cur };
  if (cur.state === "open") return { allowed: false, probe: false, next: cur };
  if (cur.probesStarted >= cfg.probeCalls) return { allowed: false, probe: false, next: cur };
  return { allowed: true, probe: true, next: { ...cur, probesStarted: cur.probesStarted + 1 } };
}

export function onFailure(s: BreakerSnapshot, cfg: BreakerConfig, now: Date, cls: FailureClass): BreakerSnapshot {
  const cur = advance(s, now, cfg);
  if (cur.state === "half_open" || cur.state === "open") return open(now, cfg);
  if (opensImmediately(cls)) return open(now, cfg);
  const inWindow = cur.windowStartedAt && now.getTime() - cur.windowStartedAt.getTime() <= cfg.windowSeconds * 1000;
  const failures = inWindow ? cur.failuresInWindow + 1 : 1;
  const windowStartedAt = inWindow ? cur.windowStartedAt : now;
  if (failures >= cfg.failureThreshold) return open(now, cfg);
  return { ...cur, failuresInWindow: failures, windowStartedAt };
}

export function onSuccess(s: BreakerSnapshot, cfg: BreakerConfig, now: Date): BreakerSnapshot {
  const cur = advance(s, now, cfg);
  if (cur.state === "half_open") {
    const probeSuccesses = cur.probeSuccesses + 1;
    return probeSuccesses >= cfg.probeCalls ? { ...CLOSED } : { ...cur, probeSuccesses };
  }
  if (cur.state === "closed") return { ...cur, failuresInWindow: 0, windowStartedAt: null };
  return cur; // a late success while open (request sent before opening) does not close it
}
