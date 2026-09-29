import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { startImageUpload } from "@/server/services/media-asset-service";

export const dynamic = "force-dynamic";

/** Start uploading a template header image (JPG / PNG ≤ 5 MB). The bytes follow in chunks (PUT …/uploads/:id). */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ fileName: z.string().trim().min(1).max(255), mimeType: z.string().trim().max(100), sizeBytes: z.number().int() }));
  return ok(await startImageUpload(user, b), 201);
}, { perm: ["whatsapp.campaign_draft", "whatsapp.automations"] });
