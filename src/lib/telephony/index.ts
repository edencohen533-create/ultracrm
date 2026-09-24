import type { TelephonyAdapter } from "./types";
import { telnyxAdapter, telnyxConfigStatus } from "./telnyx";
import { mockAdapter } from "./mock";

export function getTelephony(): TelephonyAdapter {
  const name = (process.env.TELEPHONY_PROVIDER ?? "mock").toLowerCase();
  if (name === "telnyx") {
    const status = telnyxConfigStatus();
    if (!status.configured) {
      console.warn(`[telephony] TELEPHONY_PROVIDER=telnyx but missing ${status.missing.join(", ")} – falling back to simulation`);
      return mockAdapter;
    }
    return telnyxAdapter;
  }
  return mockAdapter;
}

export function telephonyStatus() {
  const adapter = getTelephony();
  const cfg = telnyxConfigStatus();
  return {
    provider: adapter.name,
    simulation: adapter.simulation,
    requested: (process.env.TELEPHONY_PROVIDER ?? "mock").toLowerCase(),
    telnyx: cfg,
  };
}

export type { TelephonyAdapter } from "./types";
