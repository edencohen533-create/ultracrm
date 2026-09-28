"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { LearnFromConversation } from "./LearnFromConversation";
import { useT } from "@/components/i18n/LangProvider";

const STATUS_OPTIONS = [
  { value: "OPEN", label: "פתוח", en: "Open" },
  { value: "PENDING", label: "ממתין", en: "Pending" },
  { value: "RESOLVED", label: "טופל", en: "Resolved" },
  { value: "CLOSED", label: "סגור", en: "Closed" },
];

interface Agent {
  id: string;
  name: string;
}

export function ConversationActions({
  conversationId,
  status,
  assignedAgentId,
  agents,
  isSpam,
}: {
  conversationId: string;
  status: string;
  assignedAgentId: string | null;
  agents: Agent[];
  isSpam: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const statusOption = STATUS_OPTIONS.find((option) => option.value === status);
  const [isPending, setIsPending] = useState(false);

  async function updateStatus(value: string | null) {
    if (!value) return;
    setIsPending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: value }),
      });
      if (!res.ok) {
        toast.error(t("שגיאה בעדכון הסטטוס", "Failed to update status"));
        return;
      }
      toast.success(t("הסטטוס עודכן", "Status updated"));
      router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  async function updateAssignment(value: string | null) {
    setIsPending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/assign`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: value === "unassigned" ? null : value }),
      });
      if (!res.ok) {
        toast.error(t("שגיאה בשיוך השיחה", "Failed to assign conversation"));
        return;
      }
      toast.success(t("השיוך עודכן", "Assignment updated"));
      router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  async function toggleSpam() {
    setIsPending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isSpam: !isSpam }),
      });
      if (!res.ok) {
        toast.error(t("שגיאה בעדכון", "Update failed"));
        return;
      }
      toast.success(isSpam ? t("הוסר מסימון ספאם", "Unmarked as spam") : t("סומן כספאם", "Marked as spam"));
      router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b p-2">
      <Select value={status} onValueChange={updateStatus} disabled={isPending}>
        <SelectTrigger aria-label={t("סטטוס שיחה", "Conversation status")} className="h-8 w-28 text-sm">
          <SelectValue>{statusOption ? t(statusOption.label, statusOption.en) : status}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.label, option.en)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={assignedAgentId ?? "unassigned"} onValueChange={updateAssignment} disabled={isPending}>
        <SelectTrigger aria-label={t("נציג מטפל", "Assigned agent")} className="h-8 w-36 text-sm">
          <SelectValue>{assignedAgentId ? agents.find((agent) => agent.id === assignedAgentId)?.name ?? t("נציג משויך", "Assigned agent") : t("לא משויך", "Unassigned")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">{t("לא משויך", "Unassigned")}</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex-1" />
      <LearnFromConversation conversationId={conversationId} />

      <Button variant={isSpam ? "destructive" : "ghost"} size="sm" onClick={toggleSpam} disabled={isPending}>
        <AlertTriangle className="h-4 w-4" /> {isSpam ? t("מסומן כספאם", "Marked as spam") : t("סמן כספאם", "Mark as spam")}
      </Button>
    </div>
  );
}
