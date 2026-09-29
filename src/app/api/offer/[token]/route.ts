import { publicQuote, acceptQuote } from "@/server/sales/quotes";
import { ok, handleError } from "@/lib/response";
import { assertSameOriginMutation } from "@/lib/request-origin";
type Ctx = { params: Promise<{ token: string }> };
export async function GET(_req: Request, ctx: Ctx) {
  try {
    return ok(await publicQuote((await ctx.params).token));
  } catch (e) {
    return handleError(e);
  }
}
export async function POST(req: Request, ctx: Ctx) {
  try {
    assertSameOriginMutation(req);
    return ok(await acceptQuote((await ctx.params).token, await req.json()));
  } catch (e) {
    return handleError(e);
  }
}
