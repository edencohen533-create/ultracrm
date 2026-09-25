-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AutomationActionType" ADD VALUE 'CREATE_TASK';
ALTER TYPE "AutomationActionType" ADD VALUE 'SET_CUSTOM_FIELD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SequenceTrigger" ADD VALUE 'CONTACT_CREATED';
ALTER TYPE "SequenceTrigger" ADD VALUE 'LEAD_STATUS_CHANGED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TemplateStatus" ADD VALUE 'PAUSED';
ALTER TYPE "TemplateStatus" ADD VALUE 'DISABLED';

-- AlterTable
ALTER TABLE "campaign_recipients" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "button_params" JSONB,
ADD COLUMN     "media_url" TEXT,
ADD COLUMN     "preflight_snapshot" JSONB;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "error_code" TEXT,
ADD COLUMN     "retryable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "sequence_steps" ADD COLUMN     "action" TEXT NOT NULL DEFAULT 'send';

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "buttons" JSONB,
ADD COLUMN     "components" JSONB,
ADD COLUMN     "header_format" TEXT;

