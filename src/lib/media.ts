export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MEDIA_TYPES = {
  "image/jpeg": "IMAGE", "image/png": "IMAGE", "video/mp4": "VIDEO",
  "audio/mpeg": "AUDIO", "audio/ogg": "AUDIO", "audio/mp4": "AUDIO", "audio/aac": "AUDIO",
  "application/pdf": "DOCUMENT", "text/plain": "DOCUMENT",
} as const;
export function mediaType(mimeType: string) { return MEDIA_TYPES[mimeType as keyof typeof MEDIA_TYPES]; }

/** File-signature check: the declared MIME type must match the bytes (no reliance on the browser's claim). */
export function magicBytesMatch(buffer: Buffer, mimeType: string): boolean {
  const b = buffer;
  const ascii = (o: number, s: string) => b.subarray(o, o + s.length).toString("latin1") === s;
  switch (mimeType) {
    case "image/jpeg": return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": return b.length > 8 && b[0] === 0x89 && ascii(1, "PNG");
    case "image/gif": return ascii(0, "GIF8");
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "application/pdf": return ascii(0, "%PDF");
    case "video/mp4": case "video/3gpp": return ascii(4, "ftyp");
    case "audio/mpeg": return (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || ascii(0, "ID3");
    case "audio/ogg": return ascii(0, "OggS");
    case "audio/aac": return b.length > 1 && b[0] === 0xff && (b[1] & 0xf0) === 0xf0;
    case "audio/mp4": case "audio/amr": return ascii(4, "ftyp") || ascii(0, "#!AMR");
    default: return true; // types without a stable signature (e.g. text/plain) rely on the allowlist + size
  }
}
export function safeMediaDownloadUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !(url.hostname === "lookaside.fbsbx.com" || url.hostname.endsWith(".fbcdn.net"))) throw new Error("Invalid Meta media host");
  return url;
}
