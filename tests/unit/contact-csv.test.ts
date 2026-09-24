import { describe, expect, it } from "vitest";
import { parseCsv, parseContactCsv } from "@/lib/contact-csv";
describe("contact CSV import", () => {
  it("handles BOM, Hebrew, CRLF, quoted commas, escaped quotes and newlines", () => {
    expect(parseCsv('\uFEFFname,phone\r\n"דנה, ""כהן""\nלוי",0501234567\r\n')).toEqual([["name", "phone"], ['דנה, "כהן"\nלוי', "0501234567"]]);
  });
  it("does not infer marketing consent", () => {
    expect(parseContactCsv("name,phone\nDana,0501234567").contacts[0]).toEqual({ name: "Dana", phone: "+972501234567", consentStatus: "UNKNOWN" });
  });
  it("normalizes and deduplicates phones while retaining opt-out", () => {
    const result = parseContactCsv("name,phone,consentStatus\nDana,0501234567,OPTED_IN\nDana,+972501234567,OPTED_OUT");
    expect(result.duplicateRows).toBe(1); expect(result.contacts[0].consentStatus).toBe("OPTED_OUT");
  });
  it("rejects malformed input with a row number", () => {
    expect(() => parseContactCsv("name,phone\nDana,wrong")).toThrow("2");
    expect(() => parseContactCsv('name,phone\n"Dana,123')).toThrow("מרכאות");
    expect(() => parseContactCsv("name,phone,consentStatus\nDana,0501234567,yes")).toThrow("consentStatus");
  });
});
it("maps arbitrary columns and produces a bounded-error preview without silently importing invalid rows", () => {
  const csv = "customer,mobile,permission\nDana,0501234567,OPTED_IN\nBad,no,UNKNOWN";
  const mapping = { name: "customer", phone: "mobile", consentStatus: "permission" };
  const result = parseContactCsv(csv, mapping, true);
  expect(result.contacts).toHaveLength(1); expect(result.errors[0].row).toBe(3);
  expect(() => parseContactCsv(csv, mapping)).toThrow();
});
it("validates and normalizes a 10,000-row import", () => {
  const csv = "name,phone,consentStatus\n" + Array.from({ length: 10000 }, (_, i) => `QA ${i},+97250${String(i).padStart(7, "0")},OPTED_IN`).join("\n");
  const result = parseContactCsv(csv);
  expect(result.contacts).toHaveLength(10000); expect(result.errors).toHaveLength(0);
});
