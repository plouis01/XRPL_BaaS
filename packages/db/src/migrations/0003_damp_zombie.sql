ALTER TABLE "credential_issuers" ALTER COLUMN "is_active" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "is_active" SET NOT NULL;