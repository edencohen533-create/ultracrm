
-- CreateTable
CREATE TABLE "callback_signals" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "user_id" TEXT,
    "message_id" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "analyzer" TEXT NOT NULL DEFAULT 'basic',
    "text" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "callback_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "callback_signals_message_id_key" ON "callback_signals"("message_id");

-- CreateIndex
CREATE INDEX "callback_signals_business_id_user_id_status_idx" ON "callback_signals"("business_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "callback_signals_contact_id_status_idx" ON "callback_signals"("contact_id", "status");

-- AddForeignKey
ALTER TABLE "callback_signals" ADD CONSTRAINT "callback_signals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "callback_signals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "callback_signals" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
