import { handleMetaUserRemoval, parseSignedRequest, SignedRequestError } from "@/server/services/meta-deletion-service";

export const dynamic = "force-dynamic";

/** Meta Deauthorize callback: the person removed the app → disconnect their WhatsApp connections. */
export async function POST(req: Request) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return Response.json({ error: "not configured" }, { status: 503 });
  const form = await req.formData().catch(() => null);
  try {
    const { user_id } = parseSignedRequest(String(form?.get("signed_request") ?? ""), secret);
    await handleMetaUserRemoval("deauthorize", user_id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof SignedRequestError) return Response.json({ error: "invalid signed_request" }, { status: 400 });
    console.error("meta deauthorize failed", (e as Error).message);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
