-- עוזר AI: chat threads, actions/approvals, incidents, business knowledge (+ full-text search), customer-service mode on conversations, CALL_UNANSWERED trigger.
-- AlterEnum
ALTER TYPE "SequenceTrigger" ADD VALUE 'CALL_UNANSWERED';
-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "ai_handoff_at" TIMESTAMP(3),
ADD COLUMN     "ai_handoff_reason" TEXT,
ADD COLUMN     "ai_handoff_summary" TEXT,
ADD COLUMN     "ai_mode" TEXT;
-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'שיחה חדשה',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ai_actions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "incident_id" TEXT,
    "requested_by_id" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'app',
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL,
    "impact" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "before" JSONB,
    "result" JSONB,
    "error" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMP(3),
    CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ai_incidents" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "module" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "verification" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_incidents_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'internal',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "processing" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "created_by_id" TEXT,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "ai_conversations_business_id_user_id_updated_at_idx" ON "ai_conversations"("business_id", "user_id", "updated_at");
-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_created_at_idx" ON "ai_messages"("conversation_id", "created_at");
-- CreateIndex
CREATE INDEX "ai_actions_business_id_created_at_idx" ON "ai_actions"("business_id", "created_at");
-- CreateIndex
CREATE UNIQUE INDEX "ai_actions_business_id_dedupe_key_key" ON "ai_actions"("business_id", "dedupe_key");
-- CreateIndex
CREATE INDEX "ai_incidents_business_id_created_at_idx" ON "ai_incidents"("business_id", "created_at");
-- CreateIndex
CREATE INDEX "knowledge_sources_business_id_status_audience_idx" ON "knowledge_sources"("business_id", "status", "audience");
-- CreateIndex
CREATE INDEX "knowledge_chunks_business_id_idx" ON "knowledge_chunks"("business_id");
-- CreateIndex
CREATE INDEX "knowledge_chunks_source_id_idx" ON "knowledge_chunks"("source_id");
-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "ai_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ai_incidents" ADD CONSTRAINT "ai_incidents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search over knowledge chunks ('simple' config: works for Hebrew tokens without stemming).
ALTER TABLE "knowledge_chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED;
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING GIN ("tsv");

ALTER TABLE "ai_conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_conversations" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "ai_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_messages" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "ai_actions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_actions" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "ai_incidents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ai_incidents" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "knowledge_sources" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "knowledge_chunks" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
