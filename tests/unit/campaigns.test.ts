import { describe, it, expect } from "vitest";
import { campaignSchema, distributionListSchema, personalizeVariables, renderTemplate, templateParameterKeys, validateTemplateVariables } from "@/lib/campaigns";

describe("campaign validation and personalization", () => {
  it("deduplicates recipients and rejects empty lists", () => {
    expect(distributionListSchema.parse({ name: "לקוחות", contactIds: ["a", "a", "b"] }).contactIds).toEqual(["a", "b"]);
    expect(distributionListSchema.safeParse({ name: " ", contactIds: [] }).success).toBe(false);
  });
  it("rejects incomplete campaigns", () => {
    expect(campaignSchema.safeParse({ name: "Test", listId: "", templateId: "t" }).success).toBe(false);
  });
  it("uses numeric placeholder order and repeated placeholders only once", () => {
    expect(templateParameterKeys("{{2}} {{1}} {{2}} {{10}}")).toEqual(["1", "2", "10"]);
  });
  it("rejects missing, empty, extra, and non-contiguous template variables", () => {
    expect(() => validateTemplateVariables("{{1}} {{2}}", { "1": "a" })).toThrow();
    expect(() => validateTemplateVariables("{{1}}", { "1": " " })).toThrow();
    expect(() => validateTemplateVariables("hello", { "1": "a" })).toThrow();
    expect(() => validateTemplateVariables("{{2}}", { "2": "a" })).toThrow();
    expect(() => validateTemplateVariables("{{1}} {{2}}", { "2": "b", "1": "a" })).not.toThrow();
  });
  it("personalizes names without treating dollar signs as replacement directives", () => {
    const variables = personalizeVariables({ "1": "שלום {name}", "2": "50₪" }, "$& ישראל");
    expect(renderTemplate("{{1}}, קיבלת {{2}}", variables)).toBe("שלום $& ישראל, קיבלת 50₪");
  });
});
it("pins the template category as well as the approved content", async () => {
  const { templateFingerprint } = await import("@/server/services/campaign-snapshot");
  const template = { name: "welcome", body: "Hello", language: "he", providerAccountId: "waba", providerTemplateId: "t", category: "UTILITY" };
  expect(templateFingerprint(template)).not.toBe(templateFingerprint({ ...template, category: "MARKETING" }));
  expect(templateFingerprint(template)).toBe(templateFingerprint({ ...template }));
});
