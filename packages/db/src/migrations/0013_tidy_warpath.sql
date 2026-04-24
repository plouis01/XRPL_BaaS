CREATE TABLE "agent_allowlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"entry_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uniq_agent_allowlist" UNIQUE("agent_id","entry_type","entry_value")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"parent_account_id" uuid NOT NULL,
	"agent_address" text NOT NULL,
	"delegation_id" uuid,
	"preset" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agents_agent_address_unique" UNIQUE("agent_address")
);
--> statement-breakpoint
ALTER TABLE "agent_allowlists" ADD CONSTRAINT "agent_allowlists_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_account_id_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_delegation_id_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."delegations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_allowlist_agent" ON "agent_allowlists" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agents_client" ON "agents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_agents_parent" ON "agents" USING btree ("parent_account_id");