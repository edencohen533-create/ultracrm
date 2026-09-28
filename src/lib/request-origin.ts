import { ApiError } from "@/lib/response";

/** Cookie-authenticated mutations must originate from this application, not a sibling site or iframe. */
export function assertSameOriginMutation(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return;
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") throw new ApiError("מקור הבקשה אינו מורשה", 403, "invalid_origin");
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (source !== null) {
    let origin: string;
    try { origin = new URL(source).origin; } catch { throw new ApiError("מקור הבקשה אינו מורשה", 403, "invalid_origin"); }
    if (origin !== new URL(req.url).origin) throw new ApiError("מקור הבקשה אינו מורשה", 403, "invalid_origin");
  }
  // Non-browser clients may omit Origin/Fetch Metadata; they still need a valid authenticated session.
  // Browser form/fetch mutations carry Origin or Fetch Metadata, including requests from sibling domains.
}
