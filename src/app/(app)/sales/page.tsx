import { SalesWorkspace } from "@/components/sales/SalesWorkspace";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  return <SalesWorkspace initialLeadId={(await searchParams).leadId ?? ""} />;
}
