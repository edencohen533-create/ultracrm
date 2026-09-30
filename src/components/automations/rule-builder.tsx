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
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import { useT } from "@/components/i18n/LangProvider";

/** "סטטוס CRM השתנה" is a contact-level trigger – saved on the customer-journey engine (LEAD_STATUS_CHANGED). */
const CRM_STATUS = "CRM_STATUS_CHANGED" as const;
type TriggerChoice = AutomationTrigger | typeof CRM_STATUS;
const TRIGGER_LABELS: Record<TriggerChoice, [string, string]> = {
  CRM_STATUS_CHANGED: ["סטטוס CRM השתנה", "CRM status changed"],
  NEW_INBOUND_MESSAGE: ["הודעה נכנסת חדשה", "New inbound message"],
  NEW_CONVERSATION: ["שיחה חדשה", "New conversation"],
  TAG_ADDED: ["תגית נוספה", "Tag added"],
  CONVERSATION_UNASSIGNED: ["שיחה לא משויכת", "Unassigned conversation"],
  NO_REPLY_TIMEOUT: ["אין מענה תוך X דקות", "No reply within X minutes"],
};

const ACTION_LABELS: Record<AutomationActionType, [string, string]> = {
  ASSIGN_AGENT: ["שיוך לנציג", "Assign to agent"],
  ADD_TAG: ["הוספת תגית", "Add tag"],
  CHANGE_STATUS: ["שינוי סטטוס", "Change status"],
  ADD_INTERNAL_NOTE: ["הוספת הערה פנימית", "Add internal note"],
  SEND_CANNED_REPLY: ["שליחת תגובה מוכנה", "Send canned reply"],
  SEND_TEMPLATE: ["שליחת תבנית", "Send template"],
  CREATE_TASK: ["יצירת משימת מעקב", "Create follow-up task"],
  SET_CUSTOM_FIELD: ["עדכון שדה מותאם", "Update custom field"],
};

const CONV_STATUS: Record<string, [string, string]> = { OPEN: ["פתוח", "Open"], PENDING: ["ממתין", "Pending"], RESOLVED: ["טופל", "Resolved"], CLOSED: ["סגור", "Closed"] };

interface Option {
  id: string;
  label: string;
  variables?: string[];
}

