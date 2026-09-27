"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button, Input, Modal, Select } from "@/components/ui";

type Field = "fullName" | "phone" | "email" | "source" | "product" | "campaign" | "ad" | "notes";
const FIELDS: Array<[Field, string, string[]]> = [
  ["fullName", "שם", ["שם", "שם מלא", "name", "full name", "fullname", "שם הלקוח", "לקוח"]],
  ["phone", "טלפון", ["טלפון", "נייד", "phone", "mobile", "מספר טלפון", "tel", "טל"]],
  ["email", "אימייל", ["אימייל", "מייל", "email", "e-mail", "דואל", "דוא\"ל"]],
  ["source", "מקור", ["מקור", "source", "utm_source"]],
  ["product", "מוצר", ["מוצר", "product"]],
  ["campaign", "קמפיין", ["קמפיין", "campaign", "utm_campaign"]],
  ["ad", "מודעה", ["מודעה", "ad", "ad name"]],
  ["notes", "הערות", ["הערות", "הערה", "notes", "note"]],
];
const CHUNK = 200;

/** Quote-aware CSV / TSV parser (Excel "Save as CSV" with commas inside quoted cells). */
function parseCsv(text: string): string[][] {
  const delim = (text.split(/\r?\n/)[0].match(/\t/g)?.length ?? 0) > (text.split(/\r?\n/)[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === delim) { row.push(cell); cell = ""; } else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** "ייבוא לידים": Excel (.xlsx) or CSV → column mapping → assign to an agent or to the distribution policy → import. */
export function LeadImportModal({ users, onClose, onDone }: { users: Array<{ id: string; fullName: string }>; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<string>("");
  const [table, setTable] = useState<string[][] | null>(null);
  const [map, setMap] = useState<Record<Field, number>>({ fullName: -1, phone: -1, email: -1, source: -1, product: -1, campaign: -1, ad: -1, notes: -1 });
  const [owner, setOwner] = useState("auto");
  const [source, setSource] = useState("ייבוא Excel");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ created: number; exists: number; invalid: number; errors: Array<{ row: number; phone: string; reason: string }> } | null>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    setSummary(null);
    try {
      let rows: string[][];
      if (/\.xlsx$/i.test(f.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        rows = (await readSheet(f)).map((r) => r.map((c) => (c === null || c === undefined ? "" : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
      } else if (/\.(csv|tsv|txt)$/i.test(f.name)) {
        rows = parseCsv(await f.text());
      } else { toast.error("יש לבחור קובץ Excel (.xlsx) או CSV. קובץ .xls ישן – שמור אותו מחדש כ-.xlsx"); return; }
      if (rows.length < 2) { toast.error("הקובץ ריק או שאין בו שורות מתחת לכותרות"); return; }
      const head = rows[0].map((h) => h.trim().toLowerCase());
      const auto = Object.fromEntries(FIELDS.map(([k, , names]) => [k, head.findIndex((h) => names.includes(h))])) as Record<Field, number>;
      if (auto.phone < 0) auto.phone = rows[1].findIndex((c) => /^[+\d][\d\s\-()]{7,}$/.test(c.trim()));
      setMap(auto); setTable(rows); setFile(f.name);
    } catch (e) { toast.error(`לא ניתן לקרוא את הקובץ: ${(e as Error).message}`); }
  }

  const header = table?.[0] ?? [];
  const body = table?.slice(1) ?? [];
  const rowsOut = body.map((r) => Object.fromEntries(FIELDS.map(([k]) => [k, map[k] >= 0 ? (r[map[k]] ?? "").trim() : ""]).filter(([, v]) => v))) as Array<Partial<Record<Field, string>>>;
  const valid = rowsOut.filter((r) => r.phone);

  async function run() {
    const total = valid.length; const acc = { created: 0, exists: 0, invalid: 0, errors: [] as Array<{ row: number; phone: string; reason: string }> };
    setProgress({ done: 0, total });
    try {
      for (let i = 0; i < total; i += CHUNK) {
        const r = await api.post<typeof acc>("/api/leads/import", { rows: valid.slice(i, i + CHUNK).map((x) => ({ ...x, phone: x.phone! })), owner, source: source || undefined, offset: i });
        acc.created += r.created; acc.exists += r.exists; acc.invalid += r.invalid; acc.errors.push(...r.errors);
        setProgress({ done: Math.min(total, i + CHUNK), total });
      }
      setSummary(acc); onDone();
      toast.success(`יובאו ${acc.created} לידים חדשים`);
    } catch (e) { toast.error((e as Error).message); setSummary(acc); } finally { setProgress(null); }
  }
  function downloadErrors() {
    if (!summary?.errors.length) return;
    const csv = ["שורה,טלפון,סיבה", ...summary.errors.map((e) => `${e.row},"${e.phone}","${e.reason.replaceAll('"', '""')}"`)].join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = "import-errors.csv"; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <Modal open onClose={() => !progress && onClose()} title="ייבוא לידים מקובץ" width="max-w-3xl"
      footer={summary ? <Button onClick={onClose}>סגור</Button> : <><Button variant="ghost" onClick={onClose} disabled={Boolean(progress)}>ביטול</Button><Button onClick={run} disabled={!table || map.phone < 0 || !valid.length || Boolean(progress)} loading={Boolean(progress)} data-testid="import-run">ייבא {valid.length ? `${valid.length} לידים` : ""}</Button></>}>
      <div className="space-y-4" data-testid="lead-import">
        <label className="lead-import-drop"><Upload size={20} /><span>{file || "בחר קובץ Excel (.xlsx) או CSV"}</span><input type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={(e) => pick(e.target.files?.[0])} data-testid="import-file" /></label>
        {table && !summary && <>
          <div><div className="text-sm font-medium mb-1">התאמת עמודות</div><div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {FIELDS.map(([k, label]) => <Select key={k} label={`${label}${k === "phone" ? " *" : ""}`} value={String(map[k])} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })} data-testid={`import-map-${k}`}><option value="-1">— לא לייבא —</option>{header.map((h, i) => <option key={i} value={i}>{h || `עמודה ${i + 1}`}</option>)}</Select>)}
          </div></div>
          <div className="grid sm:grid-cols-2 gap-2">
            <Select label="שיוך הלידים" value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="import-owner"><option value="auto">חלוקה אוטומטית (לפי הגדרות חלוקת לידים)</option>{users.map((u) => <option key={u.id} value={u.id}>לנציג: {u.fullName}</option>)}</Select>
            <Input label="מקור (לשורות בלי מקור)" value={source} onChange={(e) => setSource(e.target.value)} />
          </div>
          <div className="text-xs text-muted">{body.length} שורות בקובץ · {valid.length} עם טלפון. איש קשר קיים מזוהה לפי טלפון; אם כבר יש לו ליד פתוח לא ייווצר כפול{owner !== "auto" ? " והוא יועבר לנציג שנבחר" : ""}.</div>
          <div className="overflow-auto max-h-48 border border-line rounded-md"><table className="w-full text-xs"><thead><tr>{FIELDS.filter(([k]) => map[k] >= 0).map(([k, label]) => <th key={k} className="text-start p-1.5 bg-muted-bg">{label}</th>)}</tr></thead><tbody>{rowsOut.slice(0, 5).map((r, i) => <tr key={i} className="border-t border-line">{FIELDS.filter(([k]) => map[k] >= 0).map(([k]) => <td key={k} className="p-1.5">{r[k] ?? ""}</td>)}</tr>)}</tbody></table></div>
        </>}
        {progress && <div className="text-sm" data-testid="import-progress">מייבא… {progress.done}/{progress.total}<div className="h-1.5 bg-muted-bg rounded mt-1"><div className="h-1.5 bg-accent rounded" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div></div>}
        {summary && <div className="rounded-lg border border-line p-3 text-sm" data-testid="import-summary"><div>נוצרו <b>{summary.created}</b> לידים חדשים · <b>{summary.exists}</b> כבר היו קיימים · <b>{summary.invalid}</b> שורות לא תקינות</div>{summary.errors.length > 0 && <button className="lead-link mt-1" onClick={downloadErrors}>הורד קובץ שגיאות</button>}</div>}
      </div>
    </Modal>
  );
}
