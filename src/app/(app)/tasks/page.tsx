import { redirect } from "next/navigation";

/** Tasks moved into the lead workspace (drawer). */
export default function TasksPage() {
  redirect("/leads?tasks=1");
}
