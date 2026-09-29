"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n/LangProvider";

/** Meta: JPG / PNG, up to 5 MB, 8-bit RGB(A). The server re-checks the bytes; this only saves a pointless upload. */
export const IMAGE_TYPES = ["image/jpeg", "image/png"];
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CHUNK = 1024 * 1024; // ≤ 1 MB per request (serverless body limits)

export interface UploadedImage { id: string; fileName: string; sizeBytes: number; width: number | null; height: number | null; previewUrl: string }
type Phase = { kind: "idle" } | { kind: "uploading"; pct: number } | { kind: "checking" } | { kind: "error"; message: string };

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(data?.error || data?.message || `HTTP ${res.status}`) as Error & { status?: number };
        e.status = res.status;
        if (res.status < 500) throw e; // a real refusal – do not retry
        lastErr = e; continue;
      }
      return (data?.data ?? data) as T;
    } catch (e) {
      if ((e as { status?: number }).status && (e as { status: number }).status < 500) throw e;
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("upload failed");
}

/**
 * Pick an image from the computer / phone (gallery or camera), see it, replace or remove it. Uploaded in chunks
 * to the business's own storage; the server checks it and Meta receives it when the template is submitted / sent.
 */
export function TemplateImageUpload({ value, onChange }: { value: UploadedImage | null; onChange: (v: UploadedImage | null) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  useEffect(() => () => { if (localPreview) URL.revokeObjectURL(localPreview); }, [localPreview]);
  const busy = phase.kind === "uploading" || phase.kind === "checking";

  async function upload(file: File) {
    if (!IMAGE_TYPES.includes(file.type)) { setPhase({ kind: "error", message: t("ניתן להעלות רק תמונת JPG או PNG", "Only JPG or PNG images can be uploaded") }); return; }
    if (file.size > IMAGE_MAX_BYTES) { setPhase({ kind: "error", message: t(`התמונה גדולה מ-5MB (${(file.size / 1048576).toFixed(1)}MB) – המגבלה של Meta. יש להקטין אותה`, `The image is larger than 5MB (${(file.size / 1048576).toFixed(1)}MB) – Meta's limit. Please make it smaller`) }); return; }
    if (!file.size) { setPhase({ kind: "error", message: t("הקובץ ריק", "The file is empty") }); return; }
    const previous = value;
    setLocalPreview(URL.createObjectURL(file));
    setPhase({ kind: "uploading", pct: 0 });
    try {
      const started = await call<{ id: string }>("/api/media/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: file.name, mimeType: file.type, sizeBytes: file.size }) });
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        const part = file.slice(offset, Math.min(offset + CHUNK, file.size));
        await call(`/api/media/uploads/${started.id}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: part });
        setPhase({ kind: "uploading", pct: Math.round(((offset + part.size) / file.size) * 100) });
      }
      setPhase({ kind: "checking" });
      const done = await call<{ id: string; fileName: string; sizeBytes: number; width: number | null; height: number | null }>(`/api/media/uploads/${started.id}/complete`, { method: "POST" });
      onChange({ ...done, previewUrl: `/api/media/${done.id}` });
      setPhase({ kind: "idle" });
      setLocalPreview(null);
      // Replaced: the old image is removed (it is not used by any template yet; a used one is kept by the server).
      if (previous) void fetch(`/api/media/${previous.id}`, { method: "DELETE" }).catch(() => undefined);
    } catch (e) {
      setLocalPreview(null);
      setPhase({ kind: "error", message: (e as Error).message || t("ההעלאה נכשלה – נסו שוב", "Upload failed – please try again") });
    }
  }

  async function remove() {
    if (!value) return;
    const id = value.id;
    onChange(null);
    setPhase({ kind: "idle" });
    await fetch(`/api/media/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  const shown = localPreview ?? value?.previewUrl ?? null;
  return (
    <div className="mt-2 space-y-2" data-testid="tb-image-upload">
      <input ref={input} type="file" accept="image/jpeg,image/png" className="hidden" data-testid="tb-image-file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
      {shown ? (
        <div className="flex flex-wrap items-start gap-3">
          <img src={shown} alt={t("תמונת הכותרת", "Header image")} className={`max-h-40 max-w-full rounded-md border border-line object-contain ${busy ? "opacity-60" : ""}`} data-testid="tb-image-preview" />
          <div className="space-y-1 text-xs">
            {value && !busy && <p className="text-muted" dir="auto">{value.fileName} · {(value.sizeBytes / 1024).toFixed(0)}KB{value.width ? ` · ${value.width}×${value.height}` : ""}</p>}
            {!busy && value && <p className="text-good" data-testid="tb-image-ready">{t("✓ הועלתה ונבדקה", "✓ Uploaded and checked")}</p>}
            <div className="flex gap-2">
              <button type="button" className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1" disabled={busy} onClick={() => input.current?.click()} data-testid="tb-image-replace"><RefreshCw size={13} />{t("החלפה", "Replace")}</button>
              <button type="button" className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-bad" disabled={busy} onClick={() => void remove()} data-testid="tb-image-remove"><Trash2 size={13} />{t("הסרה", "Remove")}</button>
            </div>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => input.current?.click()} disabled={busy} className="flex w-full flex-col items-center gap-1 rounded-md border border-dashed border-line px-3 py-5 text-sm" data-testid="tb-image-pick">
          <ImagePlus size={22} />
          <span>{t("בחירת תמונה מהמחשב או מהטלפון", "Choose an image from your computer or phone")}</span>
          <span className="text-xs text-muted">{t("JPG או PNG, עד 5MB", "JPG or PNG, up to 5MB")}</span>
        </button>
      )}
      {phase.kind === "uploading" && (
        <div role="status" aria-live="polite" className="text-xs">
          {t(`מעלה… ${phase.pct}%`, `Uploading… ${phase.pct}%`)}
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-panel-2"><div className="h-full bg-accent transition-all" style={{ width: `${phase.pct}%` }} /></div>
        </div>
      )}
      {phase.kind === "checking" && <p role="status" aria-live="polite" className="text-xs">{t("בודק את הקובץ…", "Checking the file…")}</p>}
      {phase.kind === "error" && <p role="alert" className="text-xs text-bad" data-testid="tb-image-error">{phase.message}</p>}
      <p className="text-xs text-muted">{t("Meta בודקת את התמונה עם התבנית. היא גם תישלח כברירת מחדל בכל שליחה של התבנית.", "Meta reviews the image with the template. It is also sent by default every time the template is sent.")}</p>
    </div>
  );
}
