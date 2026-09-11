/**
 * Stripe on Workers. Checkout top-ups credit the wallet; webhooks are the
 * source of truth. Dynamic payment methods only (no `payment_method_types`).
 * Fulfillment is gated on `payment_status === "paid"` and idempotent by
 * Checkout session id (see ap_topup_refs in ledger.ts).
 */
import Stripe from "stripe";
import { HttpError, type AppEnv, type WalletRow } from "./types";
import { formatCents } from "./ids";
import { creditTopup, setStripeCustomerId } from "./ledger";
import { APP_PREFIX, siteOrigin } from "./paths";
import {
  ensureSubscription,
  findWalletByStripe,
  proPriceCents,
  updateSubscriptionStatusByCustomer,
  upsertSubscription,
} from "./plans";

export const TOPUP_MIN_CENTS = 100; // $1
export const TOPUP_MAX_CENTS = 100_000; // $1,000
export const TOPUP_PRESETS = [500, 2000, 10000] as const;

export function isValidTopupAmount(cents: unknown): cents is number {
  return Number.isInteger(cents) && (cents as number) >= TOPUP_MIN_CENTS && (cents as number) <= TOPUP_MAX_CENTS;
}

export function stripeConfigured(env: AppEnv): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function stripeClient(env: AppEnv): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, "Stripe is not configured");
  return new Stripe(key, {
    apiVersion: "2026-08-26.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Live vs test from the key prefix. */
export function stripeKeyLivemode(key: string | null | undefined): boolean | null {
  if (!key) return null;
  if (key.includes("_live_")) return true;
  if (key.includes("_test_")) return false;
  return null;
}

export function stripeEnvLivemode(env: AppEnv): boolean | null {
  return stripeKeyLivemode(env.STRIPE_SECRET_KEY) ?? stripeKeyLivemode(env.STRIPE_PUBLISHABLE_KEY);
}

/** Production hostname must not charge in Stripe test mode. */
export function productionRequiresLiveStripe(hostname: string, livemode: boolean | null): boolean {
  return hostname === "entangleit.com" && livemode !== true;
}

export function isStripeMissingResource(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "resource_missing") return true;
  return typeof e.message === "string" && /no such (customer|price|subscription)/i.test(e.message);
}

export function stripeErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { type?: string; rawType?: string; message?: string };
  if (typeof e.message === "string" && (e.type || e.rawType || isStripeMissingResource(err))) {
    return e.message;
  }
  return null;
}

function throwStripe(err: unknown): never {
  const message = stripeErrorMessage(err);
  if (message) throw new HttpError(502, message);
  throw err;
}

function integrationIdentifier(prefix: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let suffix = "";
  for (const b of buf) suffix += alphabet[b % alphabet.length];
  return `${prefix}_${suffix}`;
}

function assertLiveOnProduction(origin: string, env: AppEnv): void {
  const livemode = stripeEnvLivemode(env);
  if (productionRequiresLiveStripe(new URL(origin).hostname, livemode)) {
    throw new HttpError(503, "Production Checkout requires live Stripe keys");
  }
}

async function ensureCustomer(env: AppEnv, stripe: Stripe, wallet: WalletRow): Promise<string> {
  if (wallet.stripe_customer_id) {
    try {
      const remote = await stripe.customers.retrieve(wallet.stripe_customer_id);
      if (!("deleted" in remote && remote.deleted)) return wallet.stripe_customer_id;
    } catch (err) {
      if (!isStripeMissingResource(err)) throwStripe(err);
    }
    await setStripeCustomerId(env.DB, wallet.id, "");
  }
  const customer = await stripe.customers.create({
    metadata: { agentpayWalletId: wallet.id },
    email: wallet.email || undefined,
    name: wallet.name || undefined,
  });
  await setStripeCustomerId(env.DB, wallet.id, customer.id);
  return customer.id;
}

