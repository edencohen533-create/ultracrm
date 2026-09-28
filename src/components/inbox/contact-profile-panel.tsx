"use client";

import { useT } from "@/components/i18n/LangProvider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Ltr } from "@/components/shared/ltr";

interface ContactProfileData {
  name: string;
  phone: string;
  email: string | null;
  consentStatus: string;
  tags: { tag: { id: string; name: string; color: string } }[];
  customFields: { key: string; value: string }[];
}

const CONSENT_LABELS: Record<string, [string, string]> = {
  OPTED_IN: ["הסכים לדיוור שיווקי", "Opted in to marketing"],
  OPTED_OUT: ["הוסר מדיוור שיווקי", "Opted out of marketing"],
  UNKNOWN: ["לא ידוע", "Unknown"],
};

export function ContactProfilePanel({ contact }: { contact: ContactProfileData }) {
  const t = useT();
  const consent = CONSENT_LABELS[contact.consentStatus];
  const initials = contact.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");

  return (
    <div className="hidden h-full w-72 shrink-0 flex-col xl:flex gap-4 overflow-y-auto border-s p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar className="h-16 w-16">
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        <div>
          <p className="font-medium">{contact.name}</p>
          <p className="text-sm text-muted-foreground">
            <Ltr>{contact.phone}</Ltr>
          </p>
          {contact.email && (
            <p className="text-sm text-muted-foreground">
              <Ltr>{contact.email}</Ltr>
            </p>
          )}
        </div>
      </div>

      <Separator />

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("תגיות", "Tags")}</p>
        <div className="flex flex-wrap gap-1">
          {contact.tags.length === 0 && <span className="text-xs text-muted-foreground">{t("אין תגיות", "No tags")}</span>}
          {contact.tags.map(({ tag }) => (
            <Badge key={tag.id} variant="outline">
              {tag.name}
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("סטטוס הסכמה", "Consent status")}</p>
        <Badge variant="secondary">{consent ? t(consent[0], consent[1]) : contact.consentStatus}</Badge>
      </div>

      {contact.customFields.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("שדות מותאמים", "Custom fields")}</p>
          <div className="space-y-1 text-sm">
            {contact.customFields.map((field) => (
              <div key={field.key} className="flex justify-between">
                <span className="text-muted-foreground">{field.key}</span>
                <span>{field.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
