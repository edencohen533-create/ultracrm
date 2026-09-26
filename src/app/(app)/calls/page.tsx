import { redirect } from "next/navigation";

/** "שיחות" is WhatsApp-only now; missed/recent phone calls live in the leads drawer (משימות וחזרות → שיחות שלא נענו). */
export default async function CallsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tasks: "1", view: "calls" });
  if (sp.missed === "1") q.set("missed", "1");
  redirect(`/leads?${q.toString()}`);
}
