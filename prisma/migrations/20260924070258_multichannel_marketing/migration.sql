-- CreateEnum
CREATE TYPE "SequenceTrigger" AS ENUM ('DELIVERY_FAILED', 'SENT_NO_REPLY', 'TAG_ADDED');

-- CreateEnum
CREATE TYPE "SequenceRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'STOPPED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageStatus" ADD VALUE 'BOUNCED';
ALTER TYPE "MessageStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "campaign_recipients" ADD COLUMN     "identifier" TEXT;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "estimate" JSONB,
ADD COLUMN     "last_test_at" TIMESTAMP(3),
ADD COLUMN     "scheduled_timezone" TEXT,
ADD COLUMN     "sender_id" TEXT,
ADD COLUMN     "status_reason" TEXT;

-- AlterTable
ALTER TABLE "contact_emails" ADD COLUMN     "bounced_at" TIMESTAMP(3),
ADD COLUMN     "status" TEXT;

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "email_bounced_at" TIMESTAMP(3),
ADD COLUMN     "email_status" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "bounce_type" TEXT,
ADD COLUMN     "bounced_at" TIMESTAMP(3),
ADD COLUMN     "clicked_at" TIMESTAMP(3),
ADD COLUMN     "complained_at" TIMESTAMP(3),
ADD COLUMN     "cost_amount" DECIMAL(12,6),
ADD COLUMN     "cost_currency" TEXT,
ADD COLUMN     "encoding" TEXT,
ADD COLUMN     "opened_at" TIMESTAMP(3),
ADD COLUMN     "segments" INTEGER,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "to_identifier" TEXT;

-- AlterTable
ALTER TABLE "provider_credentials" ADD COLUMN     "capabilities" JSONB,
ADD COLUMN     "domain_checked_at" TIMESTAMP(3),
ADD COLUMN     "domain_id" TEXT,
ADD COLUMN     "domain_name" TEXT,
ADD COLUMN     "domain_records" JSONB,
ADD COLUMN     "domain_status" TEXT,
ADD COLUMN     "reply_to" TEXT,
ADD COLUMN     "sender_email" TEXT,
ADD COLUMN     "sender_name" TEXT,
ADD COLUMN     "senders" JSONB,
ADD COLUMN     "test_recipients" JSONB,
ADD COLUMN     "unit_price" DECIMAL(12,6),
ADD COLUMN     "unit_price_currency" TEXT;

-- AlterTable
ALTER TABLE "suppressions" ADD COLUMN     "message_id" TEXT,
ADD COLUMN     "pending_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "design" JSONB,
ADD COLUMN     "html" TEXT,
ADD COLUMN     "preheader" TEXT,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "text" TEXT;

-- CreateTable
CREATE TABLE "provider_webhook_events" (
    "id" TEXT NOT NULL,
    "business_id" TEXT,
    "credential_id" TEXT,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB,

    CONSTRAINT "provider_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_sequences" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "SequenceTrigger" NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "stop_on" TEXT[] DEFAULT ARRAY['reply', 'conversion', 'unsubscribe']::TEXT[],
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_steps" (
    "id" TEXT NOT NULL,
    "sequence_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "channel" "Channel" NOT NULL,
    "template_id" TEXT NOT NULL,
    "wait_minutes" INTEGER NOT NULL DEFAULT 0,
    "condition" JSONB NOT NULL DEFAULT '{}',
    "variables" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_runs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "sequence_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "status" "SequenceRunStatus" NOT NULL DEFAULT 'PENDING',
    "next_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "stop_reason" TEXT,
    "log" JSONB NOT NULL DEFAULT '[]',
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sequence_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_webhook_events_business_id_received_at_idx" ON "provider_webhook_events"("business_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_webhook_events_provider_event_id_key" ON "provider_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "marketing_sequences_business_id_trigger_is_active_idx" ON "marketing_sequences"("business_id", "trigger", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_steps_sequence_id_position_key" ON "sequence_steps"("sequence_id", "position");

-- CreateIndex
CREATE INDEX "sequence_runs_business_id_status_next_at_idx" ON "sequence_runs"("business_id", "status", "next_at");

-- CreateIndex
CREATE INDEX "sequence_runs_contact_id_status_idx" ON "sequence_runs"("contact_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_runs_sequence_id_contact_id_source_key_key" ON "sequence_runs"("sequence_id", "contact_id", "source_key");

-- CreateIndex
CREATE INDEX "campaigns_business_id_channel_created_at_idx" ON "campaigns"("business_id", "channel", "created_at");

-- CreateIndex
CREATE INDEX "messages_business_id_channel_created_at_idx" ON "messages"("business_id", "channel", "created_at");

-- CreateIndex
CREATE INDEX "provider_credentials_business_id_channel_is_active_idx" ON "provider_credentials"("business_id", "channel", "is_active");

-- CreateIndex
CREATE INDEX "suppressions_business_id_pending_review_idx" ON "suppressions"("business_id", "pending_review");

-- CreateIndex
CREATE INDEX "templates_business_id_channel_status_idx" ON "templates"("business_id", "channel", "status");

-- AddForeignKey
ALTER TABLE "provider_webhook_events" ADD CONSTRAINT "provider_webhook_events_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_sequences" ADD CONSTRAINT "marketing_sequences_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "marketing_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "marketing_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
