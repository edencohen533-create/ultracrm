"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function StopAutomationsButton() {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  return <Button variant="destructive" disabled={pending} onClick={async () => {
    if (!window.confirm("להשבית את כל החוקים ולבטל הרצות ממתינות? פעולה שכבר החלה עשויה להסתיים. הפעלה מחדש של חוק לא תחזיר הרצות שבוטלו.")) return;
    setPending(true);
    try {
      const response = await fetch("/api/automations/stop", { method: "POST" });
      if (!response.ok) throw new Error();
      toast.success("כל החוקים הושבתו וההרצות הממתינות בוטלו");
      router.refresh();
    } catch { toast.error("העצירה לא אושרה. יש לרענן ולנסות שוב"); }
    finally { setPending(false); }
  }}>עצירת כל האוטומציות</Button>;
}
