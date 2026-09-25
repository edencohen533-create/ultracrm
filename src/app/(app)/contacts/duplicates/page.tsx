"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Panel, Phone, Spinner } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";

interface Group { reason: string; key: string; contacts: Array<{ id: string; fullName: string; phoneE164: string; email: string | null; createdAt: string }> }

export default function DuplicatesPage() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [primary, setPrimary] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const load = () => api.get<{ groups: Group[] }>("/api/contacts/duplicates").then((r) => setGroups(r.groups)).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);
  async function merge(g: Group) {
    const keep = primary[g.key] ?? g.contacts[0].id;
    const others = g.contacts.filter((c) => c.id !== keep);
    if (!confirm(`למזג ${others.length} אנשי קשר לתוך "${g.contacts.find((c) => c.id === keep)?.fullName}"? כל השיחות, הלידים, העסקאות, המשימות, הקמפיינים וההסרות יועברו; הסכמה מחמירה נשמרת. הפעולה אינה הפיכה.`)) return;
    setBusy(true);
    try { for (const o of others) await api.post(`/api/contacts/${keep}/merge`, { duplicateId: o.id }); toast.success("המיזוג הושלם – ההיסטוריה נשמרה על הכרטיס הראשי"); await load(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="p-5 space-y-4 max-w-5xl">
      <div className="flex items-center gap-3"><h1 className="text-lg font-semibold">כפילויות אפשריות</h1><Link href="/contacts" className="text-xs text-muted hover:text-text ms-auto">חזרה לאנשי קשר</Link></div>
      <p className="text-xs text-muted">מספר טלפון מנורמל הוא ייחודי לכל עסק, ולכן כפילויות לפי טלפון נחסמות ביצירה. כאן מוצגים אנשי קשר עם אותו אימייל או אותו שם. שום דבר לא ממוזג אוטומטית – שם זהה אינו הוכחה שמדובר באותו אדם.</p>
      {!groups ? <div className="flex justify-center p-10"><Spinner /></div> : groups.length === 0 ? <EmptyState title="לא נמצאו כפילויות" /> : groups.map((g) => (
        <Panel key={g.reason + g.key} title={<span>{g.reason} · <span className="ltr inline-block">{g.key}</span></span>} bodyClassName="p-0">
          <ul className="divide-y divide-line text-sm">
            {g.contacts.map((c) => <li key={c.id} className="px-4 py-2 flex items-center gap-3"><label className="flex items-center gap-1 text-xs text-muted"><input type="radio" name={`primary-${g.key}`} checked={(primary[g.key] ?? g.contacts[0].id) === c.id} onChange={() => setPrimary({ ...primary, [g.key]: c.id })} />ראשי</label><Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link><Phone value={formatPhone(c.phoneE164)} className="text-muted" /><span className="text-muted ltr">{c.email ?? ""}</span><Badge tone="neutral" className="ms-auto">{formatDateTime(c.createdAt)}</Badge></li>)}
          </ul>
          <div className="px-4 py-2 border-t border-line flex items-center gap-2 text-xs text-muted"><span>בחר את הכרטיס שיישאר; השאר ימוזגו לתוכו.</span><Button size="sm" variant="secondary" className="ms-auto" disabled={busy} onClick={() => merge(g)} data-testid="merge-group">מזג לכרטיס הראשי</Button></div>
        </Panel>
      ))}
    </div>
  );
}