export async function createTopupCheckout(
  env: AppEnv,
  wallet: WalletRow,
  amountCents: number,
  origin: string,
): Promise<{ url: string; sessionId: string }> {
  if (!stripeConfigured(env)) throw new HttpError(503, "Stripe is not configured");
  if (!isValidTopupAmount(amountCents)) {
    throw new HttpError(400, `Top-up must be $${TOPUP_MIN_CENTS / 100}–$${TOPUP_MAX_CENTS / 100} (amountCents)`);
  }
  assertLiveOnProduction(origin, env);
  const stripe = stripeClient(env);
  const customer = await ensureCustomer(env, stripe, wallet).catch(throwStripe);
  const site = siteOrigin(new Request(`${origin}/`));
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer,
    client_reference_id: wallet.id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: "agentpay wallet top-up",
            description: `${formatCents(amountCents)} credit — ${wallet.name || wallet.id}`,
          },
        },
      },
    ],
    success_url: `${site}${APP_PREFIX}/?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}${APP_PREFIX}/?topup=cancel`,
    metadata: { kind: "topup", walletId: wallet.id },
    payment_intent_data: { metadata: { kind: "topup", walletId: wallet.id } },
    integration_identifier: integrationIdentifier("agentpay_topup"),
  }).catch(throwStripe);
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");
  return { url: session.url, sessionId: session.id };
}

export async function claimTopup(
  env: AppEnv,
  wallet: WalletRow,
  sessionId: string,
): Promise<{ credited: boolean; amountCents: number; balanceCents: number }> {
  if (!stripeConfigured(env)) throw new HttpError(503, "Stripe is not configured");
  const stripe = stripeClient(env);
  const session = await stripe.checkout.sessions.retrieve(sessionId).catch(throwStripe);
  if (session.metadata?.walletId !== wallet.id) {
    throw new HttpError(403, "That Checkout session belongs to another wallet");
  }
  if (session.status !== "complete") throw new HttpError(402, "Checkout is not complete yet");
  if (session.payment_status !== "paid") throw new HttpError(402, "Payment has not settled yet");
  const amountCents = session.amount_total ?? 0;
  if (amountCents <= 0) throw new HttpError(400, "Checkout session has no paid amount");
  const res = await creditTopup(env.DB, {
    walletId: wallet.id,
    amountCents,
    ref: session.id,
    meta: { source: "stripe_claim" },
  });
  return { credited: res.credited, amountCents: res.credited ? amountCents : 0, balanceCents: res.balanceCents };
}

/**
 * Pro plan: monthly subscription Checkout. Uses STRIPE_PRICE_PRO when set,
 * otherwise creates an ad-hoc monthly price so upgrades work with zero setup.
 */
export async function createSubscriptionCheckout(
  env: AppEnv,
  wallet: WalletRow,
  origin: string,
): Promise<{ url: string; sessionId: string; priceCents: number }> {
  if (!stripeConfigured(env)) throw new HttpError(503, "Stripe is not configured");
  assertLiveOnProduction(origin, env);
  const priceCents = proPriceCents(env);
  const stripe = stripeClient(env);
  const customer = await ensureCustomer(env, stripe, wallet).catch(throwStripe);
  const site = siteOrigin(new Request(`${origin}/`));
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = env.STRIPE_PRICE_PRO
    ? { quantity: 1, price: env.STRIPE_PRICE_PRO }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          recurring: { interval: "month" },
          product_data: {
            name: "agentpay Pro",
            description: "25 agent keys, $1,000 daily limits, CSV export",
          },
        },
      };
  const session = await stripe.checkout.sessions
    .create({
      mode: "subscription",
      customer,
      client_reference_id: wallet.id,
      line_items: [lineItem],
      success_url: `${site}${APP_PREFIX}/?plan=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}${APP_PREFIX}/?plan=cancel`,
      metadata: { kind: "subscription", agentpayWalletId: wallet.id },
      subscription_data: { metadata: { agentpayWalletId: wallet.id } },
      integration_identifier: integrationIdentifier("agentpay_pro"),
    })
    .catch(throwStripe);
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");
  return { url: session.url, sessionId: session.id, priceCents };
}

/** Stripe-hosted billing portal: change payment method, cancel, view invoices. */
export async function createBillingPortalSession(
  env: AppEnv,
  wallet: WalletRow,
  origin: string,
): Promise<{ url: string }> {
  if (!stripeConfigured(env)) throw new HttpError(503, "Stripe is not configured");
  if (!wallet.stripe_customer_id) {
    throw new HttpError(400, "No Stripe customer on file yet — start a subscription first");
  }
  assertLiveOnProduction(origin, env);
  const stripe = stripeClient(env);
  const site = siteOrigin(new Request(`${origin}/`));
  const session = await stripe.billingPortal.sessions
    .create({
      customer: wallet.stripe_customer_id,
      return_url: `${site}${APP_PREFIX}/?billing=return`,
    })
    .catch(throwStripe);
  return { url: session.url };
}

