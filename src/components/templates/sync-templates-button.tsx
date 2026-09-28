"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n/LangProvider";
export function SyncTemplatesButton() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return <Button disabled={busy} onClick={async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/templates/sync", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      toast.success(t(`סונכרנו ${result.synced} תבניות, ${result.sendable} זמינות לשליחה`, `Synced ${result.synced} templates, ${result.sendable} available to send`));
      router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : t("סנכרון נכשל", "Sync failed")); }
    finally { setBusy(false); }
  }}>{busy ? t("מסנכרן...", "Syncing...") : t("סנכרון תבניות מ־Meta", "Sync templates from Meta")}</Button>;
}
