"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function TeamManager() {
  const router = useRouter();
  const [name, setName] = useState(""); const [busy, setBusy] = useState(false);
  return <form className="my-4 flex max-w-md gap-2" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true);
    try { const res = await fetch("/api/settings/teams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); if (!res.ok) throw new Error(); setName(""); router.refresh(); toast.success("הצוות נוצר"); } catch { toast.error("לא ניתן ליצור צוות כרגע"); } finally { setBusy(false); }
  }}><Input aria-label="שם צוות חדש" placeholder="שם צוות חדש" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /><Button type="submit" disabled={busy || !name.trim()}>צור צוות</Button></form>;
}
