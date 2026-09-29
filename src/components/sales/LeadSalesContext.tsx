"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
type Data = {
  advertisement: {
    status: string;
    message: string;
    ad?: {
      name: string;
      title: string;
      body: string;
      image: string | null;
      hasVideo: boolean;
      video?: string | null;
    };
  };
  qualification: Array<{ question: string; answer: string; at: string }>;
};
export function LeadSalesContext({ leadId }: { leadId: string }) {
  const [d, setD] = useState<Data | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setD(null);
    setError("");
    api
      .get<Data>(`/api/leads/${leadId}/sales-context`)
      .then((r) => {
        if (live) setD(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [leadId]);
  return (
    <section className="border rounded p-3 space-y-3">
      <h3 className="font-semibold">הקשר למכירה</h3>
      {error && <p role="alert">{error}</p>}
      {!d && !error && <p>טוען מידע…</p>}
      {d && (
        <>
          <div>
            <h4>המודעה שממנה הגיע הליד</h4>
            <p className="text-xs text-muted">{d.advertisement.message}</p>
            {d.advertisement.ad && (
              <>
                <b>{d.advertisement.ad.title || d.advertisement.ad.name}</b>
                <p className="whitespace-pre-wrap">{d.advertisement.ad.body}</p>
                {d.advertisement.ad.video ? (
                  <video
                    controls
                    preload="none"
                    src={d.advertisement.ad.video}
                    className="max-h-64"
                  />
                ) : (
                  d.advertisement.ad.image && (
                    /* eslint-disable-next-line @next/next/no-img-element */ <img
                      src={d.advertisement.ad.image}
                      alt={
                        d.advertisement.ad.hasVideo
                          ? "תצוגה מקדימה של סרטון המודעה"
                          : "תמונת המודעה"
                      }
                      referrerPolicy="no-referrer"
                      className="max-h-56 rounded"
                    />
                  )
                )}
              </>
            )}
          </div>
          <div>
            <h4>תשובות לסינון מקדים</h4>
            {d.qualification.length ? (
              d.qualification.map((a) => (
                <dl key={a.question} className="my-2">
                  <dt className="font-medium">{a.question}</dt>
                  <dd>
                    {a.answer}
                    <small className="block text-muted">
                      דברי הלקוח · {new Date(a.at).toLocaleString("he-IL")}
                    </small>
                  </dd>
                </dl>
              ))
            ) : (
              <p className="text-xs text-muted">
                טרם נשמרו תשובות. שאלות מוגדרות בהגדרות עוזר ה־AI.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
