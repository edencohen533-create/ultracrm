import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { NextRequest } from "next/server";

// Exercise the exported handlers themselves, including newly added routes. An auth wrapper in source
// is only the inventory filter; responses prove every exported method actually enforces it.
const routes = import.meta.glob("../../src/app/api/**/route.ts");
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
for (const [file, load] of Object.entries(routes)) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  if (!/\b(withAuth|organizationRequest|requireUser)\b/.test(source)) continue;
  const path = file.replace("../../src/app", "").replace("/route.ts", "");
  it(`requires authentication for every method of ${path}`, async () => {
    const routeModule = await load() as Record<string, unknown>;
    const names = [...path.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
    const url = `http://localhost${path.replace(/\[[^\]]+\]/g, "security-test-id")}`;
    const ctx = { params: Promise.resolve(Object.fromEntries(names.map(n => [n, "security-test-id"]))) };
    for (const method of methods) {
      if (typeof routeModule[method] !== "function") continue;
      const handler = routeModule[method] as (req: NextRequest, context: typeof ctx) => Promise<Response>;
      const response = await handler(new NextRequest(url, { method }), ctx);
      if (method === "GET" && /^\/api\/integrations\/meta-ads\/oauth\/(start|callback)$/.test(path)) {
        expect(response.status).toBe(307);
        const back = new URL(response.headers.get("location")!);
        expect(back.origin).toBe("http://localhost");
        expect(back.pathname).toBe("/settings");
        expect(back.searchParams.get("reason")).toBe("unauthorized");
      } else expect(response.status, `${method} ${path} must reject an anonymous caller`).toBe(401);
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        const crossOrigin = await handler(new NextRequest(url, { method, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), ctx);
        expect(crossOrigin.status, `${method} ${path} must reject a cross-origin write`).toBe(403);
      }
    }
  });
}
