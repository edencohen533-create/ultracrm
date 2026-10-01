CREATE TABLE "auth_rate_limits" (
  "key" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "auth_rate_limits_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "auth_rate_limits_expires_at_idx" ON "auth_rate_limits"("expires_at");
