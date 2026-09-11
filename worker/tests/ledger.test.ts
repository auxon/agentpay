import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import {
  createAgent,
  createWallet,
  creditTopup,
  getBalanceCents,
  getReceipt,
  listAgents,
  listLedger,
  revokeAgent,
  spend,
} from "../src/ledger";
import { HttpError } from "../src/types";
import { sha256Hex } from "../src/ids";

async function makeWallet() {
  const db = makeTestDb();
  const { wallet, token } = await createWallet(db, { name: "Test wallet", email: "t@example.com" });
  return { db, wallet, token };
}

async function expectHttpError(promise: Promise<unknown>, status: number, match?: RegExp) {
  await expect(promise).rejects.toBeInstanceOf(HttpError);
  await promise.catch((err: HttpError) => {
    expect(err.status).toBe(status);
    if (match) expect(err.message).toMatch(match);
  });
}

describe("wallet creation", () => {
  it("mints a one-time apw_ token and stores only its hash", async () => {
    const { db, wallet, token } = await makeWallet();
    expect(token.startsWith("apw_")).toBe(true);
    expect(wallet.balance_cents).toBe(0);
    expect(wallet.token_hash).toBe(await sha256Hex(token));
    expect(wallet.token_hash).not.toContain(token);
    const count = await db.raw.prepare("SELECT COUNT(*) AS n FROM ap_wallets").get();
    expect(Number(count?.n)).toBe(1);
  });
});

describe("top-ups", () => {
  it("credits a wallet and writes exactly one ledger event", async () => {
    const { db, wallet } = await makeWallet();
    const res = await creditTopup(db, { walletId: wallet.id, amountCents: 2000, ref: "cs_test_1" });
    expect(res.credited).toBe(true);
    expect(res.balanceCents).toBe(2000);
    const events = await listLedger(db, wallet.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("topup");
    expect(events[0].amount_cents).toBe(2000);
    expect(events[0].balance_after_cents).toBe(2000);
  });

  it("is idempotent by ref — a webhook replay cannot double-credit", async () => {
    const { db, wallet } = await makeWallet();
    await creditTopup(db, { walletId: wallet.id, amountCents: 2000, ref: "cs_dupe" });
    const second = await creditTopup(db, { walletId: wallet.id, amountCents: 2000, ref: "cs_dupe" });
    expect(second.credited).toBe(false);
    expect(second.amountCents).toBe(0);
    expect(second.balanceCents).toBe(2000);
    expect(await getBalanceCents(db, wallet.id)).toBe(2000);
    expect(await listLedger(db, wallet.id)).toHaveLength(1);
  });

  it("accepts distinct refs and rejects non-positive amounts", async () => {
    const { db, wallet } = await makeWallet();
    await creditTopup(db, { walletId: wallet.id, amountCents: 500, ref: "cs_a" });
    const second = await creditTopup(db, { walletId: wallet.id, amountCents: 1500, ref: "cs_b" });
    expect(second.balanceCents).toBe(2000);
    await expectHttpError(
      creditTopup(db, { walletId: wallet.id, amountCents: 0, ref: "cs_zero" }),
      400,
      /Invalid top-up/,
    );
  });
});

describe("spend", () => {
  it("debits exactly, writes a ledger event and a receipt", async () => {
    const { db, wallet } = await makeWallet();
    await creditTopup(db, { walletId: wallet.id, amountCents: 1000, ref: "cs_fund" });
    const res = await spend(db, {
      walletId: wallet.id,
      agent: null,
      amountCents: 250,
      description: "translate 5k words",
      service: "demo",
      tool: "translate",
      ref: "job-1",
    });
    expect(res.balanceCents).toBe(750);
    expect(res.ledger.amount_cents).toBe(-250);
    expect(res.ledger.balance_after_cents).toBe(750);
    expect(res.receipt.amount_cents).toBe(250);
    expect(res.receipt.description).toBe("translate 5k words");
    const fetched = await getReceipt(db, wallet.id, res.receipt.id);
    expect(fetched?.id).toBe(res.receipt.id);
  });

  it("refuses overdraft and leaves the balance untouched", async () => {
    const { db, wallet } = await makeWallet();
    await creditTopup(db, { walletId: wallet.id, amountCents: 100, ref: "cs_small" });
    await expectHttpError(
      spend(db, { walletId: wallet.id, agent: null, amountCents: 101, description: "too much" }),
      402,
      /Insufficient balance/,
    );
    expect(await getBalanceCents(db, wallet.id)).toBe(100);
    expect(await listLedger(db, wallet.id)).toHaveLength(1);
  });

  it("validates the spend amount and description", async () => {
    const { db, wallet } = await makeWallet();
    await expectHttpError(
      spend(db, { walletId: wallet.id, agent: null, amountCents: 0, description: "x" }),
      400,
    );
    await expectHttpError(
      spend(db, { walletId: wallet.id, agent: null, amountCents: 10, description: "   " }),
      400,
      /description/,
    );
  });
});

describe("agent daily limits", () => {
  it("tracks spend against the limit and refuses the next spend without touching the wallet", async () => {
    const { db, wallet } = await makeWallet();
    await creditTopup(db, { walletId: wallet.id, amountCents: 1000, ref: "cs_limit" });
    const { agent } = await createAgent(db, wallet.id, { name: "Crawler", dailyLimitCents: 300 });

    const first = await spend(db, { walletId: wallet.id, agent, amountCents: 300, description: "call 1" });
    expect(first.agentSpentTodayCents).toBe(300);
    expect(first.balanceCents).toBe(700);

    await expectHttpError(
      spend(db, { walletId: wallet.id, agent, amountCents: 1, description: "call 2" }),
      402,
      /Daily limit/,
    );
    expect(await getBalanceCents(db, wallet.id)).toBe(700);

    const fresh = (await listAgents(db, wallet.id))[0];
    expect(fresh.spent_today_cents).toBe(300);
  });

  it("resets the limit when the UTC day rolls over", async () => {
    const { db, wallet } = await makeWallet();
    await creditTopup(db, { walletId: wallet.id, amountCents: 1000, ref: "cs_day" });
    const { agent } = await createAgent(db, wallet.id, { name: "Crawler", dailyLimitCents: 300 });
    await spend(db, { walletId: wallet.id, agent, amountCents: 300, description: "yesterday" });

    await db
      .prepare("UPDATE ap_agents SET spent_day = '2000-01-01' WHERE id = ?")
      .bind(agent.id)
      .run();

    const next = await spend(db, { walletId: wallet.id, agent, amountCents: 300, description: "today" });
    expect(next.agentSpentTodayCents).toBe(300);
    expect(next.balanceCents).toBe(400);
  });

  it("rejects spending from a revoked agent's key at the auth layer (see auth.test)", async () => {
    const { db, wallet } = await makeWallet();
    const { agent } = await createAgent(db, wallet.id, { name: "Rogue" });
    expect(await revokeAgent(db, wallet.id, agent.id)).toBe(true);
    const row = await db.prepare("SELECT active FROM ap_agents WHERE id = ?").bind(agent.id).first<{ active: number }>();
    expect(row?.active).toBe(0);
  });
});
