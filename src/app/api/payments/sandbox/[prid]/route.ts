import { z } from "zod";
import { sandboxDecision } from "@/server/services/payment-service";
import { ApiError } from "@/lib/response";

export const dynamic = "force-dynamic";

/** Test page action (sandbox provider only): simulate the provider approving / declining. No card data exists here. */
export async function POST(req: Request, { params }: { params: Promise<{ prid: string }> }) {
  const { prid } = await params;
  const b = z.object({ result: z.enum(["approved", "declined"]) }).safeParse(await req.json().catch(() => null));
  if (!b.success || !/^sbx_[a-f0-9]{24}$/.test(prid)) return Response.json({ error: "bad request" }, { status: 400 });
  try { const r = await sandboxDecision(prid, b.data.result); return Response.json({ ok: r.status === 200 }); }
  catch (e) { return Response.json({ error: e instanceof ApiError ? e.message : "failed" }, { status: e instanceof ApiError ? e.status : 500 }); }
}
