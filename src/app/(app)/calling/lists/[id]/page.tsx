import { ListQueuePanel } from "@/components/lists/ListQueuePanel";

export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListQueuePanel id={id} />;
}
