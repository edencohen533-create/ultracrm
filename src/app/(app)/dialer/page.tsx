import { redirect } from "next/navigation";

/** The dialer lives inside the leads workspace now ("הפעל חייגן"). */
export default function DialerPage() {
  redirect("/leads");
}
