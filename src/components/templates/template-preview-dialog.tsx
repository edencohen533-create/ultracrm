"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { renderTemplatePreview } from "@/lib/template-preview";
import { Eye } from "lucide-react";
import { useT } from "@/components/i18n/LangProvider";

export function TemplatePreviewDialog({
  name,
  body,
  variables,
  headerFormat,
  buttons,
}: {
  name: string;
  body: string;
  variables: string[];
  headerFormat?: string | null;
  buttons?: Array<{ type: string; text: string; url?: string | null; dynamic?: boolean }> | null;
}) {
  const t = useT();
  const [values, setValues] = useState<string[]>(variables.map(() => ""));
  const header = (headerFormat ?? "").toUpperCase();

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Eye className="h-4 w-4" /> {t("תצוגה מקדימה", "Preview")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {variables.map((label, index) => (
            <div key={label} className="space-y-1">
              <Label>{label}</Label>
              <Input
                value={values[index]}
                onChange={(event) => setValues((current) => current.map((value, i) => (i === index ? event.target.value : value)))}
                placeholder={t("ערך לדוגמה", "Sample value")}
              />
            </div>
          ))}
          <div className="space-y-2 rounded-lg bg-emerald-50 p-3 text-emerald-950">
            {["IMAGE", "VIDEO", "DOCUMENT"].includes(header) && (
              <div className="rounded border border-dashed border-emerald-400 bg-white/70 p-2 text-xs text-muted-foreground">
                {t(`כותרת ${header === "IMAGE" ? "תמונה" : header === "VIDEO" ? "וידאו" : "מסמך"} – קובץ המדיה מצורף בעת יצירת הקמפיין (קישור https ציבורי)`, `${header === "IMAGE" ? "Image" : header === "VIDEO" ? "Video" : "Document"} header – the media file is attached when creating the campaign (public https link)`)}
              </div>
            )}
            <div className="whitespace-pre-wrap text-sm">{renderTemplatePreview(body, values)}</div>
            {buttons && buttons.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-emerald-200 pt-2">
                {buttons.map((b, i) => (
                  <span key={i} className="rounded-full border border-emerald-400 bg-white px-3 py-1 text-xs">
                    {b.type === "URL" ? "🔗 " : b.type === "PHONE_NUMBER" ? "📞 " : b.type === "COPY_CODE" ? "⧉ " : ""}{b.text}
                    {b.type === "URL" && b.dynamic ? t(" (קישור דינמי – הסיומת נקבעת בקמפיין)", " (dynamic link – the suffix is set in the campaign)") : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
