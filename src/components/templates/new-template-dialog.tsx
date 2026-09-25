"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { templateParameterKeys } from "@/lib/campaigns";

export function NewTemplateDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [language, setLanguage] = useState("he");
  const [category, setCategory] = useState("UTILITY");
  const [examples, setExamples] = useState<Record<string, string>>({});
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const res = await fetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, body, language, category, examples }) });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "ההגשה נכשלה"); router.refresh(); return; }
      toast.success("התבנית הוגשה ל־Meta. סטטוס האישור יופיע לאחר סנכרון");
      setOpen(false); setName(""); setBody(""); setExamples({}); router.refresh();
    } catch { toast.error("לא ניתן לאמת את ההגשה. יש לסנכרן לפני ניסיון נוסף"); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
    <DialogTrigger render={<Button />}>תבנית חדשה לאישור</DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>הגשת תבנית לאישור Meta</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted-foreground">נדרש חשבון Meta מחובר. ניתן לשלוח ללקוחות רק לאחר אישור התבנית. כאן ניתן להגיש תבניות טקסט לשיווק ולשירות.</p>
        <label className="block space-y-1">שם התבנית<Input aria-label="שם התבנית" dir="ltr" required pattern="[a-z0-9_]+" maxLength={512} value={name} onChange={(e) => setName(e.target.value)} placeholder="welcome_message" /></label>
        <div className="flex gap-4">
          <label>שפה<select aria-label="שפת התבנית" className="block rounded border p-2" value={language} onChange={(e) => setLanguage(e.target.value)}>{Object.entries({ he: "עברית", en_US: "אנגלית", ar: "ערבית", ru: "רוסית", es: "ספרדית", fr: "צרפתית" }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>קטגוריה<select aria-label="קטגוריית התבנית" className="block rounded border p-2" value={category} onChange={(e) => setCategory(e.target.value)}><option value="UTILITY">שירות</option><option value="MARKETING">שיווק</option></select></label>
        </div>
        <label className="block space-y-1">תוכן ההודעה<Textarea aria-label="תוכן התבנית" required maxLength={1024} value={body} onChange={(e) => setBody(e.target.value)} placeholder="שלום {{1}}, תודה שפנית אלינו." /></label>
        <p className="text-xs text-muted-foreground">משתנים ממוספרים ברצף: {"{{1}}, {{2}}"}. יש לספק דוגמאות פיקטיביות לבדיקת Meta.</p>
        {templateParameterKeys(body).map((key) => <label key={key} className="block">דוגמה למשתנה {key}<Input aria-label={`דוגמה למשתנה ${key}`} required maxLength={200} value={examples[key] ?? ""} onChange={(e) => setExamples({ ...examples, [key]: e.target.value })} /></label>)}
        <Button type="submit" disabled={busy}>{busy ? "מגיש..." : "הגש לאישור Meta"}</Button>
      </form>
    </DialogContent>
  </Dialog>;
}
