import { redirect } from "next/navigation";

/** The home screen is the lead workspace; business-wide numbers moved to the managers' reports (/reports). */
export default function DashboardPage() {
  redirect("/leads");
}
