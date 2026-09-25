"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
export function StartConversationButton({ contactId, disabled }: { contactId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [senders, setSenders] = useState<{ id: string; label: string; displayPhoneNumber: string | null; sendingBlocked: boolean }[] | null>(null);
  const [senderId, setSenderId] = useState("");
  const [mock, setMock] = useState(false);
  const [error, setError] = useState(false);
  const router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/whatsapp/senders", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json(); setSenders(data.senders); setSenderId(data.senders.find((sender: { sendingBlocked: boolean }) => !sender.sendingBlocked)?.id ?? ""); setMock(data.mockAvailable);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  async function start() {
    setBusy(true);
    try {
      const response = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId, providerCredentialId: senderId || null }) });
      const data = await response.json();
      if (!response.ok) { toast.error(data.error || "פתיחת השיחה נכשלה"); return; }
      router.push(`/inbox/${data.conversation.id}`);
    } catch { toast.error("פתיחת השיחה נכשלה"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    {senders && senders.length > 0 && <label className="block space-y-1 text-sm">מספר שולח<select aria-label="מספר שולח לשיחה" className="block w-full rounded border p-2" value={senderId} onChange={(event) => setSenderId(event.target.value)}>{senders.map((sender) => <option key={sender.id} value={sender.id} disabled={sender.sendingBlocked}>{sender.label}{sender.displayPhoneNumber ? ` · ${sender.displayPhoneNumber}` : ""}{sender.sendingBlocked ? " — חסום" : ""}</option>)}</select></label>}
    {mock && <p className="text-xs text-muted-foreground">מצב הדגמה — לא נשלחות הודעות WhatsApp.</p>}
    {(error || (senders && !senders.length && !mock)) && <p role="alert" className="text-sm">לא ניתן לבחור מספר שולח. יש לפנות למנהל לבדיקת החיבור והשיוך לצוות.</p>}
    <Button onClick={start} disabled={busy || disabled || !senders || error || (!senderId && !mock)}>{busy ? "פותח..." : "פתח שיחה ושייך לנציג"}</Button>
  </div>;
}
