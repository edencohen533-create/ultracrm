"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Input, Panel } from "@/components/ui";
type Data = {
  connection: {
    accountId: string;
    accountName: string;
    verifiedAt: string;
  } | null;
  canManage: boolean;
  encryptionReady: boolean;
};
export function MetaAdSettings() {
  const [d, setD] = useState<Data | null>(null),
    [accountId, setAccountId] = useState(""),
    [accessToken, setAccessToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<Data>("/api/sales/meta")
      .then(setD)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Panel title="מודעת המקור — Facebook Ads">
      {error && <p role="alert">{error}</p>}
      {d && (
        <>
          <p>
            {d.connection
              ? `מחובר: ${d.connection.accountName} (${d.connection.accountId})`
              : "חשבון פרסום טרם חובר"}
          </p>
          <p className="text-xs text-muted">
            כדי להציג מודעה בכרטיס הליד, מקור הקליטה צריך להעביר מזהה מודעה
            מדויק בשדה metaAdId או ad_id. שם קמפיין לבדו אינו מספיק. החיבור קורא
            מודעות ואינו משנה תקציבים.
          </p>
          {d.canManage && (
            <>
              <Input
                label="מזהה חשבון פרסום"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
              <Input
                label="אסימון גישה לחשבון עם הרשאת ads_read"
                type="password"
                autoComplete="off"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
              {!d.encryptionReady && (
                <p>נדרשת הגדרת הצפנה בשרת לפני שמירת חיבור.</p>
              )}
              <Button
                loading={busy}
                disabled={!d.encryptionReady || !accessToken || !accountId}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setD(
                      await api.post<Data>("/api/sales/meta", {
                        accountId,
                        accessToken,
                      }),
                    );
                    setAccessToken("");
                    setError("");
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                בדוק וחבר חשבון
              </Button>
              {d.connection && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.delete("/api/sales/meta");
                      setD({ ...d, connection: null });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  נתק חשבון
                </Button>
              )}
            </>
          )}
        </>
      )}
    </Panel>
  );
}
