"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "OPEN", label: "פתוח" },
  { value: "PENDING", label: "ממתין" },
  { value: "RESOLVED", label: "טופל" },
  { value: "CLOSED", label: "סגור" },
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
  const router = useRouter();
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
        toast.error("שגיאה בעדכון הסטטוס");
        return;
      }
      toast.success("הסטטוס עודכן");
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
        toast.error("שגיאה בשיוך השיחה");
        return;
      }
      toast.success("השיוך עודכן");
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
        toast.error("שגיאה בעדכון");
        return;
      }
      toast.success(isSpam ? "הוסר מסימון ספאם" : "סומן כספאם");
      router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b p-2">
      <Select value={status} onValueChange={updateStatus} disabled={isPending}>
        <SelectTrigger aria-label="סטטוס שיחה" className="h-8 w-28 text-sm">
          <SelectValue>{STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={assignedAgentId ?? "unassigned"} onValueChange={updateAssignment} disabled={isPending}>
        <SelectTrigger aria-label="נציג מטפל" className="h-8 w-36 text-sm">
          <SelectValue>{assignedAgentId ? agents.find((agent) => agent.id === assignedAgentId)?.name ?? "נציג משויך" : "לא משויך"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">לא משויך</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex-1" />

      <Button variant={isSpam ? "destructive" : "ghost"} size="sm" onClick={toggleSpam} disabled={isPending}>
        <AlertTriangle className="h-4 w-4" /> {isSpam ? "מסומן כספאם" : "סמן כספאם"}
      </Button>
    </div>
  );
}
