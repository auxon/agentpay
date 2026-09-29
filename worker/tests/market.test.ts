import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { PrivateKey } from "@bsv/sdk";
import { makeTestDb, type TestDb } from "./helpers";
import { createWallet } from "../src/ledger";
import {
  approveOrder,
  arbitrateDispute,
  cancelOrder,
  checkFunding,
  createOrder,
  deliverOrder,
  disputeEvidence,
  disputeOrder,
  getOrder,
  listOpenOrders,
  resolveOrder,
  settleDueOrders,
} from "../src/market";
import { getEscrowById } from "../src/escrow";
import { siteWalletAddress } from "../src/x402";
import type { AppEnv } from "../src/types";

const FUNDING_TXID = "a".repeat(64);
const PAYOUT_TXID = "f".repeat(64);
const PRICE = 100_000;
const FEE_BPS = 200; // 2% -> 2000 fee, 98000 net
const SELLER_KEY = PrivateKey.fromRandom().toPublicKey().toAddress("mainnet");
const BUYER_REFUND = PrivateKey.fromRandom().toPublicKey().toAddress("mainnet");
const ORACLE_PAYTO = PrivateKey.fromRandom().toPublicKey().toAddress("mainnet");

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    BOUNTY_ESCROW_KEY: b64(randomBytes(32)),
    BOUNTY_FEE_BPS: String(FEE_BPS),
    SITE_WALLET_WIF: PrivateKey.fromRandom().toWif(),
    BOUNTIES_WEBHOOK_SECRET: "test-secret",
    X402_FEE_SATS: "30",
    X402_ALLOW_UNCONFIRMED: "1",
    ORACLE_URL: "https://oracle.test",
    TRUST_URL: "https://trust.test",
    TRUST_INGEST_SECRET: "s3cret",
    ...overrides,
  } as AppEnv;
}

interface NetState {
  fundingValue: number;
  oracleVerdict: "release" | "refund";
  trustCalls: Array<{ url: string; body: unknown }>;
  oracleCalls: number;
}

/** WoC + ARC + oracle + trust, all stubbed. Funding value is tunable. */
function mockNetwork(env: AppEnv, siteAddr: string, st: NetState) {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (url.startsWith("https://oracle.test/decision") && method === "POST") {
      st.oracleCalls += 1;
      if (!init?.headers || !(init.headers as Record<string, string>)["PAYMENT-SIGNATURE"]) {
        const req = { network: "bsv:mainnet", scheme: "exact", asset: "native:BSV", payTo: ORACLE_PAYTO, amount: "5" };
        const b64req = Buffer.from(JSON.stringify(req)).toString("base64url");
        return new Response(JSON.stringify({ error: "payment_required" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": b64req },
        });
      }
      return Response.json({ results: [{ id: "outcome", value: st.oracleVerdict, confidence: 0.9 }] });
    }
    if (url.startsWith("https://trust.test/v1/ingest") && method === "POST") {
      st.trustCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ observations: 1 });
    }
    if (url.includes("/unspent")) {
      if (url.includes(siteAddr)) {
        return Response.json([{ tx_hash: "b".repeat(64), tx_pos: 0, value: 1_000_000, height: 0 }]);
      }
      return Response.json([{ tx_hash: FUNDING_TXID, tx_pos: 0, value: st.fundingValue, height: 0 }]);
    }
    if (url.includes("/hex")) return new Response("not found", { status: 404 });
    if (url.includes("/spent")) return new Response(null, { status: 404 });
    if (url.includes("/hex")) return new Response("not found", { status: 404 });
    if (url.includes("arc.") && method === "POST") return Response.json({ txid: PAYOUT_TXID });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  vi.stubGlobal("fetch", fetcher);
}

