"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useT } from "@/components/i18n/LangProvider";

interface Rule {
  id: string;
  name: string;
  trigger: string;
  actionType: string;
  isActive: boolean;
}

const TRIGGER_LABELS: Record<string, [string, string]> = {
  NEW_INBOUND_MESSAGE: ["הודעה נכנסת חדשה", "New inbound message"],
  NEW_CONVERSATION: ["שיחה חדשה", "New conversation"],
  TAG_ADDED: ["תגית נוספה", "Tag added"],
  CONVERSATION_UNASSIGNED: ["שיחה לא משויכת", "Unassigned conversation"],
  NO_REPLY_TIMEOUT: ["אין מענה בזמן", "No reply in time"],
};

const ACTION_LABELS: Record<string, [string, string]> = {
  ASSIGN_AGENT: ["שיוך לנציג", "Assign to agent"],
  ADD_TAG: ["הוספת תגית", "Add tag"],
  CHANGE_STATUS: ["שינוי סטטוס", "Change status"],
  ADD_INTERNAL_NOTE: ["הוספת הערה", "Add note"],
  SEND_CANNED_REPLY: ["תגובה מוכנה", "Canned reply"],
  SEND_TEMPLATE: ["שליחת תבנית", "Send template"],
};

export function RuleList({ rules: initialRules }: { rules: Rule[] }) {
  const [rules, setRules] = useState(initialRules);
  const [pending, setPending] = useState<string | null>(null);
  const t = useT();

  async function remove(rule: Rule) {
    if (!window.confirm(t(`למחוק את האוטומציה "${rule.name}"? ריצות מתוזמנות שטרם בוצעו יבוטלו וההיסטוריה של הריצות שלה תימחק.`, `Delete the automation "${rule.name}"? Scheduled runs that have not executed yet will be cancelled and its run history will be deleted.`))) return;
    setPending(rule.id);
    try {
      const res = await fetch(`/api/automations/rules/${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? t("המחיקה נכשלה", "Delete failed"));
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      toast.success(t("האוטומציה נמחקה", "Automation deleted"));
    } catch (e) { toast.error((e as Error).message); } finally { setPending(null); }
  }

  async function toggleActive(id: string, isActive: boolean) {
    setPending(id);
    // Optimistic update — flip it immediately, roll back only on failure.
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, isActive } : r)));
    try {
      const res = await fetch(`/api/automations/rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) {
        setRules((prev) => prev.map((r) => (r.id === id ? { ...r, isActive: !isActive } : r)));
        toast.error(t("שגיאה בעדכון החוק", "Error updating rule"));
      }
    } catch {
      setRules((prev) => prev.map((r) => r.id === id ? { ...r, isActive: !isActive } : r));
      toast.error(t("העדכון נכשל. יש לבדוק את החיבור ולנסות שוב", "Update failed. Check your connection and try again"));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("שם", "Name")}</TableHead>
            <TableHead>{t("טריגר", "Trigger")}</TableHead>
            <TableHead>{t("פעולה", "Action")}</TableHead>
            <TableHead>{t("פעיל", "Active")}</TableHead>
            <TableHead className="w-24">{t("מחיקה", "Delete")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={rule.id}>
              <TableCell className="font-medium">{rule.name}</TableCell>
              <TableCell>
                <Badge variant="outline">{TRIGGER_LABELS[rule.trigger] ? t(...TRIGGER_LABELS[rule.trigger]) : rule.trigger}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{ACTION_LABELS[rule.actionType] ? t(...ACTION_LABELS[rule.actionType]) : rule.actionType}</Badge>
              </TableCell>
              <TableCell>
                <Switch
                  checked={rule.isActive}
                  disabled={pending !== null}
                  onCheckedChange={(checked) => toggleActive(rule.id, checked)}
                />
              </TableCell>
              <TableCell>
                <button type="button" className="text-xs text-bad underline disabled:opacity-40" disabled={pending === rule.id} onClick={() => remove(rule)} data-testid={`rule-delete-${rule.id}`}>{t("מחק", "Delete")}</button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
