import { redirect } from "next/navigation";

/** Entering "חייגן" opens the dial lists tab. */
export default function CallingPage() { redirect("/calling/lists"); }
