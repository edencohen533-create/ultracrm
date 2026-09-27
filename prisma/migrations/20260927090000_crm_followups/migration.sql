-- "פולואפ" lead status (the scheduled time lives in an open callback task).
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'follow_up';

-- Manager transfer that waits for a live call on the lead to finish.
ALTER TABLE "leads" ADD COLUMN "pending_transfer_at" TIMESTAMP(3),
ADD COLUMN "pending_transfer_by_id" TEXT,
ADD COLUMN "pending_transfer_to_user_id" TEXT;
