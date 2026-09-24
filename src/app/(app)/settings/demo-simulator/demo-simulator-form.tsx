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

interface ContactOption {
  id: string;
  name: string;
  phone: string;
}

export function DemoSimulatorForm({ contacts }: { contacts: ContactOption[] }) {
  const router = useRouter();
  const [contactId, setContactId] = useState<string>("");
  const [body, setBody] = useState("שלום, רציתי לשאול לגבי הזמנה שביצעתי");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    if (!contactId || !body.trim()) {
      toast.error("יש לבחור איש קשר ולהזין תוכן הודעה");
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
        toast.error(data?.error ? "שגיאה בשליחת הודעה" : "שגיאה בשליחת הודעה");
        return;
      }

      const data = await res.json();
      toast.success("הודעה נכנסת הודמתה בהצלחה");
      router.push(`/inbox/${data.conversationId}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">איש קשר</label>
        <Select value={contactId} onValueChange={(value) => setContactId(value ?? "")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="בחר איש קשר..." />
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
        <label className="text-sm font-medium">תוכן ההודעה הנכנסת</label>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      </div>

      <Button onClick={handleSubmit} disabled={isSubmitting}>
        {isSubmitting ? "שולח..." : "שלח הודעה נכנסת מדומה"}
      </Button>
    </div>
  );
}
