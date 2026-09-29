import { PublicOffer } from "@/components/sales/PublicOffer";
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <PublicOffer token={(await params).token} />;
}
