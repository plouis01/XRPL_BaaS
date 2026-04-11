ALTER TABLE "domains" ADD COLUMN "pending_accepted_credentials" jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "pending_deletion" boolean DEFAULT false NOT NULL;