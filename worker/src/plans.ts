/**
 * agentpay plans and entitlements.
 *
 * Every wallet is Free by default. Pro is a Stripe subscription; the row in
 * ap_subscriptions is the source of truth and is written only by verified
 * Stripe webhooks. Entitlements are always derived server-side from
 * plan + status, never from client input.
 */
import { HttpError, type PlanId, type PlanLimits, type PlanState, type SubscriptionRow } from "./types";
import { nowIso } from "./ids";
import { APP_PREFIX, PUBLIC_SITE } from "./paths";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceCents: number;
  blurb: string;
  features: string[];
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    blurb: "Start spending in minutes.",
    features: [
      "Up to 3 agent keys",
      "Daily limits up to $50 per agent",
      "Approvals, receipts, and the full API + MCP",
    ],
    limits: { maxAgents: 3, maxDailyLimitCents: 5_000, exportCsv: false },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: 2_900,
    blurb: "For teams running agents with real budgets.",
    features: [
      "Up to 25 agent keys",
      "Daily limits up to $1,000 per agent",
      "CSV export of ledger and receipts",
      "Everything in Free",
    ],
    limits: { maxAgents: 25, maxDailyLimitCents: 100_000, exportCsv: true },
  },
};

export const PLAN_LIMIT_CODE = "plan_limit";
/** Keep Pro briefly after a missed renewal event instead of instantly locking. */
export const PRO_GRACE_MS = 72 * 60 * 60 * 1000;

export function planLimits(plan: PlanId): PlanLimits {
  return PLANS[plan].limits;
}

export function planName(plan: PlanId): string {
  return PLANS[plan].name;
}

export function proPriceCents(env: { PRO_PRICE_CENTS?: string }): number {
  const n = Number.parseInt(env.PRO_PRICE_CENTS ?? "", 10);
  return Number.isFinite(n) && n >= 100 ? n : PLANS.pro.priceCents;
}

export function upgradeUrl(): string {
  return `${PUBLIC_SITE}${APP_PREFIX}/?upgrade=1`;
}

/** 402 error carrying machine-readable plan-limit fields for REST + MCP clients. */
export function planLimitError(message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(402, message, { code: PLAN_LIMIT_CODE, upgradeUrl: upgradeUrl(), ...extra });
}

/** Active = Stripe says active/trialing and the paid period is not long stale. */
export function subscriptionIsActive(
  status: string | null | undefined,
  currentPeriodEnd: string | null | undefined,
  now = Date.now(),
): boolean {
  const s = (status ?? "").toLowerCase();
  if (s !== "active" && s !== "trialing") return false;
  if (!currentPeriodEnd) return true;
  const end = Date.parse(currentPeriodEnd);
  return Number.isNaN(end) ? true : end + PRO_GRACE_MS > now;
}

export function planStateFromRow(
  row: SubscriptionRow | null,
  env?: { PRO_PRICE_CENTS?: string },
): PlanState {
  const subscribedPlan: PlanId = row?.plan === "pro" ? "pro" : "free";
  const active = Boolean(
    row && subscribedPlan === "pro" && subscriptionIsActive(row.status, row.current_period_end),
  );
  const id: PlanId = active ? "pro" : "free";
  return {
    id,
    subscribedPlan,
    status: row?.status ?? "none",
    active,
    currentPeriodEnd: row?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
    priceCents: proPriceCents(env ?? {}),
    limits: planLimits(id),
  };
}

export async function getSubscription(db: D1Database, walletId: string): Promise<SubscriptionRow | null> {
  return db
    .prepare("SELECT * FROM ap_subscriptions WHERE wallet_id = ?")
    .bind(walletId)
    .first<SubscriptionRow>();
}

export async function getPlanState(
  db: D1Database,
  walletId: string,
  env?: { PRO_PRICE_CENTS?: string },
): Promise<PlanState> {
  return planStateFromRow(await getSubscription(db, walletId), env);
}

export interface SubscriptionUpsert {
  walletId: string;
  plan: PlanId;
  status: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  priceId?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

export async function upsertSubscription(db: D1Database, input: SubscriptionUpsert): Promise<void> {
  const t = nowIso();
  await db
    .prepare(
      `INSERT INTO ap_subscriptions (wallet_id, plan, status, stripe_customer_id, stripe_subscription_id, price_id, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet_id) DO UPDATE SET
         plan = excluded.plan,
         status = excluded.status,
         stripe_customer_id = COALESCE(excluded.stripe_customer_id, ap_subscriptions.stripe_customer_id),
         stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, ap_subscriptions.stripe_subscription_id),
         price_id = COALESCE(excluded.price_id, ap_subscriptions.price_id),
         current_period_end = COALESCE(excluded.current_period_end, ap_subscriptions.current_period_end),
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.walletId,
      input.plan,
      input.status,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId ?? null,
      input.priceId ?? null,
      input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ? 1 : 0,
      t,
      t,
    )
    .run();
}

/**
 * Minimal row for a paid subscription checkout (Stripe events fill in the rest).
 * INSERT OR IGNORE so a later `customer.subscription.updated` is not clobbered.
 */
export async function ensureSubscription(
  db: D1Database,
  input: {
    walletId: string;
    status: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  },
): Promise<void> {
  const t = nowIso();
  await db
    .prepare(
      "INSERT OR IGNORE INTO ap_subscriptions (wallet_id, plan, status, stripe_customer_id, stripe_subscription_id, created_at, updated_at) VALUES (?, 'pro', ?, ?, ?, ?, ?)",
    )
    .bind(input.walletId, input.status, input.stripeCustomerId ?? null, input.stripeSubscriptionId ?? null, t, t)
    .run();
}

/** Resolve a wallet from Stripe ids (subscription first, then customer). */
export async function findWalletByStripe(
  db: D1Database,
  ids: { subscriptionId?: string | null; customerId?: string | null },
): Promise<string | null> {
  if (ids.subscriptionId) {
    const row = await db
      .prepare("SELECT wallet_id FROM ap_subscriptions WHERE stripe_subscription_id = ? LIMIT 1")
      .bind(ids.subscriptionId)
      .first<{ wallet_id: string }>();
    if (row?.wallet_id) return row.wallet_id;
  }
  if (ids.customerId) {
    const sub = await db
      .prepare("SELECT wallet_id FROM ap_subscriptions WHERE stripe_customer_id = ? LIMIT 1")
      .bind(ids.customerId)
      .first<{ wallet_id: string }>();
    if (sub?.wallet_id) return sub.wallet_id;
    const wallet = await db
      .prepare("SELECT id FROM ap_wallets WHERE stripe_customer_id = ? LIMIT 1")
      .bind(ids.customerId)
      .first<{ id: string }>();
    if (wallet?.id) return wallet.id;
  }
  return null;
}

export async function updateSubscriptionStatusByCustomer(
  db: D1Database,
  customerId: string,
  status: string,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE ap_subscriptions SET status = ?, updated_at = ? WHERE stripe_customer_id = ?")
    .bind(status, nowIso(), customerId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
