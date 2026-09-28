"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Ltr } from "@/components/shared/ltr";
import { useT } from "@/components/i18n/LangProvider";

interface ContactOption {
  id: string;
  name: string;
  phone: string;
}

export function DemoSimulatorForm({ contacts }: { contacts: ContactOption[] }) {
  const t = useT();
  const router = useRouter();
  const [contactId, setContactId] = useState<string>("");
  const [body, setBody] = useState(() => t("שלום, רציתי לשאול לגבי הזמנה שביצעתי", "Hi, I wanted to ask about an order I placed"));
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    if (!contactId || !body.trim()) {
      toast.error(t("יש לבחור איש קשר ולהזין תוכן הודעה", "Select a contact and enter a message"));
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/demo/simulate-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, body }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ? t("שגיאה בשליחת הודעה", "Failed to send message") : t("שגיאה בשליחת הודעה", "Failed to send message"));
        return;
      }

      const data = await res.json();
      toast.success(t("הודעה נכנסת הודמתה בהצלחה", "Inbound message simulated successfully"));
      router.push(`/inbox/${data.conversationId}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">{t("איש קשר", "Contact")}</label>
        <Select value={contactId} onValueChange={(value) => setContactId(value ?? "")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("בחר איש קשר...", "Select a contact...")} />
          </SelectTrigger>
          <SelectContent>
            {contacts.map((contact) => (
              <SelectItem key={contact.id} value={contact.id}>
                {contact.name} · <Ltr>{contact.phone}</Ltr>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t("תוכן ההודעה הנכנסת", "Inbound message content")}</label>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      </div>

      <Button onClick={handleSubmit} disabled={isSubmitting}>
        {isSubmitting ? t("שולח...", "Sending...") : t("שלח הודעה נכנסת מדומה", "Send simulated inbound message")}
      </Button>
    </div>
  );
}
