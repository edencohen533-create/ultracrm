"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, EmptyState, Input, Modal, Phone, Select, Spinner, Textarea } from "@/components/ui";
import { formatPhone, relativeTime } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";

interface Row {
  id: string;
  fullName: string;
  phoneE164: string;
  company: string | null;
  city: string | null;
  source: string | null;
  createdAt: string;
  isDnc: boolean;
  owner: { fullName: string } | null;
  _count: { calls: number };
  lastCall: { createdAt: string; outcome: string | null } | null;
}

export default function ContactsPage() {
  const { dial, state } = useDialer();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ q: "", source: "", city: "", neverCalled: "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", company: "", city: "", source: "", notes: "" });
  const [csv, setCsv] = useState("");
  const [listName, setListName] = useState("");
  const [me, setMe] = useState<{ role: string } | null>(null);

  useEffect(() => {
    api.get<{ user: { role: string } }>("/api/auth/me").then((m) => setMe(m.user)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ items: Row[]; total: number }>(`/api/contacts${qs({ ...filter, page, limit: 30 })}`);
      setRows(r.items);
      setTotal(r.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, page]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function create() {
    try {
      await api.post("/api/contacts", form);
      toast.success("איש הקשר נוצר");
      setCreateOpen(false);
      setForm({ fullName: "", phone: "", email: "", company: "", city: "", source: "", notes: "" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function importCsv() {
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const header = lines[0].split(/[,\t]/).map((h) => h.trim().toLowerCase());
    const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
    const iName = idx(["name", "fullname", "שם", "שם מלא"]);
    const iPhone = idx(["phone", "טלפון", "mobile", "נייד"]);
    if (iName < 0 || iPhone < 0) return toast.error("נדרשות עמודות שם וטלפון בשורה הראשונה");
    const iEmail = idx(["email", "אימייל"]), iCompany = idx(["company", "חברה"]), iCity = idx(["city", "עיר"]), iSource = idx(["source", "מקור"]);
    const rowsIn = lines.slice(1).map((l) => {
      const c = l.split(/[,\t]/).map((x) => x.trim());
      return { fullName: c[iName] ?? "", phone: c[iPhone] ?? "", email: iEmail >= 0 ? c[iEmail] : undefined, company: iCompany >= 0 ? c[iCompany] : undefined, city: iCity >= 0 ? c[iCity] : undefined, source: iSource >= 0 ? c[iSource] : undefined };
    }).filter((r) => r.fullName && r.phone);
    try {
      const r = await api.post<{ created: number; updated: number; invalid: number; errors: Array<{ row: number; phone: string; reason: string }> }>("/api/contacts/import", { rows: rowsIn, source: "csv" });
      toast.success(`נוצרו ${r.created}, עודכנו ${r.updated}, לא תקינים ${r.invalid}`);
      if (r.errors?.length) toast.error(`שגיאות: ${r.errors.slice(0, 5).map((e) => `שורה ${e.row + 1} (${e.phone}): ${e.reason}`).join(" · ")}${r.errors.length > 5 ? ` ועוד ${r.errors.length - 5}` : ""}`, { duration: 15000 });
      setImportOpen(false);
      setCsv("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function createListFromFilter() {
    try {
      const r = await api.post<{ id: string; added: number }>("/api/lists", { name: listName, filter: { ...filter, neverCalled: filter.neverCalled || undefined } });
      toast.success(`הרשימה נוצרה עם ${r.added} לידים`);
      setListOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const canDial = !state?.activeCall && !state?.wrapUpCall;
  const isManager = me?.role === "manager" || me?.role === "admin";

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">אנשי קשר</h1>
        <span className="text-xs text-muted tabular">{total} רשומות</span>
        <div className="ms-auto flex gap-2">
          {isManager && <Button variant="secondary" size="sm" onClick={() => { setListName(`רשימה מסינון · ${new Date().toLocaleDateString("he-IL")}`); setListOpen(true); }}>צור רשימת חיוג מהסינון</Button>}
          {isManager && <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>ייבוא CSV</Button>}
          <Button size="sm" onClick={() => setCreateOpen(true)}>+ איש קשר</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Input placeholder="חיפוש שם / טלפון / חברה" value={filter.q} onChange={(e) => { setFilter({ ...filter, q: e.target.value }); setPage(1); }} className="md:col-span-2" />
        <Input placeholder="מקור" value={filter.source} onChange={(e) => { setFilter({ ...filter, source: e.target.value }); setPage(1); }} />
        <Input placeholder="עיר" value={filter.city} onChange={(e) => { setFilter({ ...filter, city: e.target.value }); setPage(1); }} />
        <Select value={filter.neverCalled} onChange={(e) => { setFilter({ ...filter, neverCalled: e.target.value }); setPage(1); }}>
          <option value="">כולם</option>
          <option value="true">טרם חויגו</option>
        </Select>
      </div>

      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        {loading && rows.length === 0 ? (
          <div className="flex justify-center p-10"><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="לא נמצאו אנשי קשר" hint="שנה את הסינון או הוסף אנשי קשר חדשים" />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-white/3">
              <tr>
                <th className="text-start px-3 h-9 font-medium">שם</th>
                <th className="text-start px-3 font-medium">טלפון</th>
                <th className="text-start px-3 font-medium">חברה / עיר</th>
                <th className="text-start px-3 font-medium">מקור</th>
                <th className="text-start px-3 font-medium">שיחות</th>
                <th className="text-start px-3 font-medium">שיחה אחרונה</th>
                <th className="px-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-white/3">
                  <td className="px-3 h-11">
                    <Link href={`/contacts/${r.id}`} className="font-medium hover:underline">{r.fullName}</Link>
                    {r.isDnc && <Badge tone="bad" className="ms-2">DNC</Badge>}
                  </td>
                  <td className="px-3"><Phone value={formatPhone(r.phoneE164)} /></td>
                  <td className="px-3 text-muted">{[r.company, r.city].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="px-3 text-muted">{r.source ?? "—"}</td>
                  <td className="px-3 tabular">{r._count.calls}</td>
                  <td className="px-3 text-muted text-xs">{r.lastCall ? `${relativeTime(r.lastCall.createdAt)} · ${OUTCOMES.find((o) => o.key === r.lastCall?.outcome)?.label ?? "ללא תוצאה"}` : "—"}</td>
                  <td className="px-3 text-end">
                    <Button size="sm" variant="good" disabled={!canDial || r.isDnc} onClick={() => dial({ mode: "manual", contactId: r.id })}>חייג</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-center justify-between px-3 h-10 border-t border-line text-xs text-muted">
          <span>עמוד {page}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-30">‹ הקודם</button>
            <button disabled={page * 30 >= total} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-30">הבא ›</button>
          </div>
        </div>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="איש קשר חדש" footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>ביטול</Button><Button onClick={create} disabled={!form.fullName || !form.phone}>שמור</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Input label="שם מלא" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className="col-span-2" />
          <Input label="טלפון" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} ltr inputMode="tel" />
          <Input label="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} ltr />
          <Input label="חברה" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <Input label="עיר" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          <Input label="מקור" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="col-span-2" />
          <Textarea label="הערות" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="col-span-2" />
        </div>
      </Modal>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="ייבוא אנשי קשר (CSV)" footer={<><Button variant="ghost" onClick={() => setImportOpen(false)}>ביטול</Button><Button onClick={importCsv} disabled={!csv.trim()}>ייבא</Button></>}>
        <p className="text-xs text-muted mb-2">הדבק CSV עם שורת כותרת. עמודות נתמכות: name/שם, phone/טלפון, email, company/חברה, city/עיר, source/מקור. כפילויות לפי מספר מנורמל ימוזגו.</p>
        <Textarea rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"שם,טלפון,מקור\nישראל ישראלי,0501234567,facebook"} className="font-mono text-xs" />
      </Modal>

      <Modal open={listOpen} onClose={() => setListOpen(false)} title="רשימת חיוג חדשה מהסינון הנוכחי" footer={<><Button variant="ghost" onClick={() => setListOpen(false)}>ביטול</Button><Button onClick={createListFromFilter} disabled={!listName.trim()}>צור רשימה</Button></>}>
        <Input label="שם הרשימה" value={listName} onChange={(e) => setListName(e.target.value)} />
        <p className="text-xs text-muted mt-2">הסינון יישמר על הרשימה. מספרים חסומים (DNC) לא ייכללו, וכפילויות לפי מספר מנורמל יסוננו.</p>
      </Modal>
    </div>
  );
}