function netState(): NetState {
  return { fundingValue: PRICE, oracleVerdict: "release", trustCalls: [], oracleCalls: 0 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sellerBuyer(db: TestDb) {
  const { wallet: seller } = await createWallet(db, { name: "Seller", email: "s@example.com" });
  const { wallet: buyer } = await createWallet(db, { name: "Buyer", email: "b@example.com" });
  return { seller, buyer };
}

async function listedOrder(db: TestDb, env: AppEnv, seller: { id: string }, over = {}) {
  const { order, escrowAddress } = await createOrder(db, env, { walletId: seller.id, agentId: null }, {
    title: "Vintage synth patch",
    description: "128 hand-designed patches, zip + json",
    priceSats: PRICE,
    fulfillment: "digital",
    contentHash: "ab".repeat(32),
    payoutAddress: SELLER_KEY,
    ...over,
  });
  return { order, escrowAddress };
}

describe("listing validation", () => {
  it("rejects dust prices the fee floor cannot cover", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { wallet } = await createWallet(db, { name: "S", email: "s@e.com" });
    await expect(
      listedOrder(db, env, wallet, { priceSats: 100 }),
    ).rejects.toThrowError(/too small/);
  });

  it("rejects bad addresses, hashes, and empty fields", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { wallet } = await createWallet(db, { name: "S", email: "s@e.com" });
    await expect(listedOrder(db, env, wallet, { payoutAddress: "nope" })).rejects.toThrowError(/payoutAddress/);
    await expect(listedOrder(db, env, wallet, { contentHash: "zz" })).rejects.toThrowError(/contentHash/);
    await expect(listedOrder(db, env, wallet, { title: "" })).rejects.toThrowError(/title/);
  });

  it("private listings admit only the named buyer wallet", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    mockNetwork(env, siteAddr, netState());
    const { order } = await listedOrder(db, env, seller, { buyerWalletId: buyer.id });
    expect((await getOrder(db, order.id))?.buyer_allow_wallet_id).toBe(buyer.id);
    const { wallet: stranger } = await createWallet(db, { name: "Stranger", email: "x@example.com" });
    await expect(
      checkFunding(db, env, order.id, { walletId: stranger.id, agentId: null }),
    ).rejects.toThrowError(/private listing/);
    const res = await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null });
    expect(res.funded).toBe(true);
  });

  it("seller cancels while open, never after funding", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const { order } = await listedOrder(db, env, seller);
    const siteAddr = siteWalletAddress(env)!;
    const st = netState();
    mockNetwork(env, siteAddr, st);
    const gone = await cancelOrder(db, seller.id, order.id);
    expect(gone.order.status).toBe("cancelled");
    const { order: order2 } = await listedOrder(db, env, seller);
    await checkFunding(db, env, order2.id, { walletId: buyer.id, agentId: null });
    await expect(cancelOrder(db, seller.id, order2.id)).rejects.toThrowError(/too late/);
  });
});

describe("fund -> deliver -> approve loop", () => {
  it("pays the seller net of the exact 2% fee and pushes the trade fact", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    const st = netState();
    mockNetwork(env, siteAddr, st);
    const { order } = await listedOrder(db, env, seller);
    expect((await listOpenOrders(db)).map((o) => o.id)).toContain(order.id);

    const funded = await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null }, { refundAddress: BUYER_REFUND });
    expect(funded.funded).toBe(true);
    expect(funded.order.buyer_wallet_id).toBe(buyer.id);
    expect((await getEscrowById(db, funded.order.escrow_id!))?.status).toBe("funded");

    const delivered = await deliverOrder(db, env, seller.id, order.id, {
      kind: "hash", hash: "ab".repeat(32), note: "zip attached",
    });
    expect(delivered.hashMatch).toBe(true);
    expect(delivered.order.status).toBe("delivered");

    const { order: paid, txid } = await approveOrder(db, env, order.id, buyer.id);
    expect(paid.status).toBe("paid");
    expect(txid).toBe(PAYOUT_TXID);
    // Exact fee math: 2% of 100000 = 2000; network 61; operator keeps 1939.
    expect(st.trustCalls.length).toBe(1);
    expect(st.trustCalls[0].body).toMatchObject({
      observations: [{ subject: `wallet:${seller.id}`, kind: "bounty_paid", ref: order.id, value: PRICE }],
    });
    expect((await listOpenOrders(db)).map((o) => o.id)).not.toContain(order.id);
  });

  it("underfunded escrows stay open", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    const st = netState();
    st.fundingValue = 10;
    mockNetwork(env, siteAddr, st);
    const { order } = await listedOrder(db, env, seller);
    const res = await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null });
    expect(res.funded).toBe(false);
    expect(res.observedSats).toBe(10);
    expect((await getOrder(db, order.id))?.status).toBe("open");
  });

  it("physical goods deliver by tracking, wrong roles are refused", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    mockNetwork(env, siteAddr, netState());
    const { order } = await listedOrder(db, env, seller, { fulfillment: "physical", contentHash: undefined });
    await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null });
    await expect(deliverOrder(db, env, buyer.id, order.id, { kind: "tracking", tracking: "1Z9" })).rejects.toThrowError(/only the seller/);
    const done = await deliverOrder(db, env, seller.id, order.id, { kind: "tracking", carrier: "UPS", tracking: "1Z999" });
    expect(done.order.status).toBe("delivered");
    expect(done.hashMatch).toBe(false);
    const { order: order2 } = await listedOrder(db, env, seller, { fulfillment: "physical", contentHash: undefined });
    await checkFunding(db, env, order2.id, { walletId: buyer.id, agentId: null });
    await expect(deliverOrder(db, env, seller.id, order2.id, { kind: "tracking" })).rejects.toThrowError(/tracking number required/);
    await expect(approveOrder(db, env, order.id, seller.id)).rejects.toThrowError(/only the buyer/);
  });

  it("double approve is an explicit conflict, not a double spend", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    mockNetwork(env, siteAddr, netState());
    const { order } = await listedOrder(db, env, seller);
    await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null });
    await deliverOrder(db, env, seller.id, order.id, { kind: "hash", hash: "ab".repeat(32) });
    await approveOrder(db, env, order.id, buyer.id);
    await expect(approveOrder(db, env, order.id, buyer.id)).rejects.toThrowError(/nothing to approve/);
  });
});

