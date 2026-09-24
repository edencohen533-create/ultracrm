import { beforeEach, describe, expect, it, vi } from "vitest";
const { db } = vi.hoisted(() => ({ db: {
  providerCredential: { findFirst: vi.fn() },
  template: { updateMany: vi.fn(), upsert: vi.fn() }, $transaction: vi.fn(),
} }));
vi.mock("@/lib/db", () => ({ prisma: db }));
import { mapRemoteTemplate, syncMetaTemplates } from "@/server/services/template-sync-service";
const base = { id: "1", name: "welcome", language: "he", category: "UTILITY" as const, status: "APPROVED", components: [{ type: "BODY", text: "שלום {{1}}" }] };
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllGlobals();
  db.providerCredential.findFirst.mockResolvedValue({ config: { accessToken: "secret", businessAccountId: "123" } });
  db.$transaction.mockImplementation((fn) => fn(db));
});
describe("Meta template synchronization", () => {
  it("maps approved positional text templates", () => {
    expect(mapRemoteTemplate(base)).toMatchObject({ status: "APPROVED", variables: ["1"], providerTemplateId: "1", syncError: null });
  });
  it("supports media headers, disables unsupported headers and named variables, keeps Meta PAUSED/DISABLED as their own statuses", () => {
    const media = mapRemoteTemplate({ ...base, components: [{ type: "HEADER", format: "IMAGE" }, ...base.components] } as Parameters<typeof mapRemoteTemplate>[0]);
    expect(media.status).toBe("APPROVED"); expect(media.headerFormat).toBe("IMAGE");
    expect(mapRemoteTemplate({ ...base, components: [{ type: "HEADER", format: "LOCATION" }, ...base.components] } as Parameters<typeof mapRemoteTemplate>[0]).status).toBe("DRAFT");
    expect(mapRemoteTemplate({ ...base, components: [{ type: "BODY", text: "{{name}}" }] }).status).toBe("DRAFT");
    expect(mapRemoteTemplate({ ...base, status: "PAUSED" }).status).toBe("PAUSED");
    expect(mapRemoteTemplate({ ...base, status: "DISABLED" }).status).toBe("DISABLED");
  });
  it("rebuilds pagination URLs without trusting remote next hosts", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [base], paging: { next: "https://evil.example", cursors: { after: "cursor" } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ ...base, id: "2", language: "en" }] }) });
    vi.stubGlobal("fetch", request);
    expect(await syncMetaTemplates()).toEqual({ synced: 2, sendable: 2, unsupported: 0 });
    expect(new URL(request.mock.calls[1][0]).hostname).toBe("graph.facebook.com");
    expect(db.template.upsert.mock.calls[1][0].where).toEqual({ businessId_name_language: { businessId: "test-business", name: "welcome", language: "en" } });
  });
  it("does not save a partial sync when pagination fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [base], paging: { next: "next", cursors: { after: "cursor" } } }) }).mockResolvedValueOnce({ ok: false }));
    await expect(syncMetaTemplates()).rejects.toThrow("Meta");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
