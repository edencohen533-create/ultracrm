-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "claimed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "invite_expires_at" TIMESTAMP(3),
ADD COLUMN     "invite_token_hash" TEXT,
ADD COLUMN     "invited_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_invite_token_hash_key" ON "users"("invite_token_hash");

-- Existing accounts were set up by their users (or before invites existed): treat them as claimed.
UPDATE "accounts" SET "claimed_at" = "created_at" WHERE "claimed_at" IS NULL;

-- One ACTIVE row per phone number across all businesses: inbound routing can never be split or diverted by a second
-- business registering the same number (checked in the API too; this is the database guarantee).
CREATE UNIQUE INDEX IF NOT EXISTS "phone_numbers_e164_active_key" ON "phone_numbers"("e164") WHERE "is_active";
