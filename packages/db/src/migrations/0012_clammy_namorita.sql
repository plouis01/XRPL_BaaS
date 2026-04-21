-- REVIEW.md HIGH-04: make transactions.idempotency_key NOT NULL so the
-- UNIQUE(client_id, idempotency_key) constraint is a real DB-layer gate.
-- Postgres treats every NULL as distinct under UNIQUE, so a nullable column
-- silently bypasses the idempotency guard.
--
-- Step 1: backfill any legacy NULL rows with a row-unique placeholder so
-- the NOT NULL ALTER doesn't fail on existing data. `legacy-<id>` is
-- guaranteed unique (id is the PK). The prefix makes these rows easy to
-- identify in audit queries later if needed.
UPDATE "transactions" SET "idempotency_key" = 'legacy-' || "id" WHERE "idempotency_key" IS NULL;

-- Step 2: now that all rows have a value, the NOT NULL constraint is safe.
ALTER TABLE "transactions" ALTER COLUMN "idempotency_key" SET NOT NULL;
