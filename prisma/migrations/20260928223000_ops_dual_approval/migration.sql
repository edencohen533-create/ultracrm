-- AlterTable
ALTER TABLE "assignment_overrides" ADD COLUMN     "list_id" TEXT,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'share';

-- AlterTable

-- AlterTable
ALTER TABLE "ops_recommendations" ADD COLUMN     "agent_approved_count" INTEGER,
ADD COLUMN     "agent_asked_at" TIMESTAMP(3),
ADD COLUMN     "agent_reply" TEXT,
ADD COLUMN     "agent_responded_at" TIMESTAMP(3),
ADD COLUMN     "manager_approved_count" INTEGER,
ADD COLUMN     "requested_count" INTEGER,
ALTER COLUMN "status" SET DEFAULT 'pending_manager';

