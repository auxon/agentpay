import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { makeTestDb } from "./helpers";
import { createAgent, createWallet, listAgents } from "../src/ledger";
import {
  PLANS,
  ensureSubscription,
  findWalletByStripe,
  getPlanState,
  proPriceCents,
  subscriptionIsActive,
  updateSubscriptionStatusByCustomer,
  upsertSubscription,
} from "../src/plans";
import { handleStripeEvent } from "../src/stripe";
import type { AppEnv, HttpError } from "../src/types";

function envWith(db: unknown): AppEnv {
  return { DB: db } as unknown as AppEnv;
}

function futureIso(days = 30): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function catchHttp(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected the promise to reject");
}

function subscriptionEvent(type: string, sub: Record<string, unknown>, id = `evt_${type}`): Stripe.Event {
  return { id, type, data: { object: sub } } as unknown as Stripe.Event;
}

function activeSubscription(walletId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_test_1",
    status: "active",
    customer: "cus_test_1",
    metadata: { agentpayWalletId: walletId },
    cancel_at_period_end: false,
    items: {
      data: [{ price: { id: "price_test_1" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }],
    },
    ...overrides,
  };
}

describe("plan defaults", () => {
  it("starts every wallet on Free with free limits", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const plan = await getPlanState(db, wallet.id);
    expect(plan.id).toBe("free");
    expect(plan.active).toBe(false);
    expect(plan.status).toBe("none");
    expect(plan.limits).toEqual(PLANS.free.limits);
  });

  it("prices Pro at $29 by default and honors an override", () => {
    expect(proPriceCents({})).toBe(2900);
    expect(proPriceCents({ PRO_PRICE_CENTS: "4900" })).toBe(4900);
    expect(proPriceCents({ PRO_PRICE_CENTS: "nope" })).toBe(2900);
  });
});

describe("free plan limits", () => {
  it("allows 3 active agents and rejects the 4th with a plan_limit payload", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    for (let i = 0; i < 3; i++) await createAgent(db, wallet.id, { name: `bot-${i}` });
    expect(await listAgents(db, wallet.id)).toHaveLength(3);
    const err = await catchHttp(createAgent(db, wallet.id, { name: "bot-4" }));
    expect(err.status).toBe(402);
    expect(err.payload?.code).toBe("plan_limit");
    expect(err.payload?.maxAgents).toBe(3);
    expect(String(err.payload?.upgradeUrl)).toContain("/agentpay/");
  });

  it("caps per-agent daily limits at $50", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const ok = await createAgent(db, wallet.id, { name: "within", dailyLimitCents: 5000 });
    expect(ok.agent.daily_limit_cents).toBe(5000);
    const err = await catchHttp(createAgent(db, wallet.id, { name: "over", dailyLimitCents: 5001 }));
    expect(err.status).toBe(402);
    expect(err.payload?.code).toBe("plan_limit");
  });
});

describe("pro entitlements", () => {
  it("raises agent and daily-limit caps while the subscription is active", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    await upsertSubscription(db, {
      walletId: wallet.id,
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_test_1",
      stripeSubscriptionId: "sub_test_1",
      priceId: "price_test_1",
      currentPeriodEnd: futureIso(),
    });
    const plan = await getPlanState(db, wallet.id);
    expect(plan.id).toBe("pro");
    expect(plan.active).toBe(true);
    expect(plan.limits.maxAgents).toBe(25);

    for (let i = 0; i < 5; i++) await createAgent(db, wallet.id, { name: `bot-${i}`, dailyLimitCents: 100_000 });
    expect(await listAgents(db, wallet.id)).toHaveLength(5);

    const err = await catchHttp(createAgent(db, wallet.id, { name: "too-big", dailyLimitCents: 100_001 }));
    expect(err.status).toBe(402);
  });

  it("drops entitlements when the subscription is canceled but keeps the display plan", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    await upsertSubscription(db, {
      walletId: wallet.id,
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_test_1",
      currentPeriodEnd: futureIso(),
    });
    await upsertSubscription(db, { walletId: wallet.id, plan: "pro", status: "canceled" });
    const plan = await getPlanState(db, wallet.id);
    expect(plan.id).toBe("free");
    expect(plan.subscribedPlan).toBe("pro");
    expect(plan.status).toBe("canceled");
  });

  it("treats a long-stale paid period as inactive (72h grace)", () => {
    const stale = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    expect(subscriptionIsActive("active", futureIso())).toBe(true);
    expect(subscriptionIsActive("active", null)).toBe(true);
    expect(subscriptionIsActive("active", recent)).toBe(true);
    expect(subscriptionIsActive("active", stale)).toBe(false);
    expect(subscriptionIsActive("trialing", futureIso())).toBe(true);
    expect(subscriptionIsActive("past_due", futureIso())).toBe(false);
    expect(subscriptionIsActive("canceled", futureIso())).toBe(false);
  });
});

