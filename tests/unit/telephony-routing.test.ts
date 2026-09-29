import crypto from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { classifyHttpFailure, classifyError, countsTowardBreaker } from "@/lib/telephony/classify";
import { CLOSED, onFailure, onSuccess, tryAcquire, advance, type BreakerConfig } from "@/lib/telephony/breaker";
import { TelephonyProviderError, TelephonyRequestTimeout } from "@/lib/telephony/types";
import { realCallBlocker } from "@/lib/telephony/registry";
import { mockAdapter } from "@/lib/telephony/mock";
import { telnyxAdapter, verifyTelnyxSignature } from "@/lib/telephony/telnyx";

const cfg: BreakerConfig = { failureThreshold: 3, windowSeconds: 60, cooldownSeconds: 120, probeCalls: 2 };
const at = (s: number) => new Date(Date.UTC(2026, 8, 29, 10, 0, 0) + s * 1000);

describe("failure classification", () => {
  it("separates provider outage, account, auth, rate limit and our own request errors", () => {
    expect(classifyHttpFailure(503, "Service Unavailable")).toBe("provider_outage");
    expect(classifyHttpFailure(401, "Unauthorized")).toBe("auth");
    expect(classifyHttpFailure(402, "")).toBe("account");
    expect(classifyHttpFailure(400, "20100 Insufficient Funds")).toBe("account");
    expect(classifyHttpFailure(403, "D38 no outbound voice profile")).toBe("account");
    expect(classifyHttpFailure(403, "D2 profile channel limit exceeded")).toBe("capacity");
    expect(classifyHttpFailure(429, "90103")).toBe("rate_limit");
    expect(classifyHttpFailure(422, "invalid destination")).toBe("invalid_request");
    expect(classifyError(new TelephonyRequestTimeout())).toBe("timeout");
    expect(classifyError(new TelephonyProviderError("x", 500, "provider_outage"))).toBe("provider_outage");
    expect(classifyError(Object.assign(new TypeError("fetch failed"), { cause: "ECONNRESET" }))).toBe("provider_outage");
  });
  it("only provider-side failures feed the breaker – never rate limits or bad requests", () => {
    for (const c of ["provider_outage", "account", "auth", "timeout"] as const) expect(countsTowardBreaker(c)).toBe(true);
    for (const c of ["rate_limit", "invalid_request", "unknown"] as const) expect(countsTowardBreaker(c)).toBe(false);
  });
});

describe("circuit breaker", () => {
  it("opens after the threshold inside the window, not for failures spread beyond it", () => {
    let s = onFailure(CLOSED, cfg, at(0), "provider_outage");
    s = onFailure(s, cfg, at(70), "provider_outage"); // window expired → counting restarts
    expect(s.state).toBe("closed");
    expect(s.failuresInWindow).toBe(1);
    s = onFailure(s, cfg, at(80), "provider_outage");
    s = onFailure(s, cfg, at(90), "timeout");
    expect(s.state).toBe("open");
  });
  it("auth / account failures open at once", () => {
    expect(onFailure(CLOSED, cfg, at(0), "auth").state).toBe("open");
    expect(onFailure(CLOSED, cfg, at(0), "account").state).toBe("open");
  });
  it("open → half_open after the cooldown → limited probes → closed after all probes succeed", () => {
    const open = onFailure(CLOSED, cfg, at(0), "auth");
    expect(tryAcquire(open, cfg, at(60)).allowed).toBe(false);
    const p1 = tryAcquire(open, cfg, at(121));
    expect(p1).toMatchObject({ allowed: true, probe: true });
    const p2 = tryAcquire(p1.next, cfg, at(122));
    expect(p2.allowed).toBe(true);
    expect(tryAcquire(p2.next, cfg, at(123)).allowed).toBe(false); // only probeCalls in flight
    let s = onSuccess(p2.next, cfg, at(124));
    expect(s.state).toBe("half_open");
    s = onSuccess(s, cfg, at(125));
    expect(s.state).toBe("closed");
  });
  it("a failed probe re-opens; a late success while open does not close", () => {
    const open = onFailure(CLOSED, cfg, at(0), "auth");
    const half = tryAcquire(open, cfg, at(121)).next;
    expect(onFailure(half, cfg, at(122), "provider_outage").state).toBe("open");
    expect(onSuccess(open, cfg, at(10)).state).toBe("open");
  });
  it("probe slots that never reported back are released after another cooldown", () => {
    const open = onFailure(CLOSED, cfg, at(0), "auth");
    let s = tryAcquire(open, cfg, at(121)).next;
    s = tryAcquire(s, cfg, at(122)).next;
    expect(tryAcquire(s, cfg, at(200)).allowed).toBe(false);
    expect(advance(s, at(121 + 121), cfg).probesStarted).toBe(0);
  });
});

describe("provider eligibility", () => {
  afterEach(() => { delete process.env.TELNYX_API_KEY; delete process.env.TELNYX_PUBLIC_KEY; delete process.env.TELNYX_CALL_CONTROL_APP_ID; delete process.env.TELNYX_CREDENTIAL_CONNECTION_ID; });
  it("the simulation adapter can never carry real calls", () => {
    expect(realCallBlocker(mockAdapter)).toBe("simulation");
  });
  it("an unconfigured Telnyx is 'not configured'", () => {
    expect(realCallBlocker(telnyxAdapter)).toBe("not_configured");
  });
  it("a provider without an implemented agent client cannot carry real calls", () => {
    expect(realCallBlocker({ ...telnyxAdapter, configStatus: () => ({ configured: true, missing: [], accountRef: "x" }), capabilities: { ...telnyxAdapter.capabilities, agentClient: "sip-websocket" } })).toBe("agent_client_missing");
  });
});

describe("Telnyx webhook signature", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  afterEach(() => { delete process.env.TELNYX_PUBLIC_KEY; });
  const sign = (ts: string, body: string) => crypto.sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");
  it("verifies the original raw body, rejects a changed body and an old timestamp (replay)", () => {
    process.env.TELNYX_PUBLIC_KEY = raw.toString("base64");
    const body = JSON.stringify({ data: { id: "e1", event_type: "call.hangup" } });
    const now = String(Math.floor(Date.now() / 1000));
    expect(verifyTelnyxSignature(body, sign(now, body), now)).toBe(true);
    expect(verifyTelnyxSignature(body.replace("e1", "e2"), sign(now, body), now)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifyTelnyxSignature(body, sign(old, body), old)).toBe(false);
    expect(verifyTelnyxSignature(body, null, now)).toBe(false);
  });
});
