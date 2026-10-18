import { describe, expect, it, vi, afterEach } from "vitest";
import { PrivateKey, P2PKH, Transaction } from "@bsv/sdk";
import {
  BSV_NETWORK,
  buildBsvPaymentTx,
  chargeCentsFor,
  fetchSiteWalletUtxos,
  maxPaymentSats,
  parseBsvRequirements,
  paymentSignaturePayload,
  prepareBsvPayment,
  siteWalletAddress,
  treasuryStatus,
  type BsvRequirements,
} from "../src/x402";
import { loadParentTx } from "../src/coins";
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
      lockingScriptHex: null,
      accepted: null,
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

  it("accepts a standard x402 v2 accepts[] envelope and ignores non-BSV rails", () => {
    const locking = "76a914d69d9002e2522e3bf05f31cb7efa1e9562547f5a88ac";
    const bsvAccept = {
      scheme: "exact",
      network: BSV_NETWORK,
      amount: "500",
      asset: "BSV",
      payTo: PAY_TO,
      maxTimeoutSeconds: 900,
      extra: {
        chain: "bsv",
        unit: "satoshi",
        lockingScriptHex: locking,
        perCallSats: 500,
        payloadFormat: { kind: "p2pkh-rawtx" },
        model: "fuse-fast",
      },
    };
    const usdcAccept = {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
      asset: "USDC",
      payTo: "0x" + "ab".repeat(20),
    };
    const parsed = parseBsvRequirements({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: {
        url: "https://entangleit.com/fuse/v1/chat/completions",
        description: "Fuse Fast chat completion (500 sats, max 512 tokens)",
      },
      accepts: [usdcAccept, bsvAccept],
    });
    expect(parsed.payTo).toBe(PAY_TO);
    expect(parsed.satoshis).toBe(500);
    expect(parsed.resourceUrl).toBe("https://entangleit.com/fuse/v1/chat/completions");
    expect(parsed.description).toMatch(/Fuse Fast/);
    expect(parsed.lockingScriptHex).toBe(locking);
    expect(parsed.accepted).toMatchObject({ asset: "BSV", amount: "500" });
  });

  it("prefers extra.perCallSats when extra.satoshis is absent", () => {
    const parsed = parseBsvRequirements({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: BSV_NETWORK,
          amount: "1",
          asset: "BSV",
          payTo: PAY_TO,
          extra: { perCallSats: 2500, payloadFormat: { kind: "p2pkh-rawtx" } },
        },
      ],
    });
    expect(parsed.satoshis).toBe(2500);
  });

  it("rejects an accepts[] envelope with only non-BSV rails", () => {
    expect(() =>
      parseBsvRequirements({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "base:mainnet", asset: "USDC", payTo: "0xabc", amount: "1" }],
      }),
    ).toThrow(/no BSV exact accept/);
  });

  it("builds a v2 PAYMENT-SIGNATURE that keeps txHex and adds payload.rawtx", () => {
    const parsed = parseBsvRequirements({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: BSV_NETWORK,
          amount: "500",
          asset: "BSV",
          payTo: PAY_TO,
          extra: { lockingScriptHex: "76a914aa".repeat(1) + "88ac", payloadFormat: { kind: "p2pkh-rawtx" } },
        },
      ],
    });
    const payload = paymentSignaturePayload("deadbeef", parsed);
    expect(payload.txHex).toBe("deadbeef");
    expect(payload.encoding).toBe("raw-hex");
    expect((payload.payload as { rawtx: string }).rawtx).toBe("deadbeef");
    expect((payload.payload as { lockingScriptHex: string }).lockingScriptHex).toBe(parsed.lockingScriptHex);
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

  it("never reselects a spent outpoint when the indexer still lists it as unspent", async () => {
    const db = makeTestDb();
    const key = PrivateKey.fromRandom();
    const firstCoin = { tx_hash: "aa".repeat(32), tx_pos: 0, value: 80_000, height: 200 };
    const secondCoin = { tx_hash: "bb".repeat(32), tx_pos: 0, value: 70_000, height: 199 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/unspent")) {
        return new Response(JSON.stringify([firstCoin, secondCoin]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
    const reqs: BsvRequirements = { payTo: PAY_TO, satoshis: 10, resourceUrl: null, description: null };
    const env = E({ SITE_WALLET_WIF: key.toWif(), DB: db });
    const first = await prepareBsvPayment(env, reqs);
    const firstTx = Transaction.fromHex(
      (JSON.parse(Buffer.from(first.paymentSignature, "base64").toString("utf8")) as { txHex: string }).txHex,
    );
    expect(firstTx.inputs[0].sourceTXID).toBe(firstCoin.tx_hash);
    const spent = await db
      .prepare("SELECT spend_txid FROM ap_treasury_spent WHERE txid = ? AND vout = ?")
      .bind(firstCoin.tx_hash, 0)
      .first<{ spend_txid: string }>();
    expect(spent?.spend_txid).toBe(first.txid);

    const second = await prepareBsvPayment(env, reqs);
    const secondTx = Transaction.fromHex(
      (JSON.parse(Buffer.from(second.paymentSignature, "base64").toString("utf8")) as { txHex: string }).txHex,
    );
    expect(secondTx.inputs[0].sourceTXID).toBe(secondCoin.tx_hash);
    expect(second.txid).not.toBe(first.txid);
  });

  it("skips unconfirmed change even when WOC lists it (orphaned-parent guard)", async () => {
    const db = makeTestDb();
    const key = PrivateKey.fromRandom();
    const coin = { tx_hash: "aa".repeat(32), tx_pos: 0, value: 80_000, height: 200 };
    const listed = [coin];
    const hexFetches: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/unspent")) {
        return new Response(JSON.stringify(listed), { status: 200 });
      }
      if (url.endsWith("/hex")) hexFetches.push(url);
      return new Response("Not Found", { status: 404 });
    });
    const reqs: BsvRequirements = { payTo: PAY_TO, satoshis: 10, resourceUrl: null, description: null };
    const env = E({ SITE_WALLET_WIF: key.toWif(), DB: db });
    const first = await prepareBsvPayment(env, reqs);
    const change = await db
      .prepare("SELECT txid, vout, value, hex FROM ap_treasury_change LIMIT 1")
      .first<{ txid: string; vout: number; value: number; hex: string }>();
    expect(change?.hex).toBeTruthy();
    expect(change?.value).toBeGreaterThan(0);

    listed.splice(
      0,
      listed.length,
      coin,
      { tx_hash: change!.txid, tx_pos: change!.vout, value: change!.value, height: 0 },
    );
    await expect(prepareBsvPayment(env, reqs)).rejects.toThrow(/unconfirmed|no confirmed/);

    listed.splice(0, listed.length, {
      tx_hash: change!.txid,
      tx_pos: change!.vout,
      value: change!.value,
      height: 300,
    });
    const parent = await loadParentTx(change!.txid, db, async () => null);
    expect(parent?.id("hex")).toBe(change!.txid);

    hexFetches.length = 0;
    const second = await prepareBsvPayment(env, reqs);
    const payload = JSON.parse(Buffer.from(second.paymentSignature, "base64").toString("utf8")) as {
      txHex: string;
      txHexEF?: string;
      txHexBEEF?: string;
    };
    const secondTx = Transaction.fromHex(payload.txHex);
    expect(secondTx.inputs[0].sourceTXID).toBe(change!.txid);
    expect(hexFetches.some((u) => u.includes(change!.txid))).toBe(false);
    expect(payload.txHexEF || payload.txHexBEEF).toBeTruthy();
  });
});
