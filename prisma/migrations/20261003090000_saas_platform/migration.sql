-- SaaS platform separation (additive): lifecycle reason / cancel time, support identities, support sessions.
ALTER TABLE "businesses" ADD COLUMN "status_reason" TEXT;
ALTER TABLE "businesses" ADD COLUMN "cancelled_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "is_support" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "support_sessions" (
  "id" TEXT NOT NULL, "business_id" TEXT NOT NULL, "account_id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'read_only', "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expires_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3), "ended_reason" TEXT,
  CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_sessions_business_id_started_at_idx" ON "support_sessions"("business_id", "started_at");
CREATE INDEX "support_sessions_account_id_started_at_idx" ON "support_sessions"("account_id", "started_at");
-- Read through platform code (outside a business scope); like every business_id table it has RLS for the runtime role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultracrm_runtime') THEN
    ALTER TABLE "support_sessions" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON "support_sessions" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
    GRANT SELECT ON "support_sessions" TO ultracrm_runtime;
  END IF;
END $$;
