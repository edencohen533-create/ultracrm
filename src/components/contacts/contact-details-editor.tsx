"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type Contact = { id: string; name: string; email: string | null; source: string | null; customFields: { key: string; value: string }[]; tags: { tag: { id: string } }[] };
export function ContactDetailsEditor({ contact, tags }: { contact: Contact; tags: { id: string; name: string }[] }) {
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email ?? "");
  const [source, setSource] = useState(contact.source ?? "");
  const [fields, setFields] = useState(contact.customFields.map(({ key, value }) => ({ key, value })));
  const [selected, setSelected] = useState(contact.tags.map(({ tag }) => tag.id));
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return <details className="rounded border p-3"><summary className="cursor-pointer">עריכת פרטי לקוח, תגיות ושדות מותאמים</summary>
    <form className="mt-3 space-y-3" onSubmit={async (event) => {
      event.preventDefault(); if (busy) return; setBusy(true);
      try {
        const response = await fetch(`/api/contacts/${contact.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, source, customFields: fields, tagIds: selected }) });
        if (!response.ok) throw new Error();
        toast.success("כרטיס הלקוח עודכן"); router.refresh();
      } catch { toast.error("השמירה נכשלה. יש לבדוק אימייל, שמות שדות ייחודיים וחיבור לרשת"); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block">שם<Input value={name} required maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block">אימייל<Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="block">מקור ליד<Input value={source} maxLength={200} onChange={(e) => setSource(e.target.value)} /></label>
        <div className="flex flex-wrap gap-3">{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={selected.includes(tag.id)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, tag.id] : current.filter((id) => id !== tag.id))} /> {tag.name}</label>)}</div>
        {fields.map((field, index) => <div key={index} className="flex gap-2">
          <Input aria-label={`שם שדה ${index + 1}`} value={field.key} required maxLength={100} onChange={(e) => setFields((current) => current.map((f, i) => i === index ? { ...f, key: e.target.value } : f))} />
          <Input aria-label={`ערך שדה ${index + 1}`} value={field.value} maxLength={2000} onChange={(e) => setFields((current) => current.map((f, i) => i === index ? { ...f, value: e.target.value } : f))} />
          <Button type="button" variant="outline" aria-label={`הסר שדה ${index + 1}`} onClick={() => setFields((current) => current.filter((_, i) => i !== index))}>הסר</Button>
        </div>)}
        <Button type="button" variant="outline" disabled={fields.length >= 50} onClick={() => setFields((current) => [...current, { key: "", value: "" }])}>הוסף שדה</Button>
        <Button type="submit" className="ms-2">{busy ? "שומר…" : "שמור פרטי לקוח"}</Button>
      </fieldset>
    </form>
  </details>;
}
