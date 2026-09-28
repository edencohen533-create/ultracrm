"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n/LangProvider";

export function StopAutomationsButton() {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const t = useT();
  return <Button variant="destructive" disabled={pending} onClick={async () => {
    if (!window.confirm(t("להשבית את כל החוקים ולבטל הרצות ממתינות? פעולה שכבר החלה עשויה להסתיים. הפעלה מחדש של חוק לא תחזיר הרצות שבוטלו.", "Disable all rules and cancel pending runs? Actions already in progress may still complete. Re-enabling a rule will not restore cancelled runs."))) return;
    setPending(true);
    try {
      const response = await fetch("/api/automations/stop", { method: "POST" });
      if (!response.ok) throw new Error();
      toast.success(t("כל החוקים הושבתו וההרצות הממתינות בוטלו", "All rules disabled and pending runs cancelled"));
      router.refresh();
    } catch { toast.error(t("העצירה לא אושרה. יש לרענן ולנסות שוב", "Stop was not confirmed. Refresh and try again")); }
    finally { setPending(false); }
  }}>{t("עצירת כל האוטומציות", "Stop all automations")}</Button>;
}
