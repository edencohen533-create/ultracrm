// @vitest-environment node
import { expect, it } from "vitest";
import { assertSameOriginMutation } from "@/lib/request-origin";

it.each(["https://evil.example", "https://app.example.evil.test", "https://sibling.example", "null"])("rejects mutation from %s", origin => {
  expect(() => assertSameOriginMutation(new Request("https://app.example/api/contacts", { method: "POST", headers: { origin } }))).toThrow();
});
it.each(["cross-site", "same-site"])("rejects fetch metadata %s even without Origin", site => {
  expect(() => assertSameOriginMutation(new Request("https://app.example/api/auth/logout", { method: "POST", headers: { "sec-fetch-site": site } }))).toThrow();
});
it("accepts same-origin mutation and non-browser clients; leaves read methods alone", () => {
  for (const req of [new Request("https://app.example/api/x", { method: "POST", headers: { origin: "https://app.example" } }), new Request("https://app.example/api/x", { method: "POST" }), new Request("https://app.example/api/x", { headers: { origin: "https://other.example" } })]) expect(() => assertSameOriginMutation(req)).not.toThrow();
});
it("rejects an external Referer fallback", () => {
  expect(() => assertSameOriginMutation(new Request("https://app.example/api/x", { method: "DELETE", headers: { referer: "https://other.example/form" } }))).toThrow();
});
