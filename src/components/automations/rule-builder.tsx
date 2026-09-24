"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AutomationActionType, AutomationTrigger } from "@/generated/prisma/enums";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus } from "lucide-react";

const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  NEW_INBOUND_MESSAGE: "הודעה נכנסת חדשה",
  NEW_CONVERSATION: "שיחה חדשה",
  TAG_ADDED: "תגית נוספה",
  CONVERSATION_UNASSIGNED: "שיחה לא משויכת",
  NO_REPLY_TIMEOUT: "אין מענה תוך X דקות",
};

const ACTION_LABELS: Record<AutomationActionType, string> = {
  ASSIGN_AGENT: "שיוך לנציג",
  ADD_TAG: "הוספת תגית",
  CHANGE_STATUS: "שינוי סטטוס",
  ADD_INTERNAL_NOTE: "הוספת הערה פנימית",
  SEND_CANNED_REPLY: "שליחת תגובה מוכנה",
  SEND_TEMPLATE: "שליחת תבנית",
  CREATE_TASK: "יצירת משימת מעקב",
  SET_CUSTOM_FIELD: "עדכון שדה מותאם",
};

interface Option {
  id: string;
  label: string;
  variables?: string[];
}

export function RuleBuilder({ agents, cannedReplies, templates, conversations }: { agents: Option[]; cannedReplies: Option[]; templates: Option[]; conversations: Option[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<AutomationTrigger>(AutomationTrigger.NEW_INBOUND_MESSAGE);
  const [minutes, setMinutes] = useState("30");
  const [tagName, setTagName] = useState("");
  const [actionType, setActionType] = useState<AutomationActionType>(AutomationActionType.ASSIGN_AGENT);
  const [agentId, setAgentId] = useState("");
  const [actionTagName, setActionTagName] = useState("");
  const [status, setStatus] = useState("OPEN");
  const [noteBody, setNoteBody] = useState("");
  const [cannedReplyId, setCannedReplyId] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [templateId, setTemplateId] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [onlyOutsideHours, setOnlyOutsideHours] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDueHours, setTaskDueHours] = useState("24");
  const [fieldKey, setFieldKey] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<{ input: string; result: { allowedLocally: boolean; reasons: string[]; body: string | null; provider: string; notice: string; delayMinutes: number } } | null>(null);

  function buildTriggerConfig(): Record<string, unknown> {
    const hours = onlyOutsideHours ? { onlyOutsideHours: true } : {};
    if (trigger === AutomationTrigger.NO_REPLY_TIMEOUT) return { minutes: Number(minutes) || 30, ...hours };
    if (trigger === AutomationTrigger.TAG_ADDED) return { ...(tagName ? { tagName } : {}), ...hours };
    return hours;
  }

  function buildActionConfig(): Record<string, unknown> {
    switch (actionType) {
      case AutomationActionType.ASSIGN_AGENT:
        return { agentId };
      case AutomationActionType.ADD_TAG:
        return { tagName: actionTagName };
      case AutomationActionType.CHANGE_STATUS:
        return { status };
      case AutomationActionType.ADD_INTERNAL_NOTE:
        return { body: noteBody };
      case AutomationActionType.SEND_CANNED_REPLY:
        return { cannedReplyId };
      case AutomationActionType.SEND_TEMPLATE:
        return { templateId, variables, ...(mediaUrl ? { mediaUrl } : {}) };
      case AutomationActionType.CREATE_TASK:
        return { title: taskTitle, dueHours: Number(taskDueHours) || 24 };
      case AutomationActionType.SET_CUSTOM_FIELD:
        return { key: fieldKey, value: fieldValue };
      default:
        return {};
    }
  }

  const rule = { name, trigger, triggerConfig: buildTriggerConfig(), actionType, actionConfig: buildActionConfig(), isActive };
  const previewInput = JSON.stringify({ rule, conversationId });
  async function handlePreview() {
    const input = previewInput;
    setTesting(true); setPreview(null);
    try {
      const response = await fetch("/api/automations/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: input });
      const result = await response.json();
      if (!response.ok) { toast.error(typeof result.error === "string" ? result.error : "פרטי הבדיקה אינם תקינים"); return; }
      setPreview({ input, result });
    } catch { toast.error("הבדיקה נכשלה. יש לבדוק את החיבור ולנסות שוב"); }
    finally { setTesting(false); }
  }

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("נא להזין שם לחוק");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      });
      if (!res.ok) {
        toast.error("שגיאה ביצירת החוק");
        return;
      }
      toast.success("החוק נוצר בהצלחה");
      setOpen(false);
      router.refresh();
    } catch { toast.error("שמירת החוק נכשלה. יש לבדוק את החיבור ולנסות שוב"); }
    finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="h-4 w-4" /> חוק אוטומציה חדש</Button>} />
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="ps-8">חוק אוטומציה חדש</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>שם החוק</Label>
            <Input aria-label="שם חוק האוטומציה" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: שיוך אוטומטי ללקוחות VIP" />
          </div>

          <div className="space-y-1.5">
            <Label>טריגר</Label>
            <Select value={trigger} onValueChange={(v) => v && setTrigger(v as AutomationTrigger)}>
              <SelectTrigger className="w-full">
                <SelectValue>{TRIGGER_LABELS[trigger]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyOutsideHours} onChange={(e) => setOnlyOutsideHours(e.target.checked)} />להפעיל רק מחוץ לשעות הפעילות (חלון השליחה בהגדרות → דיוור)</label>
          {trigger === AutomationTrigger.NO_REPLY_TIMEOUT && (
            <div className="space-y-1.5">
              <Label>דקות ללא מענה</Label>
              <Input type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
          )}
          {trigger === AutomationTrigger.TAG_ADDED && (
            <div className="space-y-1.5">
              <Label>שם התגית (השאר ריק לכל תגית)</Label>
              <Input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="VIP" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>פעולה</Label>
            <Select value={actionType} onValueChange={(v) => v && setActionType(v as AutomationActionType)}>
              <SelectTrigger className="w-full" aria-label="פעולת האוטומציה">
                <SelectValue>{ACTION_LABELS[actionType]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ACTION_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {actionType === AutomationActionType.ASSIGN_AGENT && (
            <div className="space-y-1.5">
              <Label>נציג</Label>
              <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{agents.find((agent) => agent.id === agentId)?.label ?? "בחר נציג..."}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {actionType === AutomationActionType.ADD_TAG && (
            <div className="space-y-1.5">
              <Label>שם התגית להוספה</Label>
              <Input value={actionTagName} onChange={(e) => setActionTagName(e.target.value)} />
            </div>
          )}
          {actionType === AutomationActionType.CHANGE_STATUS && (
            <div className="space-y-1.5">
              <Label>סטטוס חדש</Label>
              <Select value={status} onValueChange={(v) => v && setStatus(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{{ OPEN: "פתוח", PENDING: "ממתין", RESOLVED: "טופל", CLOSED: "סגור" }[status]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPEN">פתוח</SelectItem>
                  <SelectItem value="PENDING">ממתין</SelectItem>
                  <SelectItem value="RESOLVED">טופל</SelectItem>
                  <SelectItem value="CLOSED">סגור</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {actionType === AutomationActionType.CREATE_TASK && (
            <div className="space-y-1.5">
              <Label>כותרת המשימה</Label>
              <Input aria-label="כותרת המשימה" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="להתקשר ללקוח" />
              <Label>יעד (שעות מהטריגר)</Label>
              <Input aria-label="שעות ליעד" type="number" min={1} value={taskDueHours} onChange={(e) => setTaskDueHours(e.target.value)} />
              <p className="text-xs text-muted-foreground">המשימה תשויך לנציג המשויך לשיחה, ואם אין – לאחראי איש הקשר.</p>
            </div>
          )}
          {actionType === AutomationActionType.SET_CUSTOM_FIELD && (
            <div className="space-y-1.5">
              <Label>שדה מותאם</Label>
              <Input aria-label="שם שדה" value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} placeholder="למשל stage" />
              <Label>ערך</Label>
              <Input aria-label="ערך" value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} />
            </div>
          )}
          {actionType === AutomationActionType.SEND_TEMPLATE && (
            <div className="space-y-1.5">
              <Label>קישור מדיה לכותרת (רק לתבניות עם כותרת תמונה/וידאו/מסמך)</Label>
              <Input aria-label="קישור מדיה" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} dir="ltr" placeholder="https://…" />
            </div>
          )}
          {actionType === AutomationActionType.ADD_INTERNAL_NOTE && (
            <div className="space-y-1.5">
              <Label>תוכן ההערה</Label>
              <Textarea aria-label="תוכן ההערה האוטומטית" value={noteBody} onChange={(e) => setNoteBody(e.target.value)} rows={3} />
            </div>
          )}
          {actionType === AutomationActionType.SEND_CANNED_REPLY && (
            <div className="space-y-1.5">
              <Label>תגובה מוכנה</Label>
              <Select value={cannedReplyId} onValueChange={(v) => v && setCannedReplyId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{cannedReplies.find((reply) => reply.id === cannedReplyId)?.label ?? "בחר תגובה..."}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {cannedReplies.map((reply) => (
                    <SelectItem key={reply.id} value={reply.id}>
                      {reply.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {actionType === AutomationActionType.SEND_TEMPLATE && <div className="space-y-2">{templates.find((t) => t.id === templateId)?.variables?.map((key) => <label key={key} className="block text-sm">משתנה {key}<Input value={variables[key] ?? ""} onChange={(e) => setVariables({ ...variables, [key]: e.target.value })} placeholder="ניתן להשתמש ב־{name} לשם הלקוח" maxLength={1024} /></label>)}</div>}
          {actionType === AutomationActionType.SEND_TEMPLATE && (
            <div className="space-y-1.5">
              <Label>תבנית</Label>
              <Select value={templateId} onValueChange={(v) => { if (v) { setTemplateId(v); setVariables({}); } }}>
                <SelectTrigger className="w-full">
                  <SelectValue>{templates.find((template) => template.id === templateId)?.label ?? "בחר תבנית..."}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="space-y-2 rounded border p-3">
          <label className="block text-sm">שיחה לבדיקה ללא ביצוע (50 השיחות האחרונות)
            <select aria-label="שיחה לבדיקת אוטומציה" className="w-full rounded border p-2" value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
              <option value="">בחר שיחה</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.label}</option>)}
            </select>
          </label>
          <Button variant="outline" onClick={handlePreview} disabled={testing || !conversationId || isSubmitting}>{testing ? "בודק..." : "בדוק ללא ביצוע"}</Button>
          {preview?.input === previewInput && <div role="status" className="space-y-1 text-sm">
            <p>{preview.result.allowedLocally ? "הבדיקות המקומיות עברו" : "הפעולה חסומה לפי הבדיקות המקומיות"}</p>
            {preview.result.reasons.map((reason) => <p key={reason}>{reason}</p>)}
            {preview.result.body && <p className="whitespace-pre-wrap break-words" dir="auto">{preview.result.body}</p>}
            <p>{preview.result.provider}</p>
            {preview.result.delayMinutes > 0 && <p>השהיה מוגדרת: {preview.result.delayMinutes} דקות; הבדיקה בוחנת את המצב כעת</p>}
            <p className="text-muted-foreground">{preview.result.notice}</p>
          </div>}
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />הפעל את החוק לאחר השמירה</label>
          <p className="text-xs text-muted-foreground">ברירת המחדל היא חוק לא פעיל. הבדיקה אינה מפעילה את החוק ואינה שולחת הודעות.</p>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? "שומר..." : "צור חוק"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