// Stripe object shapes we rely on. Field locations (e.g. current_period_end)
// have moved between API versions, so we read defensively.
interface StripeSubscriptionShape {
  id: string;
  status: string;
  customer?: string | { id?: string };
  metadata?: Record<string, string>;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: { data?: { price?: { id?: string }; current_period_end?: number }[] };
}

function stripeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
}

function subscriptionFields(sub: StripeSubscriptionShape) {
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  return {
    walletId: sub.metadata?.agentpayWalletId ?? null,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: stripeId(sub.customer),
    priceId: item?.price?.id ?? null,
    status: sub.status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}

/** Claim a Stripe event id exactly once (Stripe retries deliveries). */
async function claimStripeEvent(db: D1Database, id: string, type: string): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO ap_stripe_events (id, type) VALUES (?, ?)")
    .bind(id, type)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

async function releaseStripeEvent(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("DELETE FROM ap_stripe_events WHERE id = ?")
    .bind(id)
    .run()
    .catch(() => undefined);
}

async function processStripeEvent(env: AppEnv, event: Stripe.Event): Promise<void> {
  const db = env.DB;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const walletId =
        session.metadata?.agentpayWalletId ?? session.metadata?.walletId ?? session.client_reference_id ?? null;

      // Top-up fulfillment (payment mode).
      if (session.mode !== "subscription" && session.payment_status === "paid") {
        const amountCents = session.amount_total ?? 0;
        if (!walletId || amountCents <= 0) return;
        await creditTopup(db, {
          walletId,
          amountCents,
          ref: session.id,
          meta: { source: "stripe_webhook", eventId: event.id },
        });
        return;
      }

      // Pro subscription started. The subscription.* events fill in status and
      // period end; INSERT OR IGNORE here cannot clobber a later update.
      if (session.mode === "subscription" && walletId) {
        const customerId = stripeId(session.customer);
        const subscriptionId = stripeId(session.subscription);
        if (customerId) await setStripeCustomerId(db, walletId, customerId);
        await ensureSubscription(db, {
          walletId,
          status: session.payment_status === "paid" || session.payment_status === "no_payment_required" ? "active" : "incomplete",
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
        });
      }
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const fields = subscriptionFields(event.data.object as unknown as StripeSubscriptionShape);
      const walletId =
        fields.walletId ??
        (await findWalletByStripe(db, {
          subscriptionId: fields.stripeSubscriptionId,
          customerId: fields.stripeCustomerId,
        }));
      if (!walletId) return;
      await upsertSubscription(db, {
        walletId,
        plan: "pro",
        status: event.type === "customer.subscription.deleted" ? "canceled" : fields.status,
        stripeCustomerId: fields.stripeCustomerId,
        stripeSubscriptionId: fields.stripeSubscriptionId,
        priceId: fields.priceId,
        currentPeriodEnd: fields.currentPeriodEnd,
        cancelAtPeriodEnd: event.type === "customer.subscription.deleted" ? false : fields.cancelAtPeriodEnd,
      });
      if (fields.stripeCustomerId) await setStripeCustomerId(db, walletId, fields.stripeCustomerId);
      return;
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as { customer?: string | { id?: string } };
      const customerId = stripeId(invoice.customer);
      if (!customerId) return;
      await updateSubscriptionStatusByCustomer(
        db,
        customerId,
        event.type === "invoice.paid" ? "active" : "past_due",
      );
      return;
    }

    default:
      return;
  }
}

export async function handleStripeEvent(env: AppEnv, event: Stripe.Event): Promise<void> {
  const claimed = await claimStripeEvent(env.DB, event.id, event.type);
  if (!claimed) return;
  try {
    await processStripeEvent(env, event);
  } catch (err) {
    // Release the claim so a Stripe retry can process the event again.
    await releaseStripeEvent(env.DB, event.id);
    console.error("[stripe-webhook]", event.type, err);
    throw err;
  }
}
