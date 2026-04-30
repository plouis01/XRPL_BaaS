-- VISION.md agent launcher: re-denominate spend caps from XRP-drops to
-- USD-cents. Migration 0019 supports the move from XRP-only spending to
-- mixed XRP + RLUSD payments by funneling both into a single
-- USD-cent counter at enforcement time. RLUSD = 1:1 peg (no oracle);
-- XRP runs through priceOracle.service.ts (CoinGecko, 60s cache).
--
-- The columns are renamed (not dropped+added) so existing rows survive
-- the migration. NOTE: stored values are still numerically interpreted
-- as drops; a follow-up backfill is required to multiply by XRP/USD
-- and divide by 1_000_000 if any tenant has an active cap. Testnet has
-- no policies in production yet, so for the dev DB this is a no-op
-- conversion — operators set fresh USD caps via PUT /agents/:id/spend-policy.
ALTER TABLE "spend_policies" RENAME COLUMN "max_xrp_per_tx_drops" TO "max_per_tx_usd_cents";--> statement-breakpoint
ALTER TABLE "spend_policies" RENAME COLUMN "daily_xrp_limit_drops" TO "daily_limit_usd_cents";
