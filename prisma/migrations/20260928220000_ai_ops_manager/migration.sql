
-- CreateTable
CREATE TABLE "ops_rules" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_text" TEXT,
    "config" JSONB NOT NULL,
    "autonomy" TEXT NOT NULL DEFAULT 'recommend',
    "status" TEXT NOT NULL DEFAULT 'active',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "expires_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_recommendations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "rule_id" TEXT,
    "kind" TEXT NOT NULL,
    "agent_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "proposal" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_via" TEXT,
    "result" JSONB,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_overrides" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "recommendation_id" TEXT,
    "agent_id" TEXT NOT NULL,
    "share_pct" INTEGER NOT NULL,
    "lead_limit" INTEGER NOT NULL,
    "source" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "assigned" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_rules_business_id_kind_status_idx" ON "ops_rules"("business_id", "kind", "status");

-- CreateIndex
CREATE INDEX "ops_recommendations_business_id_status_created_at_idx" ON "ops_recommendations"("business_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ops_recommendations_business_id_dedupe_key_key" ON "ops_recommendations"("business_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_overrides_recommendation_id_key" ON "assignment_overrides"("recommendation_id");

-- CreateIndex
CREATE INDEX "assignment_overrides_business_id_status_idx" ON "assignment_overrides"("business_id", "status");

-- AddForeignKey
ALTER TABLE "ops_rules" ADD CONSTRAINT "ops_rules_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_recommendations" ADD CONSTRAINT "ops_recommendations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_overrides" ADD CONSTRAINT "assignment_overrides_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ops_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ops_rules" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));

ALTER TABLE "ops_recommendations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ops_recommendations" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));

ALTER TABLE "assignment_overrides" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "assignment_overrides" TO ultracrm_runtime USING ("business_id" = current_setting('app.business_id', true)) WITH CHECK ("business_id" = current_setting('app.business_id', true));
