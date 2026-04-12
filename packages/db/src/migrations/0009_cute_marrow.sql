CREATE TABLE "spend_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"max_xrp_per_tx_drops" text,
	"daily_xrp_limit_drops" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "spend_policies_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "amount_drops" text;--> statement-breakpoint
ALTER TABLE "spend_policies" ADD CONSTRAINT "spend_policies_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;