import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { finishUpload } from "@/server/services/media-asset-service";

export const dynamic = "force-dynamic";

/** All chunks sent → the file is checked (signature, JPG/PNG 8-bit RGB(A), ≤ 5 MB) and becomes usable. */
export const POST = withAuth(async ({ user, params }) => ok(await finishUpload(user, params.id)), { perm: ["whatsapp.campaign_draft", "whatsapp.automations"] });
