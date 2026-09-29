/**
 * Failure classification for provider requests. Only failures that say something about the provider or the account
 * feed the circuit breaker; a normal call result (busy, no answer, rejected) never does.
 *
 * Telnyx codes (support.telnyx.com/en/articles/4409457, developers.telnyx.com/docs/development/api-fundamentals/api-errors):
 *   401 → bad key · 403 with D1/D2/D3/D22 → channel limits · 403 D13/D35/D36/D51/D38/D7 → account/profile config
 *   20100 → insufficient funds · 429 / 10011 / 90103 → rate limit · 5xx → provider side · 400/404/422 → our request.
 */
import { TelephonyProviderError, TelephonyRequestTimeout, type FailureClass } from "./types";

export function classifyHttpFailure(status: number, detail: string): FailureClass {
  if (status === 429 || /\b(10011|90103)\b/.test(detail)) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 402 || /\b20100\b|insufficient funds|balance/i.test(detail)) return "account";
  if (status === 403) return /\bD(1|2|3|22)\b/.test(detail) ? "rate_limit" : "account";
  if (status >= 500) return "provider_outage";
  if (status === 408) return "timeout";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

export function classifyError(err: unknown): FailureClass {
  if (err instanceof TelephonyRequestTimeout) return "timeout";
  if (err instanceof TelephonyProviderError) return err.failureClass;
  // fetch() network failure (DNS, TLS, connection reset) – the provider is unreachable.
  if (err instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|socket/i.test(String(err.message) + String((err as { cause?: unknown }).cause ?? ""))) return "provider_outage";
  return "unknown";
}

/** Failures that count toward opening the breaker. Rate limits back off instead; request errors are ours. */
export function countsTowardBreaker(c: FailureClass): boolean {
  return c === "provider_outage" || c === "account" || c === "auth" || c === "timeout";
}

/** A bad key or a blocked account will not heal by itself within a window – open at once. */
export function opensImmediately(c: FailureClass): boolean {
  return c === "auth" || c === "account";
}

/** Normal call results. These are outcomes of a working provider and must never trigger a switch. */
export const NORMAL_HANGUP_CAUSES = new Set(["normal_clearing", "user_busy", "no_answer", "timeout", "call_rejected", "originator_cancel", "not_found", "time_limit"]);
