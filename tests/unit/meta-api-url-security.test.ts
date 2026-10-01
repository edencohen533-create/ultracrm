import { afterEach, expect, it, vi } from "vitest";
import { adsGet, adsGetAll } from "@/server/marketing/meta-api";
afterEach(() => vi.unstubAllGlobals());
it.each(["https://evil.example/collect", "https://graph.facebook.com.evil.example/", "https://graph.facebook.com@evil.example/", "https://graph.facebook.com:444/", "https://user:password@graph.facebook.com/"])("never sends a token to an untrusted destination: %s", async url => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(adsGet(url, "private-business-token")).rejects.toMatchObject({ kind: "invalid" });
  expect(fetchMock).not.toHaveBeenCalled();
});
it("rejects an off-domain pagination link without following it", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [], paging: { next: "https://evil.example/next" } })); vi.stubGlobal("fetch", fetchMock);
  await expect(adsGetAll("act_123/insights", "private-business-token", {})).rejects.toMatchObject({ kind: "invalid" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("allows official Graph pagination and keeps credentials in headers", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: [1], paging: { next: "https://graph.facebook.com/v25.0/act_123/insights?after=abc" } })).mockResolvedValueOnce(Response.json({ data: [2] })); vi.stubGlobal("fetch", fetchMock);
  expect(await adsGetAll<number>("act_123/insights", "private-business-token", {})).toEqual([1, 2]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const call of fetchMock.mock.calls) { expect(String(call[0])).not.toContain("private-business-token"); expect(call[1]).toMatchObject({ headers: { Authorization: "Bearer private-business-token" }, redirect: "error" }); }
});
