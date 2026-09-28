// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocked.lookup }));
vi.mock("node:https", () => ({ request: mocked.request }));
import { isPublicAddress, safeFetch } from "@/lib/safe-url";
afterEach(() => vi.resetAllMocks());

it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.1", "::1", "::", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2001::1", "2002:7f00:1::", "ff02::1"])("rejects non-public destination %s", address => expect(isPublicAddress(address)).toBe(false));
it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public destination %s", address => expect(isPublicAddress(address)).toBe(true));
it("blocks a public-looking hostname resolving to metadata without opening a connection", async () => {
  mocked.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
  await expect(safeFetch("https://attacker.example/resource")).rejects.toMatchObject({ code: "private_destination" });
  expect(mocked.request).not.toHaveBeenCalled();
});
it("rejects mixed public/private DNS answers", async () => {
  mocked.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }, { address: "::1", family: 6 }]);
  await expect(safeFetch("https://mixed.example/")).rejects.toThrow();
  expect(mocked.request).not.toHaveBeenCalled();
});
it("pins the resolved IP while preserving TLS identity and Host; never follows redirects", async () => {
  mocked.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  mocked.request.mockImplementation((options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
    req.end = vi.fn(() => {
      const res = Object.assign(new EventEmitter(), { headers: { location: "https://127.0.0.1/private" }, statusCode: 302 });
      callback(res); queueMicrotask(() => res.emit("end"));
    });
    return req;
  });
  const response = await safeFetch("https://public.example/path?q=1", { headers: { host: "forged.example" } });
  expect(response.status).toBe(302);
  expect(mocked.lookup).toHaveBeenCalledTimes(1);
  expect(mocked.request).toHaveBeenCalledTimes(1);
  expect(mocked.request.mock.calls[0][0]).toMatchObject({ hostname: "1.1.1.1", servername: "public.example", agent: false, path: "/path?q=1", headers: { host: "public.example" } });
});
