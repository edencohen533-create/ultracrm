import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { appendChunk, UPLOAD_CHUNK_BYTES } from "@/server/services/media-asset-service";

export const dynamic = "force-dynamic";

/** One chunk (raw bytes, ≤ 1 MB) at ?offset=N. Retrying the same chunk is harmless. */
export const PUT = withAuth(async ({ req, user, params }) => {
  const offset = Number(new URL(req.url).searchParams.get("offset"));
  if (!Number.isInteger(offset) || offset < 0) throw new ApiError("היסט לא תקין", 400, "bad_offset");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > UPLOAD_CHUNK_BYTES) throw new ApiError("חלק גדול מדי", 413, "chunk_too_large");
  const chunk = Buffer.from(await req.arrayBuffer());
  if (!chunk.length) throw new ApiError("חלק ריק", 400, "empty_chunk");
  return ok(await appendChunk(user, params.id, offset, chunk));
}, { perm: ["whatsapp.campaign_draft", "whatsapp.automations"] });
