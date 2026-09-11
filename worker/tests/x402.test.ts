import { describe, expect, it, vi, afterEach } from "vitest";
import { PrivateKey, P2PKH, Transaction } from "@bsv/sdk";
import {
  BSV_NETWORK,
  buildBsvPaymentTx,
  chargeCentsFor,
  fetchSiteWalletUtxos,
  maxPaymentSats,
  parseBsvRequirements,
  prepareBsvPayment,
  siteWalletAddress,
  treasuryStatus,
  type BsvRequirements,
} from "../src/x402";
import { HttpError, type AppEnv } from "../src/types";
import { makeTestDb } from "./helpers";

const PAY_TO = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";

/** Env stub — DB is required by the type but unused by the pure x402 helpers. */
const E = (vars: Partial<AppEnv> = {}): AppEnv => vars as AppEnv;

function requirements(overrides: Record<string, unknown> = {}): unknown {
  return {
    x402Version: 2,
    scheme: "exact",
    network: BSV_NETWORK,
    amount: "10",
    payTo: PAY_TO,
    asset: "native:BSV",
    resource: { url: "https://seller.test/api/timestamp", description: "timestamp" },
    extra: { satoshis: "10", dustFloor: "1", arcUrl: "https://arc.gorillapool.io/v1" },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseBsvRequirements", () => {
  it("accepts the BSV Wallets exact shape", () => {
    const parsed = parseBsvRequirements(requirements());
    expect(parsed).toEqual({
      payTo: PAY_TO,
      satoshis: 10,
      resourceUrl: "https://seller.test/api/timestamp",
      description: "timestamp",
    });
  });

  it("prefers extra.satoshis over amount", () => {
    const parsed = parseBsvRequirements(requirements({ amount: "999", extra: { satoshis: "10" } }));
    expect(parsed.satoshis).toBe(10);
  });

  it("rejects wrong network, asset, scheme, payTo, and amount", () => {
    expect(() => parseBsvRequirements(requirements({ network: "base:mainnet" }))).toThrow(/network/);
    expect(() => parseBsvRequirements(requirements({ asset: "erc20:usdc" }))).toThrow(/asset/);
    expect(() => parseBsvRequirements(requirements({ scheme: "upto" }))).toThrow(/scheme/);
    expect(() => parseBsvRequirements(requirements({ payTo: "not-an-address" }))).toThrow(/P2PKH/);
    expect(() => parseBsvRequirements(requirements({ amount: "0", extra: {} }))).toThrow(/satoshi/);
    expect(() => parseBsvRequirements(null)).toThrow(/malformed/);
  });
});

describe("charging and caps", () => {
  it("charges explicit cents, then conversion, then the 1-cent minimum", () => {
    expect(chargeCentsFor(10, E(), 5)).toBe(5);
    expect(chargeCentsFor(10, E(), 0)).toBe(1);
    expect(chargeCentsFor(10, E({ X402_SATS_PER_CENT: "4" }))).toBe(3);
    expect(chargeCentsFor(10, E({ X402_SATS_PER_CENT: "1000" }))).toBe(1);
    expect(chargeCentsFor(10, E())).toBe(1);
  });

  it("caps per-call payments", () => {
    expect(maxPaymentSats(E())).toBe(10_000);
    expect(maxPaymentSats(E({ X402_MAX_SATS: "42" }))).toBe(42);
    expect(maxPaymentSats(E({ X402_MAX_SATS: "nope" }))).toBe(10_000);
  });
});

