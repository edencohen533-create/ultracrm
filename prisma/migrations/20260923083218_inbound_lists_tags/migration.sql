-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('outbound', 'inbound');

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "direction" "CallDirection" NOT NULL DEFAULT 'outbound',
ADD COLUMN     "routing_note" TEXT;

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "dial_lists" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "is_dynamic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_paused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_refreshed_at" TIMESTAMP(3),
ADD COLUMN     "phone_number_id" TEXT;

-- AlterTable
ALTER TABLE "list_leads" ADD COLUMN     "claim_reason" TEXT,
ADD COLUMN     "claim_score" DOUBLE PRECISION;

-- AddForeignKey
ALTER TABLE "dial_lists" ADD CONSTRAINT "dial_lists_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
