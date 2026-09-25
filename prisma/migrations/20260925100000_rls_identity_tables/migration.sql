-- Identity tables under RLS as well: the runtime role must not be able to read every account's password hash or
-- every business's settings from inside a tenant scope. Login / switch / cron run without a scope (owner role).
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "accounts";
CREATE POLICY tenant_isolation ON "accounts" TO ultracrm_runtime
  USING ("id" = current_setting('app.account_id', true)
      OR EXISTS (SELECT 1 FROM "users" u WHERE u."account_id" = "accounts"."id" AND u."business_id" = current_setting('app.business_id', true)))
  WITH CHECK ("id" = current_setting('app.account_id', true)
      OR EXISTS (SELECT 1 FROM "users" u WHERE u."account_id" = "accounts"."id" AND u."business_id" = current_setting('app.business_id', true)));

ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "businesses";
-- the current business, plus the other businesses the signed-in account belongs to (business switcher)
CREATE POLICY tenant_isolation ON "businesses" TO ultracrm_runtime
  USING ("id" = current_setting('app.business_id', true)
      OR EXISTS (SELECT 1 FROM "users" u WHERE u."business_id" = "businesses"."id" AND u."account_id" = current_setting('app.account_id', true)))
  WITH CHECK ("id" = current_setting('app.business_id', true));
