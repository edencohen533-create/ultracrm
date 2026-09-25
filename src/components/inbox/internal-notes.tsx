"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Note = { id: string; body: string; createdAt: string; author: { name?: string; fullName?: string } };
export function InternalNotes({ conversationId, notes }: { conversationId: string; notes: Note[] }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return <details className="max-h-64 overflow-y-auto border-b bg-amber-50 p-2 text-sm dark:bg-amber-950">
    <summary className="cursor-pointer font-medium">הערות פנימיות לצוות ({notes.length}) — אינן נשלחות ללקוח</summary>
    <div className="my-2 space-y-2">{notes.map((note) => <article key={note.id} className="rounded border p-2">
      <p className="text-xs">{note.author.fullName ?? note.author.name} · {new Date(note.createdAt).toLocaleString("he-IL")}</p>
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
    </article>)}</div>
    <form className="flex items-end gap-2" onSubmit={async (event) => {
      event.preventDefault(); if (busy || !body.trim()) return;
      setBusy(true);
      try {
        const response = await fetch(`/api/conversations/${conversationId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
        if (!response.ok) throw new Error();
        setBody(""); router.refresh(); toast.success("ההערה נשמרה לצוות");
      } catch { toast.error("ההערה לא נשמרה. הטקסט נשאר לניסיון נוסף"); }
      finally { setBusy(false); }
    }}><Textarea aria-label="הערה פנימית לצוות" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4096} disabled={busy} /><Button type="submit" disabled={busy || !body.trim()}>שמור הערה</Button></form>
  </details>;
}
