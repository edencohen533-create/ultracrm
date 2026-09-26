import { CampaignReport } from "@/components/campaigns/campaign-report";

export default async function CampaignReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignReport id={id} />;
}
