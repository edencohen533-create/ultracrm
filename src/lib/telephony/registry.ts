/**
 * Provider registry. Two different questions, two functions:
 *   adapterFor(call.provider)  – every action on an EXISTING call (hangup, poll, DTMF, recordings, webhooks) goes to
 *                                the provider that created it, whatever the current default is.
 *   chooseProviderForNewCall() – (routing.ts) which provider a NEW call uses.
 * Adding a provider = implement TelephonyAdapter, add it to BUILTIN and to the TelephonyProvider enum, give it a
 * webhook route, and implement its agent client (see docs/TELEPHONY_PROVIDERS.md).
 */
import type { TelephonyProvider as ProviderName } from "@/generated/prisma/enums";
import type { TelephonyAdapter } from "./types";
import { telnyxAdapter, telnyxConfigStatus } from "./telnyx";
import { mockAdapter } from "./mock";
import { zadarmaAdapter } from "./zadarma";

const BUILTIN: Record<ProviderName, TelephonyAdapter> = { telnyx: telnyxAdapter, mock: mockAdapter, zadarma: zadarmaAdapter };

/** Browser clients that exist in DialerProvider. A provider whose agent client is missing cannot carry real calls. */
export const IMPLEMENTED_AGENT_CLIENTS = new Set<TelephonyAdapter["capabilities"]["agentClient"]>(["telnyx-webrtc", "zadarma-widget", "simulation"]);

let testAdapters: Partial<Record<ProviderName, TelephonyAdapter>> | null = null;

/** Tests only: replace adapters with fakes. Refuses to run outside the test environment. */
export function __setTestAdapters(map: Partial<Record<ProviderName, TelephonyAdapter>> | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("test adapters are available in tests only");
  testAdapters = map;
}

export function adapterFor(name: ProviderName): TelephonyAdapter {
  return testAdapters?.[name] ?? BUILTIN[name];
}

/** Platform default (TELEPHONY_PROVIDER env): Telnyx when configured, otherwise the clearly-marked simulation. */
export function platformDefaultProvider(): ProviderName {
  const requested = (process.env.TELEPHONY_PROVIDER ?? "mock").toLowerCase();
  if (requested === "telnyx") {
    const status = telnyxConfigStatus();
    if (!status.configured) {
      console.warn(`[telephony] TELEPHONY_PROVIDER=telnyx but missing ${status.missing.join(", ")} – falling back to simulation`);
      return "mock";
    }
    return "telnyx";
  }
  return "mock";
}

/** Why a provider cannot carry real calls right now (null = it can, subject to account verification). */
export function realCallBlocker(adapter: TelephonyAdapter): string | null {
  if (adapter.testOnly && process.env.NODE_ENV !== "test") return "test_only";
  if (adapter.simulation && !adapter.testOnly) return "simulation";
  if (!adapter.configStatus().configured) return "not_configured";
  if (!adapter.capabilities.outboundDial) return "no_outbound";
  if (!IMPLEMENTED_AGENT_CLIENTS.has(adapter.capabilities.agentClient)) return "agent_client_missing";
  return null;
}

export function knownProviders(): ProviderName[] {
  return Object.keys(BUILTIN) as ProviderName[];
}
