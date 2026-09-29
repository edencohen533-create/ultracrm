import type { TelephonyAdapter } from "./types";
import { telnyxConfigStatus } from "./telnyx";
import { adapterFor, platformDefaultProvider } from "./registry";
import { routingEnabled } from "./routing";

/**
 * The platform default adapter – for things that are not tied to a call (status screens, simulation checks).
 * Actions on an existing call must use adapterFor(call.provider); new calls use chooseProviderForNewCall().
 */
export function getTelephony(): TelephonyAdapter {
  return adapterFor(platformDefaultProvider());
}

export function telephonyStatus() {
  const adapter = getTelephony();
  const cfg = telnyxConfigStatus();
  return {
    provider: adapter.name,
    simulation: adapter.simulation,
    requested: (process.env.TELEPHONY_PROVIDER ?? "mock").toLowerCase(),
    telnyx: cfg,
    routing: routingEnabled() ? "on" : "off",
  };
}

export { adapterFor } from "./registry";
export type { TelephonyAdapter } from "./types";
