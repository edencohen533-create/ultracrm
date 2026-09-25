import { redirect } from "next/navigation";

/** Dialer settings open from the leads screen ("הגדרות חייגן"). */
export default function CrmSettingsPage() {
  redirect("/leads?settings=1");
}
