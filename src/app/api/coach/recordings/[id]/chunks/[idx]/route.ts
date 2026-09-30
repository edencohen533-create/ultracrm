import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { putChunk, RECORDING_CHUNK_BYTES } from "@/server/coach/sales";

export const dynamic = "force-dynamic";

/** One raw chunk (≤ 2 MB). Re-sending the same index replaces it. */
export const PUT = withAuth(async ({ req, user, params }) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > RECORDING_CHUNK_BYTES) throw new ApiError("חלק גדול מדי", 413, "chunk_too_large");
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > RECORDING_CHUNK_BYTES) throw new ApiError("חלק גדול מדי", 413, "chunk_too_large");
  return ok(await putChunk(user, params.id, Number(params.idx), buf));
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
