import { NextResponse, type NextRequest } from "next/server";
import { LANG_COOKIE } from "@/lib/i18n";

/**
 * Public pages (landing, privacy, terms, data deletion, support) are read by Meta's reviewers and crawler, which
 * carry no `lang` cookie. Without a cookie they follow the browser: Hebrew for `he`, otherwise English. The app
 * itself keeps Hebrew as its default – this only runs for the paths below.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has(LANG_COOKIE)) return NextResponse.next();
  const accept = request.headers.get("accept-language")?.trim().toLowerCase() ?? "";
  const headers = new Headers(request.headers);
  headers.set("x-public-lang", accept.startsWith("he") || accept.startsWith("iw") ? "he" : "en");
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/", "/privacy", "/terms", "/data-deletion", "/support"] };
