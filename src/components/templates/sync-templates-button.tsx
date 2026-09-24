"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
export function SyncTemplatesButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return <Button disabled={busy} onClick={async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/templates/sync", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      toast.success(`סונכרנו ${result.synced} תבניות, ${result.sendable} זמינות לשליחה`);
      router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "סנכרון נכשל"); }
    finally { setBusy(false); }
  }}>{busy ? "מסנכרן..." : "סנכרון תבניות מ־Meta"}</Button>;
}
