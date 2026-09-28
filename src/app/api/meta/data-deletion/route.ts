import { metaAppEnv } from "@/lib/meta/graph";
import { handleMetaUserRemoval, parseSignedRequest, SignedRequestError } from "@/server/services/meta-deletion-service";
import { platformIdentity } from "@/lib/platform-identity";

export const dynamic = "force-dynamic";

/** Meta Data Deletion Request callback: verify signed_request → erase → `{ url, confirmation_code }`. */
export async function POST(req: Request) {
  const secret = metaAppEnv().appSecret; // trimmed – same value the webhook signature check uses
  if (!secret) return Response.json({ error: "not configured" }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const sr = form?.get("signed_request");
  try {
    const { user_id } = parseSignedRequest(String(sr ?? ""), secret);
    const row = await handleMetaUserRemoval("data_deletion", user_id);
    return Response.json({ url: `${platformIdentity().appUrl}/data-deletion?code=${row.confirmationCode}`, confirmation_code: row.confirmationCode });
  } catch (e) {
    if (e instanceof SignedRequestError) return Response.json({ error: "invalid signed_request" }, { status: 400 });
    console.error("meta data deletion failed", (e as Error).message);
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
