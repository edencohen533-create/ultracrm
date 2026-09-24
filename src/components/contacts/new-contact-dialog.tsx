"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { contactSchema, type ContactInput } from "@/lib/validation/contact";
import { ConsentStatus } from "@/generated/prisma/client";
import { Plus } from "lucide-react";

export function NewContactDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    defaultValues: { name: "", phone: "", email: "", source: "manual", consentStatus: ConsentStatus.UNKNOWN, tagIds: [] },
  });

  async function onSubmit(values: ContactInput) {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(typeof data?.error === "string" ? data.error : "שגיאה בהוספת איש קשר");
        return;
      }

      toast.success("איש הקשר נוסף בהצלחה");
      setOpen(false);
      form.reset();
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="h-4 w-4" /> איש קשר חדש</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>איש קשר חדש</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>שם</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>טלפון</FormLabel>
                  <FormControl>
                    <Input dir="ltr" className="text-left" placeholder="050-1234567" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>אימייל</FormLabel>
                  <FormControl>
                    <Input dir="ltr" className="text-left" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <label className="block space-y-1 text-sm">הסכמה לדיוור
              <select aria-label="הסכמה לדיוור" className="w-full rounded border p-2" {...form.register("consentStatus")}>
                <option value="UNKNOWN">לא ידוע — לא יישלחו קמפיינים</option>
                <option value="OPTED_IN">קיימת הסכמה לקבלת דיוור</option>
                <option value="OPTED_OUT">הוסר מדיוור שיווקי</option>
              </select>
            </label>
            <DialogFooter>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "שומר..." : "שמור"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
