import { CampaignWizard } from "@/components/campaigns/wizard/campaign-wizard";

/** Full-screen campaign builder (info → audience → template → content → review). */
export default async function CampaignWizardPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  return <CampaignWizard draftId={draftId} />;
}
