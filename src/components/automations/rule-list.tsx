"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface Rule {
  id: string;
  name: string;
  trigger: string;
  actionType: string;
  isActive: boolean;
}

const TRIGGER_LABELS: Record<string, string> = {
  NEW_INBOUND_MESSAGE: "הודעה נכנסת חדשה",
  NEW_CONVERSATION: "שיחה חדשה",
  TAG_ADDED: "תגית נוספה",
  CONVERSATION_UNASSIGNED: "שיחה לא משויכת",
  NO_REPLY_TIMEOUT: "אין מענה בזמן",
};

const ACTION_LABELS: Record<string, string> = {
  ASSIGN_AGENT: "שיוך לנציג",
  ADD_TAG: "הוספת תגית",
  CHANGE_STATUS: "שינוי סטטוס",
  ADD_INTERNAL_NOTE: "הוספת הערה",
  SEND_CANNED_REPLY: "תגובה מוכנה",
  SEND_TEMPLATE: "שליחת תבנית",
};

export function RuleList({ rules: initialRules }: { rules: Rule[] }) {
  const [rules, setRules] = useState(initialRules);
  const [pending, setPending] = useState<string | null>(null);

  async function remove(rule: Rule) {
    if (!window.confirm(`למחוק את האוטומציה "${rule.name}"? ריצות מתוזמנות שטרם בוצעו יבוטלו וההיסטוריה של הריצות שלה תימחק.`)) return;
    setPending(rule.id);
    try {
      const res = await fetch(`/api/automations/rules/${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "המחיקה נכשלה");
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      toast.success("האוטומציה נמחקה");
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
        toast.error("שגיאה בעדכון החוק");
      }
    } catch {
      setRules((prev) => prev.map((r) => r.id === id ? { ...r, isActive: !isActive } : r));
      toast.error("העדכון נכשל. יש לבדוק את החיבור ולנסות שוב");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>שם</TableHead>
            <TableHead>טריגר</TableHead>
            <TableHead>פעולה</TableHead>
            <TableHead>פעיל</TableHead>
            <TableHead className="w-24">מחיקה</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={rule.id}>
              <TableCell className="font-medium">{rule.name}</TableCell>
              <TableCell>
                <Badge variant="outline">{TRIGGER_LABELS[rule.trigger] ?? rule.trigger}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{ACTION_LABELS[rule.actionType] ?? rule.actionType}</Badge>
              </TableCell>
              <TableCell>
                <Switch
                  checked={rule.isActive}
                  disabled={pending !== null}
                  onCheckedChange={(checked) => toggleActive(rule.id, checked)}
                />
              </TableCell>
              <TableCell>
                <button type="button" className="text-xs text-bad underline disabled:opacity-40" disabled={pending === rule.id} onClick={() => remove(rule)} data-testid={`rule-delete-${rule.id}`}>מחק</button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
