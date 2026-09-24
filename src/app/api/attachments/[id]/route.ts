import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { buildConversationScope } from "@/server/services/conversation-service";
import { getActiveProvider } from "@/server/providers/provider-registry";
import { MAX_DOWNLOAD_BYTES, mediaType } from "@/lib/media";

export const GET = organizationRequest(async function(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const attachment = await prisma.messageAttachment.findFirst({ where: {
    id, message: { conversation: buildConversationScope(session) },
  }, include: { message: { select: { providerCredentialId: true, conversation: { select: { providerCredentialId: true } } } } } });
  if (!attachment?.providerMediaId) return Response.json({ error: "Not found" }, { status: 404 });
  const range = request.headers.get("range") ?? undefined;
  if (range && !/^bytes=\d*-\d*$/.test(range)) return new Response(null, { status: 416 });
  try {
    const provider = await getActiveProvider(attachment.message.providerCredentialId ?? attachment.message.conversation.providerCredentialId, true);
    if (!provider.downloadMedia) return Response.json({ error: "Media provider unavailable" }, { status: 409 });
    const source = await provider.downloadMedia(attachment.providerMediaId, range);
    let bytes = 0;
    const limited = source.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_DOWNLOAD_BYTES) { controller.error(new Error("Media exceeds download limit")); return; }
      controller.enqueue(chunk);
    } }));
    const mimeType = source.headers.get("content-type")?.split(";")[0] ?? attachment.mimeType;
    const inline = ["IMAGE", "AUDIO", "VIDEO"].includes(mediaType(mimeType) ?? "");
    const headers = new Headers({
      "Content-Type": mediaType(mimeType) ? mimeType : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent((attachment.fileName ?? "attachment").replace(/[\r\n]/g, ""))}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
    });
    for (const key of ["content-length", "content-range", "accept-ranges"]) { const value = source.headers.get(key); if (value) headers.set(key, value); }
    return new Response(limited, { status: source.status === 206 ? 206 : 200, headers });
  } catch { return Response.json({ error: "הקובץ אינו זמין כרגע או חורג ממגבלת 20MB" }, { status: 502 }); }
});
