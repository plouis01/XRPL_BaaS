ALTER TABLE "spend_policies" DROP CONSTRAINT "spend_policies_client_id_unique";--> statement-breakpoint
ALTER TABLE "spend_policies" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "spend_policies" ADD CONSTRAINT "spend_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_spend_policies_scope" ON "spend_policies" USING btree ("client_id","agent_id");--> statement-breakpoint
-- Drizzle's .unique() doesn't emit NULLS NOT DISTINCT yet, so the
-- composite UNIQUE goes in raw SQL. NULLS NOT DISTINCT makes
-- (client_id, NULL) collide with another (client_id, NULL) — exactly
-- one tenant-wide default per client AND at most one row per (client,
-- agent) pair, in one constraint. Requires PostgreSQL 15+.
ALTER TABLE "spend_policies" ADD CONSTRAINT "uniq_spend_policy_scope" UNIQUE NULLS NOT DISTINCT ("client_id", "agent_id");