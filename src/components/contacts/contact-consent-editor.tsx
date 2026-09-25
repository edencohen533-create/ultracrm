"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
export function ContactConsentEditor({ contactId, initialStatus, initialBlocked = false }: { contactId: string; initialStatus: string; initialBlocked?: boolean }) {
  const [status, setStatus] = useState(initialStatus), [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(initialBlocked);
  const [evidence, setEvidence] = useState("");
  const router = useRouter();
  return <div className="flex flex-wrap items-end gap-2"><label className="text-sm">הסכמה לדיוור<select aria-label="עדכון הסכמה לדיוור" className="mt-1 block rounded border p-2" value={status} onChange={(event) => setStatus(event.target.value)}><option value="UNKNOWN">לא ידוע</option><option value="OPTED_IN">קיימת הסכמה לקבלת דיוור</option><option value="OPTED_OUT">הוסר מדיוור שיווקי</option></select></label>
    <label className="text-sm"><input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} /> חסימה מלאה (גם שירות)</label>
    <label className="text-sm">אסמכתה להסכמה<input aria-label="אסמכתה להסכמה" className="block rounded border p-2" value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={1000} /></label>
    <Button variant="outline" disabled={busy || (status === initialStatus && blocked === initialBlocked && !evidence)} onClick={async () => {
      setBusy(true);
      try {
        const response = await fetch(`/api/contacts/${contactId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isBlocked: blocked, ...((status !== initialStatus || evidence) ? { consentStatus: status, consentEvidence: evidence, consentSource: "manual" } : {}) }) });
        if (!response.ok) throw new Error();
        toast.success("ההסכמה עודכנה"); router.refresh();
      } catch { toast.error("לא ניתן לעדכן הסכמה"); } finally { setBusy(false); }
    }}>שמור הסכמה</Button><p className="w-full text-xs text-muted-foreground">יש לסמן הסכמה רק אם הלקוח נתן אותה. בקשת הסרה בוואטסאפ מעדכנת את הסטטוס אוטומטית. מענה שירות אפשרי בחלון פעיל; חסימה מלאה מונעת כל שליחה.</p>
  </div>;
}