async function withFundedSiteWallet<T>(
  fn: (opts: { key: PrivateKey; utxos: { tx_hash: string; tx_pos: number; value: number }[] }) => Promise<T>,
): Promise<T> {
  const key = PrivateKey.fromRandom();
  const utxos = [{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 100_000, height: 100 }];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/unspent")) {
      return new Response(JSON.stringify(utxos), { status: 200 });
    }
    // Spent checks and parent-tx lookups: 404 = unspent / unavailable.
    return new Response("Not Found", { status: 404 });
  });
  try {
    return await fn({ key, utxos });
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("buildBsvPaymentTx", () => {
  it("pays the seller exactly and returns change to the site wallet", async () => {
    const key = PrivateKey.fromRandom();
    const tx = await buildBsvPaymentTx({
      key,
      payTo: PAY_TO,
      satoshis: 10,
      feeSats: 30,
      fetchParent: async () => null,
      utxos: [{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 100_000, height: 100 }],
    });
    const expected = new P2PKH().lock(PAY_TO).toHex();
    const paid = tx.outputs
      .filter((o) => o.lockingScript.toHex() === expected)
      .reduce((sum, o) => sum + (o.satoshis ?? 0), 0);
    expect(paid).toBe(10);
    expect(tx.outputs.length).toBe(3); // payment + change + OP_RETURN nonce
    expect(tx.outputs[2].satoshis).toBe(0);
    expect(tx.inputs.length).toBe(1);
    expect(tx.id("hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.toHex().length).toBeGreaterThan(100);
  });

  it("mints a unique txid per build from the same UTXO (random nonce)", async () => {
    const key = PrivateKey.fromRandom();
    const opts = {
      key,
      payTo: PAY_TO,
      satoshis: 10,
      fetchParent: async () => null,
      utxos: [{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 100_000, height: 100 }],
    };
    const first = await buildBsvPaymentTx(opts);
    const second = await buildBsvPaymentTx(opts);
    expect(first.id("hex")).not.toBe(second.id("hex"));
  });

  it("attaches the full parent tx when a source is available", async () => {
    const key = PrivateKey.fromRandom();
    const parent = new Transaction();
    parent.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 100_000 });
    const tx = await buildBsvPaymentTx({
      key,
      payTo: PAY_TO,
      satoshis: 10,
      fetchParent: async () => parent,
      utxos: [{ tx_hash: parent.id("hex"), tx_pos: 0, value: 100_000, height: 100 }],
    });
    expect(tx.inputs[0].sourceTransaction?.id("hex")).toBe(parent.id("hex"));
    expect(tx.inputs[0].sequence).toBe(0xffffffff);
  });

  it("throws a funding message when the site wallet is empty", async () => {
    const key = PrivateKey.fromRandom();
    await expect(
      buildBsvPaymentTx({ key, payTo: PAY_TO, satoshis: 10, utxos: [] }),
    ).rejects.toThrow(/has 0 sats/);
  });
});

describe("fetchSiteWalletUtxos", () => {
  it("filters outputs that WOC reports as already spent", async () => {
    const stale = { tx_hash: "aa".repeat(32), tx_pos: 1, value: 760, height: 965879 };
    const fresh = { tx_hash: "bb".repeat(32), tx_pos: 1, value: 720, height: 966191 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/unspent")) return new Response(JSON.stringify([stale, fresh]), { status: 200 });
      if (url.includes(`/tx/${stale.tx_hash}/1/spent`)) {
        return new Response(JSON.stringify({ txid: "cc".repeat(32), vin: 0 }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
    const utxos = await fetchSiteWalletUtxos("1TestAddress");
    expect(utxos).toHaveLength(1);
    expect(utxos[0].tx_hash).toBe(fresh.tx_hash);
  });
});

describe("treasuryStatus", () => {
  const wif = PrivateKey.fromRandom().toWif();
  const utxoStub = (value: number) =>
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/unspent")) {
        return new Response(JSON.stringify([{ tx_hash: "ab".repeat(32), tx_pos: 0, value }]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

  it("fetches once, caches, and flags a low balance", async () => {
    const db = makeTestDb();
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls += 1;
      if (url.endsWith("/unspent")) {
        return new Response(JSON.stringify([{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 1_000 }]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
    const env = E({ SITE_WALLET_WIF: wif, X402_MIN_TREASURY_SATS: "5000" });
    const first = await treasuryStatus(db, env);
    expect(first.sats).toBe(1_000);
    expect(first.low).toBe(true);
    expect(first.stale).toBe(false);
    const second = await treasuryStatus(db, env);
    expect(second.sats).toBe(1_000);
    expect(calls).toBe(2); // one unspent read + one spent check, then cached
  });

  it("serves a stale snapshot when WOC fails", async () => {
    const db = makeTestDb();
    utxoStub(50_000);
    const env = E({ SITE_WALLET_WIF: wif, X402_MIN_TREASURY_SATS: "5000" });
    await treasuryStatus(db, env);
    await db.prepare("UPDATE ap_meta SET updated_at = '2000-01-01 00:00:00'").run();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const stale = await treasuryStatus(db, env);
    expect(stale.sats).toBe(50_000);
    expect(stale.stale).toBe(true);
    expect(stale.low).toBe(false);
  });

  it("reports unconfigured without a WIF", async () => {
    const db = makeTestDb();
    const status = await treasuryStatus(db, E());
    expect(status.configured).toBe(false);
    expect(status.address).toBeNull();
  });
});

describe("prepareBsvPayment", () => {
  it("refuses when the WIF is missing or invalid", async () => {
    const reqs: BsvRequirements = { payTo: PAY_TO, satoshis: 10, resourceUrl: null, description: null };
    await expect(prepareBsvPayment(E(), reqs)).rejects.toBeInstanceOf(HttpError);
    await expect(prepareBsvPayment(E({ SITE_WALLET_WIF: "not-a-wif" }), reqs)).rejects.toThrow(/WIF/);
  });

  it("signs a payable tx and returns the PAYMENT-SIGNATURE payload", async () => {
    const key = PrivateKey.fromRandom();
    await withFundedSiteWallet(async () => {
      const env = E({ SITE_WALLET_WIF: key.toWif() });
      const prepared = await prepareBsvPayment(env, {
        payTo: PAY_TO,
        satoshis: 10,
        resourceUrl: null,
        description: null,
      });
      expect(prepared.txid).toMatch(/^[0-9a-f]{64}$/);
      const payload = JSON.parse(Buffer.from(prepared.paymentSignature, "base64").toString("utf8")) as {
        x402Version: number;
        scheme: string;
        network: string;
        txHex: string;
        encoding: string;
      };
      expect(payload.x402Version).toBe(2);
      expect(payload.scheme).toBe("exact");
      expect(payload.network).toBe(BSV_NETWORK);
      expect(payload.encoding).toBe("raw-hex");
      const tx = Transaction.fromHex(payload.txHex);
      expect(tx.id("hex")).toBe(prepared.txid);
      expect(prepared.address).toBe(siteWalletAddress(env));
    });
  });

  it("refuses to spend unconfirmed UTXOs unless explicitly allowed", async () => {
    const key = PrivateKey.fromRandom();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/unspent")) {
        return new Response(
          JSON.stringify([{ tx_hash: "cd".repeat(32), tx_pos: 0, value: 5_000, height: 0 }]),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });
    const reqs: BsvRequirements = { payTo: PAY_TO, satoshis: 10, resourceUrl: null, description: null };
    await expect(prepareBsvPayment(E({ SITE_WALLET_WIF: key.toWif() }), reqs)).rejects.toThrow(/unconfirmed/);
    const allowed = await prepareBsvPayment(
      E({ SITE_WALLET_WIF: key.toWif(), X402_ALLOW_UNCONFIRMED: "1" }),
      reqs,
    );
    expect(allowed.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enforces the per-call sat cap before signing", async () => {
    const key = PrivateKey.fromRandom();
    await withFundedSiteWallet(async () => {
      await expect(
        prepareBsvPayment(E({ SITE_WALLET_WIF: key.toWif(), X402_MAX_SATS: "5" }), {
          payTo: PAY_TO,
          satoshis: 10,
          resourceUrl: null,
          description: null,
        }),
      ).rejects.toThrow(/cap/);
    });
  });
});
