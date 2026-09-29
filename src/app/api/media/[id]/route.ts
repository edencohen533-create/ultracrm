import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { readyAsset, deleteAsset } from "@/server/services/media-asset-service";

export const dynamic = "force-dynamic";

/** The image itself (preview) – only for the business that uploaded it. */
export const GET = withAuth(async ({ user, params }) => {
  const a = await readyAsset(user.businessId, params.id);
  if (!a) throw new ApiError("הקובץ לא נמצא", 404, "not_found");
  return new Response(new Uint8Array(a.data), { headers: {
    "Content-Type": a.mimeType, "Content-Length": String(a.data.length), "Cache-Control": "private, max-age=300",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(a.fileName)}`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
  } });
}, { perm: ["whatsapp.reply", "whatsapp.campaign_draft", "whatsapp.automations"] });

/** Remove (or replace) an uploaded image that no template uses yet. */
export const DELETE = withAuth(async ({ user, params }) => ok(await deleteAsset(user, params.id)), { perm: ["whatsapp.campaign_draft", "whatsapp.automations"] });
