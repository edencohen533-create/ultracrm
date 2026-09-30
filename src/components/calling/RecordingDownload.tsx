"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { useMe } from "@/lib/client/use-me";
import { useT } from "@/components/i18n/LangProvider";
import { cx } from "@/components/ui";

/**
 * "הורד הקלטה" – one component for every place that shows a recording (call history, call details, lead / customer
 * card, dialer lead card, sales coach). The file always comes through the server route (permission checked there:
 * telephony.recordings + telephony.recordings_download, audited) – never a public or permanent link. The button is
 * fetched first so a server refusal shows as a clear message instead of a broken file.
 */
export function RecordingDownload({ callId, href, status = "saved", purgedAt, fileName, play = false, className }: {
  /** a call recording (/api/recordings/:callId) … */
  callId?: string;
  /** … or any other server route (e.g. a sales-coach upload) */
  href?: string;
  status?: string | null;
  purgedAt?: string | Date | null;
  fileName?: string;
  play?: boolean;
  className?: string;
}) {
  const t = useT();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const actions = me?.access?.modules.telephony?.actions ?? [];
  const canPlay = actions.includes("recordings");
  const canDownload = canPlay && actions.includes("recordings_download");
  const base = href ?? (callId ? `/api/recordings/${callId}` : null);
  const note = (text: string) => <span className={cx("text-xs text-muted", className)} data-testid="recording-state">{text}</span>;
  if (!base) return null;
  if (status === "recording") return note(t("ההקלטה עדיין לא זמינה – היא נשמרת בסיום השיחה", "Not available yet – saved when the call ends"));
  if (status === "failed") return note(t("ההקלטה נכשלה ולא נשמרה", "The recording failed and was not saved"));
  if (status !== "saved") return purgedAt ? note(t("ההקלטה כבר אינה נשמרת (נמחקה לפי מדיניות השמירה)", "The recording is no longer kept (deleted by the retention policy)")) : null;
  if (!me) return null;
  if (!canPlay) return note(t("אין הרשאה להקלטות", "No permission for recordings"));

  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`${base}${base!.includes("?") ? "&" : "?"}download=1`, { credentials: "same-origin" });
      if (!res.ok) { const j = await res.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? t("ההורדה נכשלה", "Download failed")); }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fileName ?? (name ? decodeURIComponent(name) : "recording");
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-2", className)}>
      {play && <audio controls preload="none" src={base} className="h-8 max-w-full w-56" onError={() => toast.error(t("ההקלטה אינה זמינה כרגע", "The recording is unavailable right now"))} />}
      {canDownload
        ? <button type="button" onClick={() => void download()} disabled={busy} className="inline-flex items-center gap-1 text-xs text-accent underline disabled:opacity-50" data-testid="recording-download"><Download size={13} aria-hidden />{busy ? t("מוריד…", "Downloading…") : t("הורד הקלטה", "Download recording")}</button>
        : <span className="text-xs text-muted" title={t("נדרשת הרשאת \"הורדת הקלטות\"", "Requires the \"Download recordings\" permission")}>{t("אין הרשאת הורדה", "No download permission")}</span>}
    </span>
  );
}
