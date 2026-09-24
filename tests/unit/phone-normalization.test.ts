import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  it("normalizes various Israeli local formats to the same E.164 string", () => {
    const variants = ["050-1234567", "0501234567", "050 123 4567", "+972501234567", "972501234567"];
    const normalized = variants.map((v) => normalizePhone(v));

    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("+972501234567");
  });

  it("returns null for invalid input", () => {
    expect(normalizePhone("not a phone number")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("accepts explicit international numbers outside Israel", () => {
    expect(normalizePhone("+1 415 555 2671")).toBe("+14155552671");
  });
});
