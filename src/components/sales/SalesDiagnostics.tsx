"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Panel, Button } from "@/components/ui";
type Data = {
  rows: Array<{
    dimension: string;
    label: string;
    current: { attempts: number; failedBeforeDial: number };
    previous: { attempts: number };
    currentRate: number | null;
    previousRate: number | null;
    drop: boolean;
    sufficientSample: boolean;
  }>;
  sla: Array<{ status: string; count: number; met: number }>;
  definitions: Record<string, string>;
  timezone: string;
};
const rate = (n: number | null) =>
  n === null ? "—" : `${Math.round(n * 100)}%`;
export function SalesDiagnostics() {
  const [d, setD] = useState<Data | null>(null),
    [err, setErr] = useState("");
  const load = () =>
    api
      .get<Data>("/api/sales/diagnostics")
      .then((r) => {
        setD(r);
        setErr("");
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Panel title="אבחון ירידה במענה ועמידה ביעד חיוג">
      <Button size="sm" variant="ghost" onClick={load}>
        רענן אבחון
      </Button>
      {err && <p role="alert">{err}</p>}
      {d && (
        <>
          <p className="text-xs">
            {d.definitions.period} · שעות לפי {d.timezone}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {[
                    "חתך",
                    "ערך",
                    "ניסיונות כעת / קודם",
                    "מענה כעת / קודם",
                    "כשל לפני חיוג כעת",
                    "אבחון",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.dimension + ":" + r.label}>
                    <td>
                      {
                        {
                          caller: "מספר יוצא",
                          source: "מקור ליד",
                          hour: "שעה",
                        }[r.dimension]
                      }
                    </td>
                    <td dir="auto">{r.label}</td>
                    <td>
                      {r.current.attempts} / {r.previous.attempts}
                    </td>
                    <td>
                      {rate(r.currentRate)} / {rate(r.previousRate)}
                    </td>
                    <td>{r.current.failedBeforeDial}</td>
                    <td>
                      {r.drop
                        ? "ירידה — בדוק מספר, מקור ותמהיל לידים"
                        : r.sufficientSample
                          ? "אין ירידה מעל הסף"
                          : "אין מספיק ניסיונות להשוואה"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!d.rows.length && <p>אין שיחות שהסתיימו בתקופה זו.</p>}
          <p className="text-xs text-muted">
            {d.definitions.rate} {d.definitions.alert} {d.definitions.source}{" "}
            {d.definitions.reputation}
          </p>
          <h4 className="mt-3 font-semibold">
            יעדי חיוג שנפתחו ב־14 הימים האחרונים
          </h4>
          {d.sla.map((s) => (
            <p key={s.status}>
              {{
                monitoring: "במעקב",
                needs_attention: "חריגה ללא חיוג",
                completed: "חיוג נמדד",
                cancelled: "מדידה בוטלה",
              }[s.status] ?? s.status}
              : {s.count}
              {s.status === "completed" ? ` · עמדו ביעד: ${s.met}` : ""}
            </p>
          ))}
        </>
      )}
    </Panel>
  );
}
