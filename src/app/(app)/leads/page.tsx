"use client";

import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { LeadsWorkspace } from "@/components/leads/LeadsWorkspace";

export default function LeadsPage() { return <Suspense fallback={<div className="p-10"><Spinner /></div>}><LeadsWorkspace /></Suspense>; }
