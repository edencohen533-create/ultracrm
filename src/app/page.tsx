import { redirect } from "next/navigation";
import { getSessionFromCookies } from "@/lib/auth";

export default async function RootPage() {
  const s = await getSessionFromCookies();
  if (!s) redirect("/login");
  redirect(s.role === "agent" ? "/dialer" : "/manager");
}
