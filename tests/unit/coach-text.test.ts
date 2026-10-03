// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), audit: vi.fn(), findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { salesInsight: { create: mocks.create, findMany: mocks.findMany } } }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
import { createTextInsight, retrieveInsights } from "@/server/coach/sales";
import { textInsightSchema } from "@/lib/validation/coach-text";
import type { SessionUser } from "@/lib/auth";
const user = { id: "manager", businessId: "business" } as SessionUser;
beforeEach(() => { vi.clearAllMocks(); mocks.create.mockImplementation(async ({ data }) => ({ id: "text-1", ...data })); });
it("stores manual text as tenant-scoped pending knowledge with author and audit", async () => {
  const row = await createTextInsight(user, { kind: "objection", title: "צריך לחשוב", body: "מה חסר כדי לקבל החלטה?" });
  expect(row).toMatchObject({ businessId: "business", createdById: "manager", status: "candidate", flags: [] });
  expect(mocks.audit).toHaveBeenCalledWith("business", "manager", "coach", "text-1", "sales_insight.text_created", { source: "text", kind: "objection" });
});
it("redacts customer details and flags risky claims for the existing approval gate", async () => {
  const row = await createTextInsight(user, { kind: "offer", title: "הצעה", body: "מובטח חינם. test@example.com" });
  expect(row.body).not.toContain("test@example.com");
  expect(row.flags).toEqual(expect.arrayContaining(["customer_detail", "discount", "promise"]));
});
it("retrieves approved text lessons without requiring a recording", async () => {
  mocks.findMany.mockResolvedValue([{ id: "text-1", title: "צריך לחשוב", kind: "objection", body: "מה חסר כדי לקבל החלטה?", objection: "צריך לחשוב", embedding: null }]);
  expect((await retrieveInsights("business", "צריך לחשוב"))[0]?.id).toBe("text-1");
  expect(mocks.findMany.mock.calls[0][0].where).toEqual({ businessId: "business", status: "approved" });
});
it("rejects blank, oversized and invalid lessons", () => {
  const good = { kind: "closing", title: "סגירה", body: "לקבוע את הצעד הבא" };
  expect(textInsightSchema.safeParse(good).success).toBe(true);
  for (const patch of [{ body: " " }, { title: " " }, { body: "x".repeat(1201) }, { kind: "unknown" }]) expect(textInsightSchema.safeParse({ ...good, ...patch }).success).toBe(false);
});
