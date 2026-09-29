"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Input, Panel } from "@/components/ui";
import type { QuoteLine } from "@/server/sales/quotes";
type Quote = {
  title: string;
  businessName: string;
  revision: number;
  currency: string;
  lines: QuoteLine[];
  subtotal: number;
  tax: number;
  total: number;
  terms: string;
  expiresAt: string;
  status: string;
  payment: { message: string };
};
export function PublicOffer({ token }: { token: string }) {
  const [q, setQ] = useState<Quote | null>(null),
    [error, setError] = useState(""),
    [name, setName] = useState(""),
    [agree, setAgree] = useState(false),
    [role, setRole] = useState("buyer"),
    [busy, setBusy] = useState(false);
  const load = () =>
    api
      .get<Quote>(`/api/offer/${token}`)
      .then(setQ)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, [token]);
  const money = (n: number) =>
    new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: q?.currency ?? "ILS",
    }).format(n / 100);
  return (
    <main
      dir="rtl"
      className="max-w-2xl mx-auto p-5 space-y-5"
      data-testid="public-offer"
    >
      <h1 className="text-2xl font-bold">{q?.businessName ?? "הצעת מחיר"}</h1>
      {error && <p role="alert">{error}</p>}
      {q && (
        <>
          <Panel title={q.title}>
            <p>
              גרסה {q.revision} · בתוקף עד{" "}
              {new Date(q.expiresAt).toLocaleDateString("he-IL")}
            </p>
            <ul className="divide-y">
              {q.lines.map((l, i) => (
                <li key={i} className="py-3">
                  <b>{l.name}</b>
                  <p>{l.description}</p>
                  <p>
                    {l.quantity} × {money(l.unitAmount)} · הנחה{" "}
                    {l.discountBps / 100}%
                  </p>
                  <b>{money(l.total)}</b>
                </li>
              ))}
            </ul>
            <p>
              לפני מס: {money(q.subtotal)} · מס: {money(q.tax)}
            </p>
            <strong className="text-xl">סה״כ: {money(q.total)}</strong>
            <p className="whitespace-pre-wrap mt-3">{q.terms}</p>
          </Panel>
          <Panel title="אישור ההצעה">
            {q.status === "accepted" ? (
              <p data-testid="offer-accepted">ההצעה אושרה. אישור אינו תשלום.</p>
            ) : (
              <div className="space-y-3">
                <Input
                  label="שם המאשר"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <label>
                  תפקיד באישור{" "}
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="buyer">לקוח</option>
                    <option value="decision_maker">
                      מקבל החלטה מטעם הלקוח
                    </option>
                  </select>
                </label>
                <label className="block">
                  <input
                    type="checkbox"
                    checked={agree}
                    onChange={(e) => setAgree(e.target.checked)}
                  />{" "}
                  קראתי ואני מאשר/ת את גרסה {q.revision}, המחיר והתנאים. אני
                  מוסמך/ת לאשר בשם הלקוח.
                </label>
                <p className="text-xs text-muted">
                  זהו אישור מקוון בשם שהוזן, ללא אימות זהות או חתימה דיגיטלית
                  מאומתת.
                </p>
                <Button
                  loading={busy}
                  disabled={!agree || name.trim().length < 2}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await api.post(`/api/offer/${token}`, {
                        name,
                        agree,
                        revision: q.revision,
                        role,
                      });
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  data-testid="offer-accept"
                >
                  אישור ההצעה
                </Button>
              </div>
            )}
            <p className="mt-3 text-muted">{q.payment.message}</p>
          </Panel>
          <Panel title="שותף לקבלת ההחלטה">
            <p>
              אפשר לשתף את ההצעה עם מי שמסייע לך בהחלטה, בהסכמתך. כל מי שמחזיק
              בקישור יכול לקרוא ולאשר אותה; ההצעה אינה כוללת הערות פנימיות.
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                navigator.clipboard.writeText(window.location.href)
              }
            >
              העתקת קישור לשיתוף
            </Button>
          </Panel>
        </>
      )}
    </main>
  );
}
