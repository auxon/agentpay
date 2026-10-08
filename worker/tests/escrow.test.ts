import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { PrivateKey } from "@bsv/sdk";
import { makeTestDb } from "./helpers";
import { createWallet, creditTopup, listLedger } from "../src/ledger";
import {
  buildP2pkhTx,
  createEscrowRow,
  decryptEscrowWif,
  encryptEscrowWif,
  escrowAddressFor,
  generateEscrowWif,
  getEscrowRow,
} from "../src/escrow";
import {
  chargeCentsForSats,
  linkBounty,
  processEscrowEvent,
  workerRefFor,
} from "../src/bounties";
import { HttpError, type AppEnv } from "../src/types";

const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const FUNDING_TXID = "a".repeat(64);
const PAYOUT_TXID = "f".repeat(64);
const AMOUNT_SATS = 4_000_000; // $1 at 40000 sats/cent
const FEE_BPS = 200; // 2% → 80000 sats fee, 3920000 net

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    BOUNTY_ESCROW_KEY: b64(randomBytes(32)),
    BOUNTY_SATS_PER_CENT: "40000",
    SITE_WALLET_WIF: PrivateKey.fromRandom().toWif(),
    BOUNTIES_WEBHOOK_SECRET: "test-secret",
    X402_FEE_SATS: "30",
    ...overrides,
  } as AppEnv;
}

/** WOC + ARC + bounties API, so escrow flows run without network. */
function mockNetwork(opts: { arcTxid?: string } = {}) {
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("bsv-bounties")) return Response.json({ bounty: { ok: true } });
    if (url.includes("/spent")) return new Response(null, { status: 404 });
    if (url.endsWith("/unspent")) {
      return Response.json([{ tx_hash: FUNDING_TXID, tx_pos: 0, value: AMOUNT_SATS, height: 100 }]);
    }
    if (url.includes("/hex")) return new Response("not found", { status: 404 });
    if (url.endsWith("/tx")) return Response.json({ txid: opts.arcTxid ?? PAYOUT_TXID });
    throw new Error(`unexpected fetch: ${url}`);
  };
  vi.stubGlobal("fetch", fetcher);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeEscrowFixture(env: AppEnv, chargedCents: number) {
  const db = makeTestDb();
  const { wallet: poster } = await createWallet(db, { name: "Poster", email: "p@example.com" });
  const { wallet: worker } = await createWallet(db, { name: "Worker", email: "w@example.com" });
  await creditTopup(db, { walletId: poster.id, amountCents: chargedCents, ref: "cs_poster" });

  const escrowWif = generateEscrowWif();
  const escrowAddress = escrowAddressFor(escrowWif);
  await createEscrowRow(db, {
    id: "ape_test",
    walletId: poster.id,
    agentId: null,
    title: "Test bounty",
    amountSats: AMOUNT_SATS,
    feeBps: FEE_BPS,
    chargedCents,
    postRef: "bounty-escrow:ape_test",
    escrowWifEnc: await encryptEscrowWif(env, escrowWif),
    escrowAddress,
    status: "open",
  });
  await db
    .prepare("UPDATE ap_bounty_escrows SET bounty_id = ?, funding_txid = ? WHERE id = ?")
    .bind("b1", FUNDING_TXID, "ape_test")
    .run();
  await linkBounty(db, {
    bountyId: "b1",
    walletId: worker.id,
    agentId: null,
    workerRef: workerRefFor(worker.id),
    title: "Test bounty",
    amountSats: AMOUNT_SATS,
  });
  return { db, poster, worker, escrowWif, escrowAddress };
}

describe("escrow key storage", () => {
  it("round-trips a WIF through AES-GCM", async () => {
    const env = testEnv();
    const wif = generateEscrowWif();
    const blob = await encryptEscrowWif(env, wif);
    expect(blob).not.toContain(wif);
    const key = await decryptEscrowWif(env, blob);
    expect(key.toWif()).toBe(wif);
  });

  it("fails closed when the key changes", async () => {
    const blob = await encryptEscrowWif(testEnv(), generateEscrowWif());
    await expect(decryptEscrowWif(testEnv(), blob)).rejects.toBeInstanceOf(HttpError);
  });
});

