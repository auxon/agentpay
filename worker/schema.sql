-- agentpay tables live in the SHARED entangleit D1 (consolidated 2026-09-10).
-- All tables are ap_-prefixed to avoid collisions. Money is integer USD cents.
-- Apply: wrangler d1 execute entangleit --file=schema.sql --remote   (from worker/)

CREATE TABLE IF NOT EXISTS ap_wallets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  lifetime_topup_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_wallets_token_hash ON ap_wallets(token_hash);

CREATE TABLE IF NOT EXISTS ap_agents (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES ap_wallets(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT '',
  daily_limit_cents INTEGER,
  spent_day TEXT NOT NULL DEFAULT '',
  spent_today_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_agents_key_hash ON ap_agents(key_hash);
CREATE INDEX IF NOT EXISTS idx_ap_agents_wallet ON ap_agents(wallet_id);

CREATE TABLE IF NOT EXISTS ap_ledger (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES ap_wallets(id) ON DELETE CASCADE,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('topup', 'debit', 'refund', 'adjust')),
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  ref TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_ledger_wallet ON ap_ledger(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ap_ledger_ref ON ap_ledger(wallet_id, kind, ref);

CREATE TABLE IF NOT EXISTS ap_receipts (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ap_ledger(id) ON DELETE CASCADE,
  wallet_id TEXT NOT NULL,
  agent_id TEXT,
  service TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  request_ref TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_receipts_wallet ON ap_receipts(wallet_id, created_at DESC);

-- Idempotency ledger for wallet credits. One row per external payment ref
-- (Stripe Checkout session id), inserted with INSERT OR IGNORE before crediting.
CREATE TABLE IF NOT EXISTS ap_topup_refs (
  ref TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recovery codes: a second, offline-stored secret that lets an owner reset the
-- wallet token (the token itself is only shown once). Stored hashed.
CREATE TABLE IF NOT EXISTS ap_recovery (
  wallet_id TEXT PRIMARY KEY REFERENCES ap_wallets(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- Settled x402 txids. INSERT OR IGNORE acts as a replay guard: a seller that
-- returns an already-settled txid cannot charge the wallet twice.
CREATE TABLE IF NOT EXISTS ap_x402_payments (
  txid TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  receipt_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value store for cached operator state (treasury balance snapshots).
CREATE TABLE IF NOT EXISTS ap_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-agent policy: spend approval threshold and tool scopes.
CREATE TABLE IF NOT EXISTS ap_agent_policies (
  agent_id TEXT PRIMARY KEY REFERENCES ap_agents(id) ON DELETE CASCADE,
  approval_above_cents INTEGER,
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Human-in-the-loop purchase approvals. A spend at/above the agent's threshold
-- mints a pending approval; the owner approves, then the agent retries with the
-- approval id (single use, short expiry).
CREATE TABLE IF NOT EXISTS ap_approvals (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES ap_wallets(id) ON DELETE CASCADE,
  agent_id TEXT,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_approvals_wallet ON ap_approvals(wallet_id, status, created_at DESC);

-- Pro plan subscriptions (one per wallet). Kept in its own table so the schema
-- stays additive (`CREATE TABLE IF NOT EXISTS`) on the shared entangleit D1.
-- Entitlements are derived from `plan` + `status` (active|trialing = Pro).
CREATE TABLE IF NOT EXISTS ap_subscriptions (
  wallet_id TEXT PRIMARY KEY REFERENCES ap_wallets(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'none',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  price_id TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_subscriptions_sub ON ap_subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_ap_subscriptions_customer ON ap_subscriptions(stripe_customer_id);

-- Stripe webhook idempotency. Stripe retries and can deliver an event more than
-- once; the event id is claimed before processing and released on failure.
CREATE TABLE IF NOT EXISTS ap_stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sub-agent budgets: a top-level agent mints scoped child keys for its workers.
-- The child is a normal ap_agents row (key, daily limit, policy); this table
-- adds the parent link, a lifetime budget, and an expiry. No nesting: only
-- top-level agents can mint.
CREATE TABLE IF NOT EXISTS ap_subagent_budgets (
  agent_id TEXT PRIMARY KEY REFERENCES ap_agents(id) ON DELETE CASCADE,
  parent_agent_id TEXT NOT NULL,
  budget_cents INTEGER,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_subagent_parent ON ap_subagent_budgets(parent_agent_id);

-- Per-wallet alert webhook. The secret signs deliveries (HMAC-SHA256 over
-- timestamp.body); it is shown once on create/rotate and stored server-side
-- because signing requires the raw value.
CREATE TABLE IF NOT EXISTS ap_wallet_webhooks (
  wallet_id TEXT PRIMARY KEY REFERENCES ap_wallets(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  low_balance_cents INTEGER NOT NULL DEFAULT 500,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_success_at TEXT,
  last_error TEXT
);

-- Delivery log: one row per attempt, kept for debugging and manual redelivery.
CREATE TABLE IF NOT EXISTS ap_webhook_deliveries (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status_code INTEGER,
  error TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_webhook_deliveries_wallet ON ap_webhook_deliveries(wallet_id, created_at DESC);

-- Shareable spend reports (Pro): a random token exposes an aggregate view of a
-- wallet's ledger and receipts for a bounded window. Revocable and expiring.
CREATE TABLE IF NOT EXISTS ap_report_links (
  token TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES ap_wallets(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  days INTEGER NOT NULL DEFAULT 30,
  include_receipts INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_viewed_at TEXT,
  views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ap_report_links_wallet ON ap_report_links(wallet_id, created_at DESC);

-- Bounty links (BSVBounties earn side): when an agent claims a bounty through
-- the agentpay MCP, the wallet id is recorded here so the settle event from
-- bsv-bounties can credit the wallet's balance idempotently.
CREATE TABLE IF NOT EXISTS ap_bounty_links (
  bounty_id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES ap_wallets(id) ON DELETE CASCADE,
  agent_id TEXT,
  worker_ref TEXT NOT NULL,
  worker_account INTEGER,
  worker_pubkey TEXT,
  title TEXT NOT NULL DEFAULT '',
  amount_sats INTEGER,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'submitted', 'paid', 'refunded')),
  settle_txid TEXT,
  credited_cents INTEGER,
  credited_at TEXT,
  payout_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_bounty_links_wallet ON ap_bounty_links(wallet_id, created_at DESC);

-- agentpay-funded bounties with on-chain sats escrow. One row per posted
-- bounty: the per-bounty key is AES-GCM encrypted under BOUNTY_ESCROW_KEY.
CREATE TABLE IF NOT EXISTS ap_bounty_escrows (
  id TEXT PRIMARY KEY,
  bounty_id TEXT UNIQUE,
  wallet_id TEXT NOT NULL REFERENCES ap_wallets(id) ON DELETE CASCADE,
  agent_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  amount_sats INTEGER NOT NULL,
  fee_bps INTEGER NOT NULL DEFAULT 200,
  charged_cents INTEGER NOT NULL,
  post_ref TEXT NOT NULL,
  escrow_wif_enc TEXT NOT NULL,
  escrow_address TEXT NOT NULL,
  funding_txid TEXT,
  payout_txid TEXT,
  refund_txid TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  payout_address TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_bounty_escrows_wallet ON ap_bounty_escrows(wallet_id, created_at DESC);
