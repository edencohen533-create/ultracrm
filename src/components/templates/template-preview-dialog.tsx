"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { renderTemplatePreview } from "@/lib/template-preview";
import { Eye } from "lucide-react";

export function TemplatePreviewDialog({
  name,
  body,
  variables,
}: {
  name: string;
  body: string;
  variables: string[];
}) {
  const [values, setValues] = useState<string[]>(variables.map(() => ""));

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Eye className="h-4 w-4" /> תצוגה מקדימה
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
                onChange={(e) => {
                  const next = [...values];
                  next[index] = e.target.value;
                  setValues(next);
                }}
                placeholder={`ערך ל-${label}`}
              />
            </div>
          ))}
          <div className="rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
            {renderTemplatePreview(
              body,
              variables.map((label, index) => values[index] || `[${label}]`)
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
