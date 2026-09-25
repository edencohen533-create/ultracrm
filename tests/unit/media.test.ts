import { describe, expect, it } from "vitest";
import { safeMediaDownloadUrl, mediaType } from "@/lib/media";
describe("media boundaries", () => {
  it("only downloads from approved Meta HTTPS hosts", () => {
    expect(safeMediaDownloadUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments?id=1").hostname).toBe("lookaside.fbsbx.com");
    expect(safeMediaDownloadUrl("https://scontent.xx.fbcdn.net/file").protocol).toBe("https:");
    for (const url of ["http://lookaside.fbsbx.com/file", "https://lookaside.fbsbx.com.evil.example/file", "https://localhost/file", "https://127.0.0.1/file", "https://user:password@lookaside.fbsbx.com/file", "https://lookaside.fbsbx.com:444/file"]) expect(() => safeMediaDownloadUrl(url)).toThrow();
  });
  it("does not serve HTML or SVG as inline media", () => {
    expect(mediaType("text/html")).toBeUndefined(); expect(mediaType("image/svg+xml")).toBeUndefined();
    expect(mediaType("application/pdf")).toBe("DOCUMENT");
  });
});
