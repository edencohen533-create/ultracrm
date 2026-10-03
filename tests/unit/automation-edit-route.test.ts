// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), audit: vi.fn(), validate: vi.fn(), allowed: true }));
vi.mock("@/lib/auth-compat", () => ({ organizationRequest: (handler: unknown) => handler, auth: async () => ({ user: { id: "owner" } }), hasRole: () => m.allowed, ROLES_ADMIN_MANAGER: [] }));
vi.mock("@/server/services/automation-preview-service", () => ({ validateAutomationReferences: m.validate, AutomationPreviewError: class extends Error {} }));
vi.mock("@/lib/db", () => ({ prisma: { automationRule: { findUnique: m.find }, $transaction: async (fn: (tx: unknown) => unknown) => fn({ automationRule: { update: m.update }, auditLog: { create: m.audit } }) } }));
import { PATCH } from "@/app/api/automations/rules/[id]/route";
const valid = { name: "new", trigger: "NEW_CONVERSATION", triggerConfig: {}, actionType: "ADD_TAG", actionConfig: { tagName: "VIP" }, isActive: true };
const call = (body: unknown) => PATCH(new Request("https://crm.test/api/automations/rules/r1", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "r1" }) });
beforeEach(() => { vi.clearAllMocks(); m.allowed = true; m.find.mockResolvedValue({ id: "r1", ...valid }); m.update.mockResolvedValue({ id: "r1", ...valid }); });
it("updates the existing rule with validated complete configuration and an audit", async () => {
  expect((await call(valid)).status).toBe(200);
  expect(m.validate).toHaveBeenCalledWith(valid);
  expect(m.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: valid });
  expect(m.audit.mock.calls[0][0].data.action).toBe("automation.updated");
});
it("does not silently accept an incomplete edit as a toggle", async () => {
  expect((await call({ name: "changed", isActive: true })).status).toBe(400); expect(m.update).not.toHaveBeenCalled();
});
it("rejects empty tag names and missing rules", async () => {
  expect((await call({ ...valid, actionConfig: { tagName: " " } })).status).toBe(400);
  m.find.mockResolvedValue(null); expect((await call(valid)).status).toBe(404); expect(m.update).not.toHaveBeenCalled();
});
it("retains pause support and checks the manager role", async () => {
  expect((await call({ isActive: false })).status).toBe(200); expect(m.validate).not.toHaveBeenCalled();
  m.allowed = false; expect((await call(valid)).status).toBe(403); expect(m.update).toHaveBeenCalledTimes(1);
});
