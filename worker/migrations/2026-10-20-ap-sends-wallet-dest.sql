-- Additive columns for POST /agent/send wallet-id destinations.
-- Existing rows stay settlement=live (on-chain P2PKH).
-- Apply once against the shared entangleit D1 (from worker/):
--   npx wrangler d1 execute entangleit --file=migrations/2026-10-20-ap-sends-wallet-dest.sql --remote
-- Do not re-run schema.sql as a migration; CREATE TABLE IF NOT EXISTS will not
-- add columns to an existing ap_sends table.
-- Safe to skip on a fresh D1 that already loaded the updated schema.sql.

ALTER TABLE ap_sends ADD COLUMN settlement TEXT NOT NULL DEFAULT 'live';
ALTER TABLE ap_sends ADD COLUMN dest_wallet_id TEXT;
