"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RuleBuilder, type EditableRule, type RuleBuilderOptions } from "./rule-builder";
import { useT } from "@/components/i18n/LangProvider";

type Rule = EditableRule;

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
  CREATE_TASK: ["יצירת משימת מעקב", "Create follow-up task"],
  SET_CUSTOM_FIELD: ["עדכון שדה מותאם", "Update custom field"],
};

export function RuleList({ rules: initialRules, options }: { rules: Rule[]; options: RuleBuilderOptions }) {
  const [editing, setEditing] = useState<Rule | null>(null);
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
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-line bg-panel">
      <Table className="min-w-[640px] table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[32%]">{t("שם", "Name")}</TableHead>
            <TableHead>{t("טריגר", "Trigger")}</TableHead>
            <TableHead>{t("פעולה", "Action")}</TableHead>
            <TableHead className="w-20 text-center">{t("פעיל", "Active")}</TableHead>
            <TableHead className="w-20 text-center">{t("מחיקה", "Delete")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={rule.id}>
              <TableCell className="whitespace-normal break-words font-medium"><button type="button" className="text-start underline-offset-4 hover:underline" onClick={() => setEditing(rule)}>{rule.name}</button></TableCell>
              <TableCell>
                <button type="button" aria-label={t(`עריכת טריגר: ${rule.name}`, `Edit trigger: ${rule.name}`)} onClick={() => setEditing(rule)} className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-accent"><Badge variant="outline">{TRIGGER_LABELS[rule.trigger] ? t(...TRIGGER_LABELS[rule.trigger]) : rule.trigger}</Badge></button>
              </TableCell>
              <TableCell>
                <button type="button" aria-label={t(`עריכת פעולה: ${rule.name}`, `Edit action: ${rule.name}`)} onClick={() => setEditing(rule)} className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-accent"><Badge variant="secondary">{ACTION_LABELS[rule.actionType] ? t(...ACTION_LABELS[rule.actionType]) : rule.actionType}</Badge></button>
              </TableCell>
              <TableCell className="text-center">
                <Switch
                  aria-label={t(`הפעלת ${rule.name}`, `Enable ${rule.name}`)}
                  checked={rule.isActive}
                  disabled={pending !== null}
                  onCheckedChange={(checked) => toggleActive(rule.id, checked)}
                />
              </TableCell>
              <TableCell className="text-center">
                <button type="button" className="text-xs text-bad underline disabled:opacity-40" disabled={pending === rule.id} onClick={() => remove(rule)} data-testid={`rule-delete-${rule.id}`}>{t("מחק", "Delete")}</button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editing && <RuleBuilder key={editing.id} {...options} initial={editing} onClosed={() => setEditing(null)} />}
    </div>
  );
}
