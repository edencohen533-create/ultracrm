"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Textarea } from "@/components/ui";
export function RequestExpert({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false),
    [candidates, setCandidates] = useState<Array<{ id: string; name: string }>>(
      [],
    ),
    [expertId, setExpertId] = useState(""),
    [summary, setSummary] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div>
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          setOpen(!open);
          try {
            const r = await api.get<{ candidates: typeof candidates }>(
              `/api/sales/assistance?callId=${callId}`,
            );
            setCandidates(r.candidates);
          } catch (e) {
            setMessage((e as Error).message);
          }
        }}
      >
        בקש מומחה לסגירה
      </Button>
      {open && (
        <div className="absolute z-50 end-3 bg-panel border border-line p-4 rounded shadow-lg w-80 space-y-2">
          <p>בחר מנהל שמחובר למערכת ופנוי. חיבור השמע ייבדק כשהוא יצטרף.</p>
          <select
            aria-label="מומחה"
            className="w-full"
            value={expertId}
            onChange={(e) => setExpertId(e.target.value)}
          >
            <option value="">בחר מומחה</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {!candidates.length && <p>אין כרגע מומחה זמין בהרשאות המתאימות.</p>}
          <Textarea
            label="תקציר למומחה — מה נדרש לסגירה?"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <Button
            loading={busy}
            disabled={!expertId || summary.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("/api/sales/assistance", {
                  callId,
                  expertId,
                  summary,
                });
                setMessage(
                  "הבקשה ממתינה למומחה במסך המוקד למשך שתי דקות. הוא עדיין לא הצטרף לשיחה.",
                );
              } catch (e) {
                setMessage((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            שלח בקשת סיוע
          </Button>
          {message && <p role="status">{message}</p>}
        </div>
      )}
    </div>
  );
}
export function ExpertInbox({
  onJoin,
}: {
  onJoin: (callId: string) => Promise<void>;
}) {
  const [items, setItems] = useState<
      Array<{ id: string; callId: string; title: string; summary: string }>
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .get<{ items: typeof items }>("/api/sales/assistance")
        .then((r) => {
          if (live) {
            setItems(r.items);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!items.length && !error) return null;
  return (
    <section className="border border-accent rounded p-3 space-y-2">
      <h3>בקשות סיוע לסגירה</h3>
      {error && <p role="alert">{error}</p>}
      {items.map((r) => (
        <article key={r.id}>
          <b>{r.title}</b>
          <p className="whitespace-pre-wrap">{r.summary}</p>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await onJoin(r.callId);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            פתח חיבור לשיחה
          </Button>
          <small className="block">
            החיבור מתחיל בהאזנה. לאחר החיבור בחר ״הצטרף לשיחה״ כדי לדבר עם שני
            הצדדים.
          </small>
        </article>
      ))}
    </section>
  );
}
