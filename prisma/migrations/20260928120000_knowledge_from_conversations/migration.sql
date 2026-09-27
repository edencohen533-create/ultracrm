
ALTER TABLE "knowledge_sources" ADD COLUMN     "conflicts" JSONB,
ADD COLUMN     "learn_mode" TEXT,
ADD COLUMN     "source_conversation_id" TEXT,
ADD COLUMN     "structured" JSONB,
ADD COLUMN     "supersedes_id" TEXT;

-- CreateIndex
CREATE INDEX "knowledge_sources_business_id_source_conversation_id_idx" ON "knowledge_sources"("business_id", "source_conversation_id");
