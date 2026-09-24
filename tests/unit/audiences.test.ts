import { expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { audienceSchema, defaultAudience } from "@/lib/audiences";
import { distributionListSchema } from "@/lib/campaigns";
import { validateAudienceReferences } from "@/server/services/audience-service";
import type { Prisma } from "@/generated/prisma/client";
it("accepts bounded AND/OR nesting and rejects arbitrary operators or fields", () => {
  expect(audienceSchema.safeParse({ operator: "OR", conditions: [defaultAudience(), { field: "custom", operator: "contains", key: "מוצר", value: "ספר" }] }).success).toBe(true);
  expect(audienceSchema.safeParse({ field: "businessId", operator: "equals", value: "foreign" }).success).toBe(false);
  expect(audienceSchema.safeParse({ field: "source", operator: "rawSQL", value: "1=1" }).success).toBe(false);
  let deeplyNested: unknown = defaultAudience();
  for (let i = 0; i < 100; i++) deeplyNested = { operator: "AND", conditions: [deeplyNested] };
  expect(audienceSchema.safeParse(deeplyNested).success).toBe(false);
});
it("requires dates for comparisons and rejects excessive predicate count", () => {
  expect(audienceSchema.safeParse({ field: "lastInbound", operator: "before" }).success).toBe(false);
  expect(audienceSchema.safeParse({ field: "lastInbound", operator: "never" }).success).toBe(true);
  expect(audienceSchema.safeParse({ operator: "AND", conditions: Array.from({ length: 20 }, () => ({ operator: "OR", conditions: Array.from({ length: 3 }, () => ({ field: "blocked", operator: "is", value: false })) })) }).success).toBe(false);
});
it("cannot combine static members and a dynamic segment or save an empty static list", () => {
  expect(distributionListSchema.safeParse({ name: "empty", contactIds: [] }).success).toBe(false);
  expect(distributionListSchema.safeParse({ name: "mixed", contactIds: ["c"], segment: defaultAudience() }).success).toBe(false);
  expect(distributionListSchema.safeParse({ name: "dynamic", segment: defaultAudience() }).success).toBe(true);
});
it("rejects inaccessible references even in negative tag conditions", async () => {
  const count = vi.fn().mockResolvedValue(0);
  await expect(validateAudienceReferences({ tag: { count } } as unknown as Prisma.TransactionClient, { field: "tag", operator: "is_not", value: "foreign-tag" })).rejects.toThrow("אינו נגיש");
});
