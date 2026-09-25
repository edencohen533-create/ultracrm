import { format } from "date-fns";
import { Check, CheckCheck, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Ltr } from "@/components/shared/ltr";
import type { MessageItem } from "@/types/domain";

const STATUS_ICON: Record<MessageItem["status"], React.ReactNode> = {
  ACCEPTED: <span title="התקבל אצל הספק; ממתין לאירוע שליחה">נקלט</span>,
  UNKNOWN: <span title="תוצאה לא ודאית — יש לבדוק לפני ניסיון נוסף">?</span>,
  QUEUED: <Clock className="h-3 w-3" />,
  SENT: <Check className="h-3 w-3" />,
  DELIVERED: <CheckCheck className="h-3 w-3" />,
  READ: <CheckCheck className="h-3 w-3 text-blue-500" />,
  FAILED: <span className="text-destructive">!</span>,
  BOUNCED: <span className="text-destructive" title="האימייל הוקפץ (bounce)">↩</span>,
  CANCELLED: <span className="text-muted-foreground" title="בוטל לפני העברה לספק">✕</span>,
};

export function MessageBubble({ message }: { message: MessageItem }) {
  const isOutbound = message.direction === "OUTBOUND";

  return (
    <div className={cn("flex", isOutbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm",
          isOutbound ? "bg-primary text-primary-foreground" : "bg-muted"
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        {message.attachments?.map((attachment) => {
          const safeUrl = attachment.url.startsWith("/api/attachments/") || attachment.url.startsWith("https://") ? attachment.url : null;
          if (!safeUrl) return null;
          return <div key={attachment.id} className="mt-2 max-w-sm">
            {attachment.mimeType.startsWith("image/") ?
              // Authenticated media requires the browser's session cookie, so use a direct image element.
              // eslint-disable-next-line @next/next/no-img-element
              <a href={safeUrl} target="_blank" rel="noreferrer"><img src={safeUrl} alt={attachment.fileName ?? "תמונה מצורפת"} className="max-h-72 rounded object-contain" loading="lazy" /></a>
              : attachment.mimeType.startsWith("audio/") ? <audio src={safeUrl} controls preload="none" aria-label={attachment.fileName ?? "הודעה קולית"} />
              : attachment.mimeType.startsWith("video/") ? <video src={safeUrl} controls preload="metadata" className="max-h-72 rounded" aria-label={attachment.fileName ?? "סרטון מצורף"} />
              : <a href={safeUrl} target="_blank" rel="noreferrer" className="underline">הורדת {attachment.fileName ?? "קובץ מצורף"}</a>}
          </div>;
        })}
        <div className={cn("mt-1 flex items-center gap-1 text-[10px] opacity-70", isOutbound ? "justify-start" : "justify-end")}>
          <Ltr>{format(new Date(message.createdAt), "HH:mm")}</Ltr>
          {isOutbound && STATUS_ICON[message.status]}
        </div>
      </div>
    </div>
  );
}

export function InternalNoteBubble({ body, authorName, createdAt }: { body: string; authorName: string; createdAt: string }) {
  return (
    <div className="flex justify-center">
      <div className="max-w-[80%] rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <div className="mb-0.5 font-medium">הערה פנימית · {authorName}</div>
        <p className="whitespace-pre-wrap break-words">{body}</p>
        <Ltr className="mt-1 block opacity-70">{format(new Date(createdAt), "HH:mm")}</Ltr>
      </div>
    </div>
  );
}
