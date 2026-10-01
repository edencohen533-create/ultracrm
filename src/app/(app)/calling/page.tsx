import { redirect } from "next/navigation";

/** Entering "חייגן" opens its main tab – starting the dialer. */
export default function CallingPage() { redirect("/calling/start"); }
