-- CreateEnum
CREATE TYPE "CoachSpeaker" AS ENUM ('customer', 'agent', 'unknown');

-- CreateEnum
CREATE TYPE "CoachSegmentSource" AS ENUM ('browser_stt', 'simulation', 'recording', 'telnyx_stream');

-- CreateEnum
CREATE TYPE "CoachSessionStatus" AS ENUM ('listening', 'analyzing', 'ready', 'unavailable', 'ended');

-- CreateEnum
CREATE TYPE "CoachExampleStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "CoachOutcome" AS ENUM ('won', 'lost', 'unknown');

-- DropForeignKey

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "coach_enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "coach_knowledge" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "audience" TEXT NOT NULL DEFAULT '',
    "products" JSONB NOT NULL DEFAULT '[]',
    "benefits" JSONB NOT NULL DEFAULT '[]',
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "forbidden_claims" JSONB NOT NULL DEFAULT '[]',
    "style" TEXT NOT NULL DEFAULT '',
    "call_goal" TEXT NOT NULL DEFAULT '',
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_sessions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "lead_id" TEXT,
    "status" "CoachSessionStatus" NOT NULL DEFAULT 'listening',
    "summary" TEXT NOT NULL DEFAULT '',
    "stage" TEXT,
    "customer_goal" TEXT,
    "last_objection" TEXT,
    "promises" JSONB NOT NULL DEFAULT '[]',
    "segments_count" INTEGER NOT NULL DEFAULT 0,
    "last_segment_at" TIMESTAMP(3),
    "stt_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,5) NOT NULL DEFAULT 0,
    "latency_ms_total" INTEGER NOT NULL DEFAULT 0,
    "latency_samples" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_segments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "speaker" "CoachSpeaker" NOT NULL DEFAULT 'unknown',
    "text" TEXT NOT NULL,
    "start_ms" INTEGER,
    "end_ms" INTEGER,
    "source" "CoachSegmentSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_recommendations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "objection" TEXT,
    "say_now" TEXT NOT NULL,
    "why" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stage" TEXT,
    "basis" TEXT NOT NULL DEFAULT 'knowledge_only',
    "sources" JSONB NOT NULL DEFAULT '{}',
    "trigger_segment_id" TEXT,
    "latency_ms" INTEGER,
    "shown_at" TIMESTAMP(3),
    "feedback" TEXT,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_examples" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "call_id" TEXT,
    "session_id" TEXT,
    "deal_id" TEXT,
    "lead_id" TEXT,
    "user_id" TEXT,
    "objection" TEXT NOT NULL,
    "agent_response" TEXT NOT NULL,
    "edited_response" TEXT,
    "stage" TEXT,
    "product" TEXT,
    "outcome" "CoachOutcome" NOT NULL DEFAULT 'unknown',
    "quote" TEXT NOT NULL DEFAULT '',
    "segment_ids" JSONB NOT NULL DEFAULT '[]',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "embedding" JSONB,
    "status" "CoachExampleStatus" NOT NULL DEFAULT 'pending',
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_examples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coach_knowledge_business_id_key" ON "coach_knowledge"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_sessions_call_id_key" ON "coach_sessions"("call_id");

-- CreateIndex
CREATE INDEX "coach_sessions_business_id_created_at_idx" ON "coach_sessions"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "coach_segments_session_id_created_at_idx" ON "coach_segments"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "coach_segments_business_id_idx" ON "coach_segments"("business_id");

-- CreateIndex
CREATE INDEX "coach_recommendations_session_id_created_at_idx" ON "coach_recommendations"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "coach_recommendations_business_id_created_at_idx" ON "coach_recommendations"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "coach_examples_business_id_status_idx" ON "coach_examples"("business_id", "status");

-- CreateIndex
CREATE INDEX "coach_examples_call_id_idx" ON "coach_examples"("call_id");

-- AddForeignKey

-- AddForeignKey
ALTER TABLE "coach_knowledge" ADD CONSTRAINT "coach_knowledge_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_sessions" ADD CONSTRAINT "coach_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_sessions" ADD CONSTRAINT "coach_sessions_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_segments" ADD CONSTRAINT "coach_segments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "coach_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_recommendations" ADD CONSTRAINT "coach_recommendations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "coach_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_examples" ADD CONSTRAINT "coach_examples_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security for the coach tables (tenant isolation at the database, see db-rls.ts).
ALTER TABLE "coach_knowledge" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coach_knowledge" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "coach_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coach_sessions" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "coach_segments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coach_segments" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "coach_recommendations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coach_recommendations" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
ALTER TABLE "coach_examples" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coach_examples" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
