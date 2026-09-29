import { describe, it, expect } from "vitest";
import { parseLeadText, matchProduct } from "@/server/assistant/create-lead";

describe("parseLeadText – free text from the WhatsApp assistant", () => {
  it("comma separated, the example from the spec", () => {
    expect(parseLeadText(": דנה כהן, 0501234567, מגנזיום, מקור פייסבוק")).toEqual({ name: "דנה כהן", phoneRaw: "0501234567", product: "מגנזיום", source: "פייסבוק" });
  });
  it("labeled fields in any order, phone with dashes, 'מפייסבוק'", () => {
    expect(parseLeadText(" מוצר: ויטמין D, טלפון 050-123-4567, שם: רון לוי, מפייסבוק")).toEqual({ product: "ויטמין D", phoneRaw: "050-123-4567", name: "רון לוי", source: "פייסבוק" });
    expect(parseLeadText(" בשם שירה 0521112233 מוצר מגנזיום מקור אתר")).toMatchObject({ name: "שירה", phoneRaw: "0521112233", product: "מגנזיום", source: "אתר" });
  });
  it("only what is written – nothing invented; 'אין' means none", () => {
    expect(parseLeadText(": אבי")).toEqual({ name: "אבי" });
    expect(parseLeadText(": אבי, 0501234567, מוצר אין, מקור לא ידוע")).toEqual({ name: "אבי", phoneRaw: "0501234567", product: null, source: null });
  });
  it("a general source stays a source (no campaign / ad keys)", () => {
    const r = parseLeadText(": דנה, 0501234567, מגנזיום, facebook");
    expect(r.source).toBe("פייסבוק");
    expect(Object.keys(r)).not.toContain("campaign");
  });
});

describe("matchProduct", () => {
  const catalog = ["מגנזיום ציטרט", "מגנזיום ביסגליצינט", "ויטמין D"];
  it("exact / single partial / several / unknown", () => {
    expect(matchProduct("ויטמין d", catalog)).toEqual({ value: "ויטמין D" });
    expect(matchProduct("ציטרט", catalog)).toEqual({ value: "מגנזיום ציטרט" });
    expect(matchProduct("מגנזיום", catalog)).toEqual({ options: ["מגנזיום ציטרט", "מגנזיום ביסגליצינט"] });
    expect(matchProduct("אומגה 3", catalog)).toEqual({ value: "אומגה 3" });
    expect(matchProduct("אומגה 3", [])).toEqual({ value: "אומגה 3" });
  });
});
