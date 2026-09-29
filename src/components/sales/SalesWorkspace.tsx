"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Input, Panel, Textarea } from "@/components/ui";
import { MetaAdSettings } from "./MetaAdSettings";
import { toast } from "sonner";
type Offer = {
  id: string;
  name: string;
  description: string;
  currency: string;
  unitCost?: number | null;
  unitAmount: number;
  taxBps: number;
  maxDiscountBps: number;
  active: boolean;
};
type Quote = {
  costTotal?: number | null;
  margin?: number | null;
  lines: Array<{ offerId: string; quantity: number; discountBps: number }>;
  terms: string;
  id: string;
  leadId: string;
  title: string;
  revision: number;
  currency: string;
  total: number;
  status: string;
  expiresAt: string;
  viewedAt: string | null;
  acceptedAt: string | null;
  lead: { contact: { fullName: string } };
};
type Data = {
  offers: Offer[];
  quotes: Quote[];
  canManage: boolean;
  payments: { message: string };
};
const states: Record<string, string> = {
  approved: "מוכן לשיתוף",
  pending_approval: "ממתין לאישור הנחה",
  shared: "שותף",
  accepted: "אושר על ידי הלקוח",
  revoked: "בוטל",
};
export function SalesWorkspace({ initialLeadId }: { initialLeadId: string }) {
  const [leadId, setLeadId] = useState(initialLeadId),
    [d, setD] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [leads, setLeads] = useState<
      Array<{ id: string; contact: { fullName: string } }>
    >([]);
  const [offerName, setOfferName] = useState(""),
    [price, setPrice] = useState(""),
    [cost, setCost] = useState(""),
    [tax, setTax] = useState("0"),
    [maxDiscount, setMaxDiscount] = useState("0"),
    [currency, setCurrency] = useState("ILS");
  const [title, setTitle] = useState("הצעת מחיר"),
    [terms, setTerms] = useState(""),
    [days, setDays] = useState(7),
    [previousId, setPreviousId] = useState<string | undefined>(),
    [lines, setLines] = useState([
      { offerId: "", quantity: 1, discountBps: 0 },
    ]),
    [sharePath, setSharePath] = useState("");
  const load = useCallback(async () => {
    try {
      setD(
        await api.get<Data>(
          "/api/sales" +
            (leadId ? "?leadId=" + encodeURIComponent(leadId) : ""),
        ),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [leadId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api
      .get<{ items: Array<{ id: string; contact: { fullName: string } }> }>(
        "/api/leads?limit=100",
      )
      .then((r) => setLeads(r.items))
      .catch(() => {});
  }, []);
  const action = async (body: unknown) => {
    setBusy(true);
    try {
      const r = await api.post<{ path?: string }>("/api/sales", body);
      if (r.path) setSharePath(r.path);
      await load();
      toast.success("נשמר");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <main
      className="p-5 space-y-5 max-w-5xl mx-auto"
      dir="rtl"
      data-testid="sales-workspace"
    >
      <h1 className="text-2xl font-bold">הצעות וסגירה</h1>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {d && (
        <>
          <MetaAdSettings />
          <p>{d.payments.message}</p>
          {d.canManage && (
            <Panel title="קטלוג מאושר">
              <div className="grid sm:grid-cols-3 gap-3">
                <Input
                  label="שם מוצר או חבילה"
                  value={offerName}
                  onChange={(e) => setOfferName(e.target.value)}
                />
                <Input
                  label="מחיר יחידה לפני מס"
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
                <Input
                  label="עלות יחידה לפני מס (למנהלים בלבד, לא חובה)"
                  type="number"
                  min="0"
                  step="0.01"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
                <label>
                  מטבע
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    {["ILS", "USD", "EUR"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <Input
                  label="מס (%)"
                  type="number"
                  min="0"
                  max="100"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                />
                <Input
                  label="הנחה מותרת ללא אישור נוסף (%)"
                  type="number"
                  min="0"
                  max="100"
                  value={maxDiscount}
                  onChange={(e) => setMaxDiscount(e.target.value)}
                />
                <Button
                  loading={busy}
                  disabled={price === "" || offerName.trim().length < 2}
                  onClick={() =>
                    action({
                      action: "offer",
                      data: {
                        name: offerName,
                        currency,
                        unitAmount: Math.round(Number(price) * 100),
                        unitCost:
                          cost === "" ? null : Math.round(Number(cost) * 100),
                        taxBps: Math.round(Number(tax) * 100),
                        maxDiscountBps: Math.round(Number(maxDiscount) * 100),
                      },
                    })
                  }
                  data-testid="offer-create"
                >
                  הוספת פריט
                </Button>
              </div>
              <ul>
                {d.offers.map((o) => (
                  <li key={o.id} className="flex justify-between py-2">
                    <span>
                      {o.name} · {(o.unitAmount / 100).toFixed(2)} {o.currency}{" "}
                      · {o.active ? "פעיל" : "לא פעיל"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        action({
                          action: "offer",
                          id: o.id,
                          data: { ...o, active: !o.active },
                        })
                      }
                    >
                      {o.active ? "השהה" : "הפעל"}
                    </Button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title={previousId ? "גרסה חדשה להצעה" : "הצעה ללקוח"}>
            <div className="space-y-3">
              <label>
                ליד
                <select
                  className="border p-2 w-full"
                  value={leadId}
                  onChange={(e) => {
                    setLeadId(e.target.value);
                    setPreviousId(undefined);
                  }}
                >
                  <option value="">בחר ליד</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.contact.fullName}
                    </option>
                  ))}
                  {leadId && !leads.some((l) => l.id === leadId) && (
                    <option value={leadId}>הליד שנבחר</option>
                  )}
                </select>
              </label>
              <Input
                label="כותרת"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              {lines.map((l, i) => (
                <div key={i} className="grid sm:grid-cols-4 gap-2">
                  <select
                    aria-label="פריט"
                    className="border p-2"
                    value={l.offerId}
                    onChange={(e) =>
                      setLines(
                        lines.map((x, j) =>
                          j === i ? { ...x, offerId: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="">בחר מוצר או חבילה</option>
                    {d.offers
                      .filter((o) => o.active)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} · {o.unitAmount / 100} {o.currency}
                        </option>
                      ))}
                  </select>
                  <Input
                    label="כמות"
                    type="number"
                    min="1"
                    value={l.quantity}
                    onChange={(e) =>
                      setLines(
                        lines.map((x, j) =>
                          j === i
                            ? { ...x, quantity: Number(e.target.value) }
                            : x,
                        ),
                      )
                    }
                  />
                  <Input
                    label="הנחה (%)"
                    type="number"
                    min="0"
                    max="100"
                    value={l.discountBps / 100}
                    onChange={(e) =>
                      setLines(
                        lines.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                discountBps: Math.round(
                                  Number(e.target.value) * 100,
                                ),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    disabled={lines.length === 1}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    הסר
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                disabled={lines.length >= 30}
                onClick={() =>
                  setLines([
                    ...lines,
                    { offerId: "", quantity: 1, discountBps: 0 },
                  ])
                }
              >
                הוסף פריט
              </Button>
              <Textarea
                label="תנאים והתחייבויות"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
              />
              <Input
                label="תוקף בימים"
                type="number"
                min="1"
                max="365"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
              <Button
                loading={busy}
                disabled={!leadId || lines.some((l) => !l.offerId)}
                onClick={async () => {
                  if (
                    await action({
                      action: "quote",
                      data: {
                        leadId,
                        previousId,
                        title,
                        terms,
                        lines,
                        expiresAt: new Date(
                          Date.now() + days * 86400000,
                        ).toISOString(),
                      },
                    })
                  )
                    setPreviousId(undefined);
                }}
                data-testid="quote-create"
              >
                חשב ושמור הצעה
              </Button>
            </div>
          </Panel>
          {sharePath && (
            <Panel title="הקישור מוכן לשיתוף">
              <p>
                העתק ושלח ללקוח בערוץ שבחרת. לא נשלחה הודעה אוטומטית. יצירת
                קישור מחדש מבטלת את הקודם.
              </p>
              <a
                href={sharePath}
                target="_blank"
                rel="noreferrer"
                data-testid="quote-public-link"
              >
                תצוגת ההצעה ללקוח
              </a>
              <Button
                onClick={() =>
                  navigator.clipboard.writeText(
                    window.location.origin + sharePath,
                  )
                }
              >
                העתק קישור
              </Button>
            </Panel>
          )}
          <Panel title="הצעות ומצב סגירה">
            <div className="space-y-3">
              {d.quotes.map((q) => (
                <article
                  key={q.id}
                  className="border rounded p-3"
                  data-testid="quote-row"
                >
                  <b>
                    {q.title} — {q.lead.contact.fullName}
                  </b>
                  <p>
                    גרסה {q.revision} · {(q.total / 100).toFixed(2)}{" "}
                    {q.currency} · {states[q.status] ?? q.status}
                  </p>
                  <p className="text-xs">
                    {d.canManage &&
                      (q.margin == null
                        ? "רווח גולמי לא ידוע — חסרה עלות מוצר"
                        : `רווח גולמי לפני מס: ${(q.margin / 100).toFixed(2)} ${q.currency}`)}
                  </p>
                  <p className="text-xs">
                    {q.viewedAt ? "הקישור נפתח" : "טרם נפתחה ההצעה"} ·{" "}
                    {q.acceptedAt
                      ? "אישור התקבל; אין בכך אישור תשלום"
                      : "ממתין לאישור הלקוח"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {q.status === "pending_approval" && d.canManage && (
                      <Button
                        size="sm"
                        onClick={() => action({ action: "approve", id: q.id })}
                      >
                        אישור הנחה חריגה
                      </Button>
                    )}
                    {["approved", "shared"].includes(q.status) && (
                      <Button
                        size="sm"
                        onClick={() => action({ action: "share", id: q.id })}
                        data-testid="quote-share"
                      >
                        צור קישור לשיתוף
                      </Button>
                    )}
                    {!["accepted", "revoked"].includes(q.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => action({ action: "revoke", id: q.id })}
                      >
                        בטל הצעה וקישור
                      </Button>
                    )}
                    {q.status !== "accepted" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setLeadId(q.leadId);
                          setPreviousId(q.id);
                          setTitle(q.title);
                          setTerms(q.terms);
                          setLines(
                            q.lines.map(
                              ({ offerId, quantity, discountBps }) => ({
                                offerId,
                                quantity,
                                discountBps,
                              }),
                            ),
                          );
                          window.scrollTo(0, 0);
                        }}
                      >
                        הכן גרסה חדשה
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </Panel>
        </>
      )}
    </main>
  );
}
