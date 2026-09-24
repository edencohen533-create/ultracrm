-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "hangup_requested_at" TIMESTAMP(3),
ADD COLUMN     "last_event_at" TIMESTAMP(3),
ADD COLUMN     "lead_dialed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "list_leads" ADD COLUMN     "preferred_user_id" TEXT;
