import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { mapDisposition, verifyZadarmaWebhook, zadarmaParamsString, zadarmaSignature, phpUrlencode } from "@/lib/telephony/zadarma";
import { countsTowardBreaker } from "@/lib/telephony/classify";
import { CLOSED, onFailure, onSuccess, tryAcquire, type BreakerConfig } from "@/lib/telephony/breaker";

// Vectors computed independently (Python hashlib/hmac/urllib, following the PHP sample in zadarma.com/en/support/api/).
describe("Zadarma API signature", () => {
  it("builds the RFC1738 parameter string in key order", () => {
    expect(zadarmaParamsString({ to: "972501234567", from: "101", sip: "101" })).toBe("from=101&sip=101&to=972501234567");
    expect(phpUrlencode("a b*~")).toBe("a+b%2A%7E");
  });
  it("matches the documented algorithm: base64(hex(hmac_sha1(method + params + md5(params))))", () => {
    expect(zadarmaSignature("/v1/request/callback/", { to: "972501234567", from: "101", sip: "101" }, "secret123")).toBe("ODU2MWVjZDk5MDE1ZDU0ZGZiYjE4Njc0NjNjY2UyODU1ZDRmNWVjMw==");
  });
});

describe("Zadarma webhook signature", () => {
  const fields = { event: "NOTIFY_OUT_START", internal: "101", destination: "972501234567", call_start: "2026-09-29 10:00:00", pbx_call_id: "out_1" };
  it("OUT_START / OUT_END: internal + destination + call_start with the API secret", () => {
    expect(verifyZadarmaWebhook(fields, "MTYyM2I5ZDdmZWQ1NWQ1NGMyNmI0NDNmNTU5MzRmYzJjMWNmM2QwOA==", "secret123")).toBe(true);
    expect(verifyZadarmaWebhook({ ...fields, destination: "972509999999" }, "MTYyM2I5ZDdmZWQ1NWQ1NGMyNmI0NDNmNTU5MzRmYzJjMWNmM2QwOA==", "secret123")).toBe(false);
    expect(verifyZadarmaWebhook(fields, "MTYyM2I5ZDdmZWQ1NWQ1NGMyNmI0NDNmNTU5MzRmYzJjMWNmM2QwOA==", "other-secret")).toBe(false);
    expect(verifyZadarmaWebhook(fields, null, "secret123")).toBe(false);
  });
  it("RECORD: pbx_call_id + call_id_with_rec; unknown events are rejected", () => {
    const rec = { event: "NOTIFY_RECORD", pbx_call_id: "out_1", call_id_with_rec: "1790.1" };
    const sig = Buffer.from(crypto.createHmac("sha1", "s").update("out_11790.1").digest("hex")).toString("base64");
    expect(verifyZadarmaWebhook(rec, sig, "s")).toBe(true);
    expect(verifyZadarmaWebhook({ event: "SOMETHING" }, sig, "s")).toBe(false);
  });
});

describe("Zadarma dispositions", () => {
  it("busy / no answer / cancel / wrong number are call results, never a provider failure", () => {
    for (const d of ["busy", "no answer", "cancel", "unallocated number"]) expect(mapDisposition(d).failure).toBeNull();
    expect(mapDisposition("answered")).toMatchObject({ answered: true, hangupCause: "normal_clearing" });
    expect(mapDisposition("unallocated number").hangupCause).toBe("not_found");
  });
  it("no money → account; line / day limits → capacity; failed → provider", () => {
    expect(mapDisposition("no money").failure).toBe("account");
    for (const d of ["line limit", "no limit", "no day limit", "no money, no limit"]) expect(mapDisposition(d).failure).toBe("capacity");
    expect(mapDisposition("call failed").failure).toBe("provider_outage");
  });
  it("capacity trips the breaker only when the policy allows it", () => {
    expect(countsTowardBreaker("capacity")).toBe(false);
    expect(countsTowardBreaker("capacity", { failoverOnCapacity: true })).toBe(true);
  });
});

describe("anti-flapping", () => {
  const cfg: BreakerConfig = { failureThreshold: 1, windowSeconds: 60, cooldownSeconds: 100, probeCalls: 1 };
  const at = (s: number) => new Date(Date.UTC(2026, 8, 29) + s * 1000);
  it("a quick re-trip after closing doubles the cooldown (capped), a late re-trip does not", () => {
    let s = onFailure(CLOSED, cfg, at(0), "provider_outage");
    expect(s.nextProbeAt!.getTime() - at(0).getTime()).toBe(100_000);
    s = tryAcquire(s, cfg, at(101)).next;           // half_open
    s = onSuccess(s, cfg, at(102));                  // closed
    s = onFailure(s, cfg, at(110), "provider_outage"); // re-trip within 4 × cooldown
    expect(s.trips).toBe(2);
    expect(s.nextProbeAt!.getTime() - at(110).getTime()).toBe(200_000);
    s = tryAcquire(s, cfg, at(311)).next; s = onSuccess(s, cfg, at(312));
    const late = onFailure(s, cfg, at(312 + 401), "provider_outage");
    expect(late.trips).toBe(1);
    expect(late.nextProbeAt!.getTime() - at(312 + 401).getTime()).toBe(100_000);
  });
  it("failures arriving while already open do not extend or reset it", () => {
    const open = onFailure(CLOSED, cfg, at(0), "auth");
    expect(onFailure(open, cfg, at(5), "provider_outage")).toEqual(open);
  });
});
