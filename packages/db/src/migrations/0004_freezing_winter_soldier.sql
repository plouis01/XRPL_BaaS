ALTER TABLE "accounts" ADD COLUMN "funding_tx_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_accounts_funding_tx" ON "accounts" USING btree ("funding_tx_id");