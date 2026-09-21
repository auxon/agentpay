export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra JSON fields merged into the error response (e.g. plan_limit details). */
    public payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Free vs Pro. Entitlements derive from plan + subscription status. */
export type PlanId = "free" | "pro";

export interface PlanLimits {
  /** Maximum active agent keys per wallet. */
  maxAgents: number;
  /** Maximum per-agent daily limit, in USD cents. */
  maxDailyLimitCents: number;
  /** CSV export of ledger + receipts. */
  exportCsv: boolean;
}

export interface PlanState {
  /** Effective entitlement plan (pro only while the subscription is active). */
  id: PlanId;
  /** What the wallet is subscribed to (kept after cancellation for display). */
  subscribedPlan: PlanId;
  status: string;
  active: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceCents: number;
  limits: PlanLimits;
}

export interface SubscriptionRow {
  wallet_id: string;
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}

/** Worker bindings. Secrets are optional so `wrangler dev` works unconfigured. */
export interface AppEnv {
  DB: D1Database;
  APP_ORIGIN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  /** WIF for the BSV treasury that pays x402 sellers. Never log this. */
  SITE_WALLET_WIF?: string;
  /** Cap per BSV payment, in sats. */
  X402_MAX_SATS?: string;
  /** Flat network fee for x402 payments, in sats (default 30). */
  X402_FEE_SATS?: string;
  /** Sats per USD cent for automatic pricing. Unset = charge 1 cent minimum. */
  X402_SATS_PER_CENT?: string;
  /** "1" allows spending unconfirmed UTXOs (local testing only). */
  X402_ALLOW_UNCONFIRMED?: string;
  /** Treasury balance (sats) below which /health flags `low`. */
  X402_MIN_TREASURY_SATS?: string;
  /** Optional operator webhook for treasury_low alerts (POST JSON). */
  TREASURY_ALERT_URL?: string;
  TREASURY_ALERT_SECRET?: string;
  /** Google OAuth 2.0 Client ID for dashboard sign-in (GIS ID-token flow). */
  GOOGLE_CLIENT_ID?: string;
  /** Trial faucet: TRIAL_ENABLED="1" gates POST /trial + claim_trial. */
  TRIAL_ENABLED?: string;
  /** Trial wallet funding in cents (default 25, max 500). */
  TRIAL_CENTS?: string;
  /** Operator lifetime trial budget in cents (default 1000 = $10). */
  TRIAL_TOTAL_CAP_CENTS?: string;
  /** Monthly Pro price in USD cents (default 2900). */
  PRO_PRICE_CENTS?: string;
  /** Optional pre-created Stripe price for Pro; falls back to an ad-hoc monthly price. */
  STRIPE_PRICE_PRO?: string;
  /** Resend API key for alert emails (optional — webhooks still work). */
  RESEND_API_KEY?: string;
  /** Private EC P-256 JWK (JSON) used to sign proof-of-spend attestations. */
  ATTESTATION_KEY_JWK?: string;
  /** From header for alert emails, e.g. "agentpay <alerts@entangleit.com>". */
  ALERT_FROM?: string;
  /** Default low-balance alert threshold in cents (default 500 = $5). */
  LOW_BALANCE_CENTS?: string;
  /** Operator key for ops endpoints. */
  ADMIN_SECRET?: string;
  /** Service binding to the bsv-bounties worker (earn side). Optional. */
  BOUNTIES?: Fetcher;
  /** Base URL used when the BOUNTIES binding is absent (workers.dev fallback). */
  BOUNTIES_API_URL?: string;
  /** Shared secret bsv-bounties sends on settle events (x-agentpay-internal). */
  BOUNTIES_WEBHOOK_SECRET?: string;
  /** Sats per USD cent when crediting bounty payouts (default 40000 = $25/BSV). */
  BOUNTY_SATS_PER_CENT?: string;
  /** AES-256-GCM key (base64, 32 bytes) encrypting per-bounty escrow WIFs. */
  BOUNTY_ESCROW_KEY?: string;
  /** Platform fee in bps on agentpay-funded bounty payouts (default 200 = 2%). */
  BOUNTY_FEE_BPS?: string;
  /** ARC endpoint for escrow broadcasts (default GorillaPool) + optional key. */
  ARC_URL?: string;
  ARC_API_KEY?: string;
  /** Optional second ARC endpoint tried when ARC_URL fails. */
  ARC_FALLBACK_URL?: string;
}

export interface WalletRow {
  id: string;
  name: string;
  email: string;
  token_hash: string;
  stripe_customer_id: string | null;
  balance_cents: number;
  lifetime_topup_cents: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  wallet_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  daily_limit_cents: number | null;
  spent_day: string;
  spent_today_cents: number;
  active: number;
  created_at: string;
  last_used_at: string | null;
  /** Joined from ap_subagent_budgets when this agent is a sub-agent. */
  parent_agent_id?: string | null;
  sub_budget_cents?: number | null;
  sub_spent_cents?: number | null;
  sub_expires_at?: string | null;
}

/** A delegated child key: parent link + lifetime budget + expiry. */
/** Google sign-in identity, mapped to one wallet. Raw ID tokens are never stored. */
export interface GoogleUserRow {
  google_sub: string;
  email: string;
  name: string;
  wallet_id: string;
  created_at: string;
  updated_at: string;
}

export interface SubagentRow {
  agent_id: string;
  parent_agent_id: string;
  budget_cents: number | null;
  spent_cents: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id: string;
  wallet_id: string;
  agent_id: string | null;
  kind: "topup" | "debit" | "refund" | "adjust";
  amount_cents: number;
  balance_after_cents: number;
  currency: string;
  ref: string;
  meta_json: string;
  created_at: string;
}

export interface ReceiptRow {
  id: string;
  ledger_id: string;
  wallet_id: string;
  agent_id: string | null;
  service: string;
  tool: string;
  description: string;
  amount_cents: number;
  currency: string;
  request_ref: string;
  result_json: string;
  created_at: string;
}

/** Per-agent spend policy (missing row = no approvals, all tools allowed). */
export interface AgentPolicyRow {
  agent_id: string;
  approval_above_cents: number | null;
  allowed_tools_json: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  wallet_id: string;
  agent_id: string | null;
  amount_cents: number;
  description: string;
  service: string;
  tool: string;
  ref: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  reason: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  consumed_at: string | null;
}
