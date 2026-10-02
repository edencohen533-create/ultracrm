import { expect, it } from "vitest";
import { renderCallScript } from "@/lib/client/call-script";
it("renders repeated supported fields without interpreting replacement characters", () => {
  expect(renderCallScript("{{agent}} מ{{ business }} ל{{name}} {{phone}} {{agent}}", { agent: "A$&", business: "CRM", name: "לקוח", phone: "0501234567" })).toBe("A$& מCRM ללקוח 0501234567 A$&");
});
it("keeps unavailable and unsupported fields visible instead of inventing values", () => {
  expect(renderCallScript("{{agent}} {{unknown}}", {})).toBe("{{agent}} {{unknown}}");
});
