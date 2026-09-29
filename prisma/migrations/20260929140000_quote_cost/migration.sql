ALTER TABLE "sales_quotes" ADD COLUMN "cost_total" INTEGER CHECK (cost_total IS NULL OR cost_total >= 0);