describe("stripe subscription webhooks", () => {
  it("activates Pro from customer.subscription.updated and is idempotent by event id", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const env = envWith(db);
    const event = subscriptionEvent("customer.subscription.updated", activeSubscription(wallet.id));
    await handleStripeEvent(env, event);
    let plan = await getPlanState(db, wallet.id);
    expect(plan.id).toBe("pro");
    expect(plan.active).toBe(true);
    expect(plan.currentPeriodEnd).toBeTruthy();

    // Same event id twice: no-op (Stripe retries must not re-apply).
    await db.prepare("UPDATE ap_subscriptions SET status = 'canceled' WHERE wallet_id = ?").bind(wallet.id).run();
    await handleStripeEvent(env, event);
    plan = await getPlanState(db, wallet.id);
    expect(plan.status).toBe("canceled");
  });

  it("handles deleted subscriptions and invoice payment failures", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const env = envWith(db);
    await handleStripeEvent(env, subscriptionEvent("customer.subscription.updated", activeSubscription(wallet.id), "evt_a"));
    await handleStripeEvent(
      env,
      subscriptionEvent("customer.subscription.deleted", activeSubscription(wallet.id, { status: "canceled" }), "evt_b"),
    );
    expect((await getPlanState(db, wallet.id)).status).toBe("canceled");

    await handleStripeEvent(env, subscriptionEvent("customer.subscription.updated", activeSubscription(wallet.id), "evt_c"));
    const invoiceFailed = {
      id: "evt_d",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_test_1" } },
    } as unknown as Stripe.Event;
    await handleStripeEvent(env, invoiceFailed);
    expect((await getPlanState(db, wallet.id)).status).toBe("past_due");
    expect((await getPlanState(db, wallet.id)).active).toBe(false);
  });

  it("creates a minimal subscription row from checkout.session.completed", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    await handleStripeEvent(
      envWith(db),
      {
        id: "evt_checkout_sub",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_1",
            mode: "subscription",
            payment_status: "paid",
            customer: "cus_checkout_1",
            subscription: "sub_checkout_1",
            client_reference_id: wallet.id,
            metadata: { agentpayWalletId: wallet.id },
          },
        },
      } as unknown as Stripe.Event,
    );
    const plan = await getPlanState(db, wallet.id);
    expect(plan.active).toBe(true);
    expect(plan.status).toBe("active");
    const walletRow = await db.prepare("SELECT stripe_customer_id FROM ap_wallets WHERE id = ?").bind(wallet.id).first<{ stripe_customer_id: string }>();
    expect(walletRow?.stripe_customer_id).toBe("cus_checkout_1");
  });

  it("still credits top-ups delivered as checkout.session.completed", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    await handleStripeEvent(
      envWith(db),
      {
        id: "evt_topup",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_topup_1",
            mode: "payment",
            payment_status: "paid",
            amount_total: 2000,
            metadata: { kind: "topup", walletId: wallet.id },
          },
        },
      } as unknown as Stripe.Event,
    );
    const row = await db.prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?").bind(wallet.id).first<{ balance_cents: number }>();
    expect(row?.balance_cents).toBe(2000);
  });
});

describe("stripe wallet resolution", () => {
  it("finds the wallet by subscription id, then customer id", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    await upsertSubscription(db, {
      walletId: wallet.id,
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_resolve",
      stripeSubscriptionId: "sub_resolve",
    });
    expect(await findWalletByStripe(db, { subscriptionId: "sub_resolve" })).toBe(wallet.id);
    expect(await findWalletByStripe(db, { customerId: "cus_resolve" })).toBe(wallet.id);
    expect(await findWalletByStripe(db, { subscriptionId: "nope", customerId: "nope" })).toBeNull();
  });

  it("updates status by customer only for known subscriptions", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    expect(await updateSubscriptionStatusByCustomer(db, "cus_unknown", "active")).toBe(false);
    await ensureSubscription(db, { walletId: wallet.id, status: "incomplete", stripeCustomerId: "cus_known" });
    expect(await updateSubscriptionStatusByCustomer(db, "cus_known", "active")).toBe(true);
    expect((await getPlanState(db, wallet.id)).status).toBe("active");
  });
});
