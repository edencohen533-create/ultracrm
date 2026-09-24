export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MEDIA_TYPES = {
  "image/jpeg": "IMAGE", "image/png": "IMAGE", "video/mp4": "VIDEO",
  "audio/mpeg": "AUDIO", "audio/ogg": "AUDIO", "audio/mp4": "AUDIO", "audio/aac": "AUDIO",
  "application/pdf": "DOCUMENT", "text/plain": "DOCUMENT",
} as const;
export function mediaType(mimeType: string) { return MEDIA_TYPES[mimeType as keyof typeof MEDIA_TYPES]; }
export function safeMediaDownloadUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !(url.hostname === "lookaside.fbsbx.com" || url.hostname.endsWith(".fbcdn.net"))) throw new Error("Invalid Meta media host");
  return url;
}