describe("escrow transactions", () => {
  it("rounds charges up", () => {
    const env = testEnv();
    expect(chargeCentsForSats(40000, env)).toBe(1);
    expect(chargeCentsForSats(40001, env)).toBe(2);
    expect(chargeCentsForSats(1, env)).toBe(1);
  });

  it("builds a signed tx with payout, change, marker and nonce", async () => {
    const key = PrivateKey.fromRandom();
    const tx = await buildP2pkhTx({
      key,
      utxos: [{ tx_hash: FUNDING_TXID, tx_pos: 0, value: 100_000, height: 1 }],
      outputs: [{ address: PrivateKey.fromRandom().toAddress(), satoshis: 50_000 }],
      feeSats: 30,
      fetchParent: async () => null,
    });
    expect(tx.outputs[0].satoshis).toBe(50_000);
    expect(tx.outputs.some((o) => o.satoshis === 49_970)).toBe(true); // change
    const total = tx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0);
    expect(total).toBe(99_970);
    expect(tx.id("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to build without enough sats", async () => {
    await expect(
      buildP2pkhTx({
        key: PrivateKey.fromRandom(),
        utxos: [{ tx_hash: FUNDING_TXID, tx_pos: 0, value: 100, height: 1 }],
        outputs: [{ address: PrivateKey.fromRandom().toAddress(), satoshis: 50_000 }],
        feeSats: 30,
        fetchParent: async () => null,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("processEscrowEvent", () => {
  it("pays a linked worker: sweeps to treasury, credits the balance", async () => {
    const env = testEnv();
    const { db, worker } = await makeEscrowFixture(env, 100);
    mockNetwork();

    const result = await processEscrowEvent(db, env, {
      bountyId: "b1",
      outcome: "paid",
      funding: "agentpay",
    });
    expect(result.credited).toBe(true);
    expect(result.amountCents).toBe(98); // 3,920,000 sats net / 40000

    const row = await getEscrowRow(db, "b1");
    expect(row?.status).toBe("paid");
    expect(row?.payout_txid).toBe(PAYOUT_TXID);

    const balance = await db
      .prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?")
      .bind(worker.id)
      .first<{ balance_cents: number }>();
    expect(balance?.balance_cents).toBe(98);
    const events = await listLedger(db, worker.id);
    expect(events[0].ref).toBe("bounty:b1");
    expect(events[0].amount_cents).toBe(98);
  });

  it("refunds the poster when the bounty is refunded", async () => {
    const env = testEnv();
    const { db, poster } = await makeEscrowFixture(env, 100);
    mockNetwork();

    const result = await processEscrowEvent(db, env, {
      bountyId: "b1",
      outcome: "refunded",
      funding: "agentpay",
    });
    expect(result.reason).toBe("refunded");
    const row = await getEscrowRow(db, "b1");
    expect(row?.status).toBe("refunded");
    expect(row?.refund_txid).toBe(PAYOUT_TXID);

    const balance = await db
      .prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?")
      .bind(poster.id)
      .first<{ balance_cents: number }>();
    expect(balance?.balance_cents).toBe(200); // 100 charge + 100 refund
  });

  it("is idempotent on replay", async () => {
    const env = testEnv();
    const { db, worker } = await makeEscrowFixture(env, 100);
    mockNetwork();
    await processEscrowEvent(db, env, { bountyId: "b1", outcome: "paid", funding: "agentpay" });
    const replay = await processEscrowEvent(db, env, {
      bountyId: "b1",
      outcome: "paid",
      funding: "agentpay",
    });
    expect(replay.credited).toBe(false);
    expect(replay.reason).toBe("already_paid");
    const balance = await db
      .prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?")
      .bind(worker.id)
      .first<{ balance_cents: number }>();
    expect(balance?.balance_cents).toBe(98);
  });

  it("leaves the escrow pending when the worker has no link", async () => {
    const env = testEnv();
    const { db } = await makeEscrowFixture(env, 100);
    await db.prepare("DELETE FROM ap_bounty_links").run();
    mockNetwork();
    const result = await processEscrowEvent(db, env, {
      bountyId: "b1",
      outcome: "paid",
      funding: "agentpay",
    });
    expect(result.reason).toBe("payout_target_missing");
    expect((await getEscrowRow(db, "b1"))?.status).toBe("payout_pending");
  });

});
