import { redirect } from "next/navigation";

/** Tasks moved into the lead workspace (drawer). Deep links keep their filters: /tasks?type=callback&due=today → /leads?tasks=1&type=callback&due=today */
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tasks: "1" });
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) q.set(k, v);
  redirect(`/leads?${q.toString()}`);
}