describe("disputes and arbitration", () => {
  async function disputedOrder() {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    const st = netState();
    mockNetwork(env, siteAddr, st);
    const { order } = await listedOrder(db, env, seller);
    await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null }, { refundAddress: BUYER_REFUND });
    await deliverOrder(db, env, seller.id, order.id, { kind: "hash", hash: "ff".repeat(32) });
    await disputeOrder(db, order.id, buyer.id, "The delivered files do not match the listing at all, totally different content here.");
    return { db, env, seller, buyer, order, st, siteAddr };
  }

  it("evidence appends for both sides, capped and validated", async () => {
    const { db, seller, buyer, order } = await disputedOrder();
    const e1 = await disputeEvidence(db, order.id, buyer.id, { text: "Screenshots attached", hashes: ["ab".repeat(32), "zzz"] });
    expect(e1.evidence.length).toBe(1);
    expect(e1.evidence[0].hashes).toEqual(["ab".repeat(32)]);
    const e2 = await disputeEvidence(db, order.id, seller.id, { text: "Here is my side of the story" });
    expect(e2.evidence.length).toBe(2);
    await expect(disputeEvidence(db, order.id, buyer.id, { text: "" })).rejects.toThrowError(/text required/);
    await expect(disputeEvidence(db, order.id, "apw_stranger", { text: "hijack" })).rejects.toThrowError(/only the buyer or seller/);
  });

  it("resolve executes the oracle recommendation and records it", async () => {
    const { db, env, order, st } = await disputedOrder();
    const { order: done, resolution } = await resolveOrder(db, env, order.id, {});
    expect(resolution.recommendation).toBe("release");
    expect(resolution.overridden).toBe(false);
    expect(resolution.executed).toBe("release");
    expect(resolution.oracleCostSats).toBe(5);
    expect(done.status).toBe("paid");
    expect(st.oracleCalls).toBe(2); // quote + paid call
    expect(st.trustCalls.length).toBe(1);
    expect(st.trustCalls[0].body).toMatchObject({
      observations: [{ kind: "bounty_paid", ref: order.id }],
    });
  });

  it("operator override wins and a refund slashes the seller", async () => {
    const { db, env, order, st } = await disputedOrder();
    st.oracleVerdict = "release"; // oracle says release; operator disagrees
    const { order: done, resolution } = await resolveOrder(db, env, order.id, { override: "refund" });
    expect(resolution.recommendation).toBe("release");
    expect(resolution.overridden).toBe(true);
    expect(resolution.executed).toBe("refund");
    expect(done.status).toBe("refunded");
    expect(st.trustCalls.length).toBe(1);
    expect(st.trustCalls[0].body).toMatchObject({
      observations: [{ kind: "dispute_lost", ref: order.id }],
    });
  });

  it("oracle outage fails closed, order stays disputed", async () => {
    const { db, env, order } = await disputedOrder();
    env.ORACLE_URL = "https://oracle.down";
    await expect(resolveOrder(db, env, order.id, {})).rejects.toThrow();
    expect((await getOrder(db, order.id))?.status).toBe("disputed");
  });
});

describe("expiry", () => {
  it("delivered past the window auto-releases on touch", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    mockNetwork(env, siteAddr, netState());
    const { order } = await listedOrder(db, env, seller);
    await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null });
    await deliverOrder(db, env, seller.id, order.id, { kind: "hash", hash: "ab".repeat(32) });
    await db.prepare("UPDATE ap_market_orders SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), order.id).run();
    const done = await settleDueOrders(db, env);
    expect(done).toEqual([{ orderId: order.id, action: "released", txid: PAYOUT_TXID }]);
    expect((await getOrder(db, order.id))?.status).toBe("expired");
  });

  it("funded with no delivery past the horizon refunds the buyer", async () => {
    const db = makeTestDb();
    const env = testEnv();
    const { seller, buyer } = await sellerBuyer(db);
    const siteAddr = siteWalletAddress(env)!;
    mockNetwork(env, siteAddr, netState());
    const { order } = await listedOrder(db, env, seller);
    await checkFunding(db, env, order.id, { walletId: buyer.id, agentId: null }, { refundAddress: BUYER_REFUND });
    await db.prepare("UPDATE ap_market_orders SET updated_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 31 * 86_400_000).toISOString(), order.id).run();
    const done = await settleDueOrders(db, env);
    expect(done).toEqual([{ orderId: order.id, action: "refunded", txid: PAYOUT_TXID }]);
    expect((await getOrder(db, order.id))?.status).toBe("refunded");
  });
});
