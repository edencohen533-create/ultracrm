ALTER TABLE "dial_lists" ADD COLUMN     "unanswered_limit" INTEGER;

ALTER TABLE "leads" ADD COLUMN     "close_reason" TEXT;

-- CreateTable
CREATE TABLE "dialer_queue_alerts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "exhausted_count" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "notified_at" TIMESTAMP(3),
    "delivery" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "dialer_queue_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dialer_queue_alerts_business_id_closed_at_opened_at_idx" ON "dialer_queue_alerts"("business_id", "closed_at", "opened_at");

-- CreateIndex
CREATE INDEX "dialer_queue_alerts_list_id_user_id_closed_at_idx" ON "dialer_queue_alerts"("list_id", "user_id", "closed_at");

-- AddForeignKey
ALTER TABLE "dialer_queue_alerts" ADD CONSTRAINT "dialer_queue_alerts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dialer_queue_alerts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dialer_queue_alerts" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
