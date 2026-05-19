CREATE TABLE "x402_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" uuid,
	"resource_path" text NOT NULL,
	"payee_address" text NOT NULL,
	"asset_kind" text NOT NULL,
	"asset_key" text,
	"amount" text NOT NULL,
	"destination_tag" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consuming_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x402_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"path_pattern" text NOT NULL,
	"payee_address" text NOT NULL,
	"asset_kind" text NOT NULL,
	"asset_key" text,
	"price_amount" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x402_routes_client_path_uq" UNIQUE("client_id","path_pattern")
);
--> statement-breakpoint
ALTER TABLE "x402_intents" ADD CONSTRAINT "x402_intents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x402_routes" ADD CONSTRAINT "x402_routes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "x402_intents_consuming_tx_hash_uq" ON "x402_intents" USING btree ("consuming_tx_hash") WHERE consuming_tx_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "x402_intents_payee_tag_idx" ON "x402_intents" USING btree ("payee_address","destination_tag");--> statement-breakpoint
CREATE INDEX "x402_intents_expires_at_idx" ON "x402_intents" USING btree ("expires_at");