"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useT } from "@/components/i18n/LangProvider";

type Note = { id: string; body: string; createdAt: string; author: { name?: string; fullName?: string } };
export function InternalNotes({ conversationId, notes }: { conversationId: string; notes: Note[] }) {
  const t = useT();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return <details className="max-h-64 overflow-y-auto border-b bg-amber-50 p-2 text-sm dark:bg-amber-950">
    <summary className="cursor-pointer font-medium">{t(`הערות פנימיות לצוות (${notes.length}) — אינן נשלחות ללקוח`, `Internal team notes (${notes.length}) — not sent to the customer`)}</summary>
    <div className="my-2 space-y-2">{notes.map((note) => <article key={note.id} className="rounded border p-2">
      <p className="text-xs">{note.author.fullName ?? note.author.name} · {new Date(note.createdAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL")}</p>
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
    </article>)}</div>
    <form className="flex items-end gap-2" onSubmit={async (event) => {
      event.preventDefault(); if (busy || !body.trim()) return;
      setBusy(true);
      try {
        const response = await fetch(`/api/conversations/${conversationId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
        if (!response.ok) throw new Error();
        setBody(""); router.refresh(); toast.success(t("ההערה נשמרה לצוות", "Note saved for the team"));
      } catch { toast.error(t("ההערה לא נשמרה. הטקסט נשאר לניסיון נוסף", "The note wasn't saved. Your text is kept so you can try again")); }
      finally { setBusy(false); }
    }}><Textarea aria-label={t("הערה פנימית לצוות", "Internal team note")} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4096} disabled={busy} /><Button type="submit" disabled={busy || !body.trim()}>{t("שמור הערה", "Save note")}</Button></form>
  </details>;
}