export function RuleBuilder({ agents, cannedReplies, templates, conversations }: { agents: Option[]; cannedReplies: Option[]; templates: Option[]; conversations: Option[] }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<TriggerChoice>(AutomationTrigger.NEW_INBOUND_MESSAGE);
  const statuses = useLeadStatuses();
  const [leadStatus, setLeadStatus] = useState("");
  const [waitMinutes, setWaitMinutes] = useState(0);
  const crm = trigger === CRM_STATUS;
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
      if (!response.ok) { toast.error(typeof result.error === "string" ? result.error : t("פרטי הבדיקה אינם תקינים", "Invalid test details")); return; }
      setPreview({ input, result });
    } catch { toast.error(t("הבדיקה נכשלה. יש לבדוק את החיבור ולנסות שוב", "Test failed. Check your connection and try again")); }
    finally { setTesting(false); }
  }

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error(t("נא להזין שם לחוק", "Please enter a rule name"));
      return;
    }
    if (crm) {
      const tpl = templates.find((x) => x.id === templateId);
      if (!leadStatus || !tpl) { toast.error(t("יש לבחור סטטוס ותבנית WhatsApp", "Choose a status and a WhatsApp template")); return; }
      if ((tpl.variables ?? []).some((k) => !variables[k]?.trim())) { toast.error(t("יש למלא את כל משתני התבנית", "Fill in all template variables")); return; }
      setIsSubmitting(true);
      try {
        const res = await fetch("/api/sequences", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, isActive, trigger: "LEAD_STATUS_CHANGED", triggerConfig: { leadStatus }, stopOn: [], steps: [{ action: "send", channel: "whatsapp", templateId, waitMinutes, variables, condition: { requireNoReply: false } }] }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); toast.error(j.error ?? t("שגיאה ביצירת החוק", "Error creating rule")); return; }
        toast.success(isActive ? t("החוק נוצר והופעל", "Rule created and enabled") : t("החוק נוצר (לא פעיל)", "Rule created (inactive)")); setOpen(false); router.refresh();
      } catch { toast.error(t("שמירת החוק נכשלה", "Saving the rule failed")); } finally { setIsSubmitting(false); }
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
        toast.error(t("שגיאה ביצירת החוק", "Error creating rule"));
        return;
      }
      toast.success(t("החוק נוצר בהצלחה", "Rule created successfully"));
      setOpen(false);
      router.refresh();
    } catch { toast.error(t("שמירת החוק נכשלה. יש לבדוק את החיבור ולנסות שוב", "Saving the rule failed. Check your connection and try again")); }
    finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="h-4 w-4" /> {t("חוק אוטומציה חדש", "New automation rule")}</Button>} />
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="ps-8">{t("חוק אוטומציה חדש", "New automation rule")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("שם החוק", "Rule name")}</Label>
            <Input aria-label={t("שם חוק האוטומציה", "Automation rule name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("לדוגמה: שיוך אוטומטי ללקוחות VIP", "e.g. Auto-assign VIP customers")} />
          </div>

          <div className="space-y-1.5">
            <Label>{t("טריגר", "Trigger")}</Label>
            <Select value={trigger} onValueChange={(v) => { if (!v) return; setTrigger(v as TriggerChoice); if (v === CRM_STATUS) setActionType(AutomationActionType.SEND_TEMPLATE); }}>
              <SelectTrigger className="w-full">
                <SelectValue>{t(...TRIGGER_LABELS[trigger])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {t(...label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {crm && (
            <div className="space-y-1.5 rounded border p-3" data-testid="crm-status-trigger">
              <Label>{t("כשסטטוס הליד משתנה ל", "When the lead status changes to")}</Label>
              <select aria-label={t("סטטוס CRM", "CRM status")} className="w-full rounded border p-2" value={leadStatus} onChange={(e) => setLeadStatus(e.target.value)} data-testid="rule-lead-status"><option value="">{t("בחר סטטוס", "Choose status")}</option>{statuses.items.filter((st) => st.active || (st.isSystem ? st.kind : st.id) === leadStatus).map((st) => <option key={st.id} value={st.isSystem ? st.kind : st.id}>{st.label}</option>)}</select>
              <Label>{t("לשלוח ללקוח", "Send to customer")}</Label>
              <select aria-label={t("המתנה", "Delay")} className="w-full rounded border p-2" value={waitMinutes} onChange={(e) => setWaitMinutes(Number(e.target.value))}><option value={0}>{t("מיד", "Immediately")}</option><option value={5}>{t("אחרי 5 דקות", "After 5 minutes")}</option><option value={30}>{t("אחרי חצי שעה", "After 30 minutes")}</option><option value={60}>{t("אחרי שעה", "After 1 hour")}</option><option value={1440}>{t("אחרי יום", "After 1 day")}</option></select>
              <p className="text-xs text-muted-foreground">{t("פעולה: שליחת תבנית WhatsApp מאושרת ללקוח של הליד (רק אם לא הסיר את עצמו מדיוור). במשתנים אפשר לכתוב", "Action: send an approved WhatsApp template to the lead's customer (only if they have not unsubscribed). In variables you can write")} {"{name}"} {t("לשם הלקוח.", "for the customer's name.")}</p>
            </div>
          )}
          {!crm && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyOutsideHours} onChange={(e) => setOnlyOutsideHours(e.target.checked)} />{t("להפעיל רק מחוץ לשעות הפעילות (חלון השליחה בהגדרות → דיוור)", "Run only outside business hours (send window in Settings → Messaging)")}</label>}
          {trigger === AutomationTrigger.NO_REPLY_TIMEOUT && (
            <div className="space-y-1.5">
              <Label>{t("דקות ללא מענה", "Minutes without reply")}</Label>
              <Input type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
          )}
          {trigger === AutomationTrigger.TAG_ADDED && (
            <div className="space-y-1.5">
              <Label>{t("שם התגית (השאר ריק לכל תגית)", "Tag name (leave empty for any tag)")}</Label>
              <Input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="VIP" />
            </div>
          )}

          <div className={crm ? "hidden" : "space-y-1.5"}>
            <Label>{t("פעולה", "Action")}</Label>
            <Select value={actionType} onValueChange={(v) => v && setActionType(v as AutomationActionType)}>
              <SelectTrigger className="w-full" aria-label={t("פעולת האוטומציה", "Automation action")}>
                <SelectValue>{t(...ACTION_LABELS[actionType])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ACTION_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {t(...label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {actionType === AutomationActionType.ASSIGN_AGENT && (
            <div className="space-y-1.5">
              <Label>{t("נציג", "Agent")}</Label>
              <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{agents.find((agent) => agent.id === agentId)?.label ?? t("בחר נציג...", "Choose agent...")}</SelectValue>
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
              <Label>{t("שם התגית להוספה", "Tag name to add")}</Label>
              <Input value={actionTagName} onChange={(e) => setActionTagName(e.target.value)} />
            </div>
          )}
          {actionType === AutomationActionType.CHANGE_STATUS && (
            <div className="space-y-1.5">
              <Label>{t("סטטוס חדש", "New status")}</Label>
              <Select value={status} onValueChange={(v) => v && setStatus(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{CONV_STATUS[status] ? t(...CONV_STATUS[status]) : status}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPEN">{t("פתוח", "Open")}</SelectItem>
                  <SelectItem value="PENDING">{t("ממתין", "Pending")}</SelectItem>
                  <SelectItem value="RESOLVED">{t("טופל", "Resolved")}</SelectItem>
                  <SelectItem value="CLOSED">{t("סגור", "Closed")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {actionType === AutomationActionType.CREATE_TASK && (
            <div className="space-y-1.5">
              <Label>{t("כותרת המשימה", "Task title")}</Label>
              <Input aria-label={t("כותרת המשימה", "Task title")} value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder={t("להתקשר ללקוח", "Call the customer")} />
              <Label>{t("יעד (שעות מהטריגר)", "Due (hours after trigger)")}</Label>
              <Input aria-label={t("שעות ליעד", "Hours until due")} type="number" min={1} value={taskDueHours} onChange={(e) => setTaskDueHours(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t("המשימה תשויך לנציג המשויך לשיחה, ואם אין – לאחראי איש הקשר.", "The task is assigned to the conversation's agent, or if none – to the contact owner.")}</p>
            </div>
          )}
          {actionType === AutomationActionType.SET_CUSTOM_FIELD && (
            <div className="space-y-1.5">
              <Label>{t("שדה מותאם", "Custom field")}</Label>
              <Input aria-label={t("שם שדה", "Field name")} value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} placeholder={t("למשל stage", "e.g. stage")} />
              <Label>{t("ערך", "Value")}</Label>
              <Input aria-label={t("ערך", "Value")} value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} />
            </div>
          )}
          {actionType === AutomationActionType.SEND_TEMPLATE && (
            <div className="space-y-1.5">
              <Label>{t("קישור מדיה לכותרת (רק לתבניות עם כותרת תמונה/וידאו/מסמך)", "Header media URL (only for templates with an image/video/document header)")}</Label>
              <Input aria-label={t("קישור מדיה", "Media URL")} value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} dir="ltr" placeholder="https://…" />
            </div>
          )}
          {actionType === AutomationActionType.ADD_INTERNAL_NOTE && (
            <div className="space-y-1.5">
              <Label>{t("תוכן ההערה", "Note content")}</Label>
              <Textarea aria-label={t("תוכן ההערה האוטומטית", "Automatic note content")} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} rows={3} />
            </div>
          )}
          {actionType === AutomationActionType.SEND_CANNED_REPLY && (
            <div className="space-y-1.5">
              <Label>{t("תגובה מוכנה", "Canned reply")}</Label>
              <Select value={cannedReplyId} onValueChange={(v) => v && setCannedReplyId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{cannedReplies.find((reply) => reply.id === cannedReplyId)?.label ?? t("בחר תגובה...", "Choose reply...")}</SelectValue>
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
          {actionType === AutomationActionType.SEND_TEMPLATE && <div className="space-y-2">{templates.find((x) => x.id === templateId)?.variables?.map((key) => <label key={key} className="block text-sm">{t("משתנה", "Variable")} {key}<Input value={variables[key] ?? ""} onChange={(e) => setVariables({ ...variables, [key]: e.target.value })} placeholder={t("ניתן להשתמש ב־{name} לשם הלקוח", "You can use {name} for the customer's name")} maxLength={1024} /></label>)}</div>}
          {actionType === AutomationActionType.SEND_TEMPLATE && (
            <div className="space-y-1.5">
              <Label>{t("תבנית", "Template")}</Label>
              <Select value={templateId} onValueChange={(v) => { if (v) { setTemplateId(v); setVariables({}); } }}>
                <SelectTrigger className="w-full">
                  <SelectValue>{templates.find((template) => template.id === templateId)?.label ?? t("בחר תבנית...", "Choose template...")}</SelectValue>
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
          {crm ? <p className="text-sm text-muted-foreground">{t("החוק יופיע ברשימת \"מסעות לקוח\" ויפעל על כל ליד שעובר לסטטוס שנבחר.", "The rule will appear in the \"Customer journeys\" list and run on every lead that moves to the selected status.")}</p> : <>
          <label className="block text-sm">{t("שיחה לבדיקה ללא ביצוע (50 השיחות האחרונות)", "Conversation for a dry-run test (last 50 conversations)")}
            <select aria-label={t("שיחה לבדיקת אוטומציה", "Conversation for automation test")} className="w-full rounded border p-2" value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
              <option value="">{t("בחר שיחה", "Choose conversation")}</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.label}</option>)}
            </select>
          </label>
          <Button variant="outline" onClick={handlePreview} disabled={testing || !conversationId || isSubmitting}>{testing ? t("בודק...", "Testing...") : t("בדוק ללא ביצוע", "Dry-run test")}</Button>
          {preview?.input === previewInput && <div role="status" className="space-y-1 text-sm">
            <p>{preview.result.allowedLocally ? t("הבדיקות המקומיות עברו", "Local checks passed") : t("הפעולה חסומה לפי הבדיקות המקומיות", "The action is blocked by local checks")}</p>
            {preview.result.reasons.map((reason) => <p key={reason}>{reason}</p>)}
            {preview.result.body && <p className="whitespace-pre-wrap break-words" dir="auto">{preview.result.body}</p>}
            <p>{preview.result.provider}</p>
            {preview.result.delayMinutes > 0 && <p>{t(`השהיה מוגדרת: ${preview.result.delayMinutes} דקות; הבדיקה בוחנת את המצב כעת`, `Configured delay: ${preview.result.delayMinutes} minutes; the test checks the current state`)}</p>}
            <p className="text-muted-foreground">{preview.result.notice}</p>
          </div>}
          </>}
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />{t("הפעל את החוק לאחר השמירה", "Enable the rule after saving")}</label>
          <p className="text-xs text-muted-foreground">{t("ברירת המחדל היא חוק לא פעיל. הבדיקה אינה מפעילה את החוק ואינה שולחת הודעות.", "Rules are inactive by default. The test does not run the rule or send messages.")}</p>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? t("שומר...", "Saving...") : t("צור חוק", "Create rule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
