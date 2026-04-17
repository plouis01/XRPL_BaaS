CREATE TABLE "account_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"asset_kind" text NOT NULL,
	"asset_key" text NOT NULL,
	"balance" text DEFAULT '0' NOT NULL,
	"ledger_index" bigint,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uniq_balance_address_asset" UNIQUE("address","asset_kind","asset_key")
);
--> statement-breakpoint
CREATE TABLE "amm_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset1_kind" text NOT NULL,
	"asset1_key" text NOT NULL,
	"asset2_kind" text NOT NULL,
	"asset2_key" text NOT NULL,
	"asset1_balance" text DEFAULT '0' NOT NULL,
	"asset2_balance" text DEFAULT '0' NOT NULL,
	"lp_token_balance" text DEFAULT '0' NOT NULL,
	"trading_fee" integer DEFAULT 0 NOT NULL,
	"ledger_index" bigint,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uniq_amm_pair" UNIQUE("asset1_kind","asset1_key","asset2_kind","asset2_key")
);
--> statement-breakpoint
CREATE TABLE "offer_book" (
	"account" text NOT NULL,
	"sequence" bigint NOT NULL,
	"taker_pays" jsonb NOT NULL,
	"taker_gets" jsonb NOT NULL,
	"pair_key" text NOT NULL,
	"domain_id" text,
	"ledger_index" bigint,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pk_offer_account_sequence" UNIQUE("account","sequence")
);
--> statement-breakpoint
CREATE TABLE "processed_transactions" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"ledger_index" bigint NOT NULL,
	"tx_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_account_balances_address" ON "account_balances" USING btree ("address");--> statement-breakpoint
CREATE INDEX "idx_offer_pair" ON "offer_book" USING btree ("pair_key");--> statement-breakpoint
CREATE INDEX "idx_processed_tx_ledger" ON "processed_transactions" USING btree ("ledger_index");