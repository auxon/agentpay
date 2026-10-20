import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PKH, PrivateKey } from "@bsv/sdk";
import { buildBsvPaymentTx, paymentSignaturePayload } from "../src/x402";
import {
  facilitatorSettle,
  facilitatorSupported,
  facilitatorVerify,
  verifyBsvPaymentPayload,
} from "../src/x402-facilitator";
import { BSV_NETWORK, SPEC_VERIFY_REQUEST_EXAMPLE, X402_VERSION, bsvExactRequirements } from "../src/x402-spec";
import { type AppEnv } from "../src/types";
import { makeTestDb } from "./helpers";

const PAY_TO = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signedPayment(satoshis = 500) {
  const key = PrivateKey.fromRandom();
  const tx = await buildBsvPaymentTx({
    key,
    payTo: PAY_TO,
    satoshis,
    feeSats: 30,
    fetchParent: async () => null,
    utxos: [{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 100_000, height: 100 }],
  });
  const locking = new P2PKH().lock(PAY_TO).toHex();
  const requirements = bsvExactRequirements({ amountSats: satoshis, payTo: PAY_TO, lockingScriptHex: locking });
  const payload = paymentSignaturePayload(tx.toHex(), {
    payTo: PAY_TO,
    satoshis,
    resourceUrl: "https://example.test/paid",
    description: "paid",
    lockingScriptHex: locking.toLowerCase(),
    accepted: requirements as unknown as Record<string, unknown>,
    resource: { url: "https://example.test/paid", description: "paid" },
  });
  return { tx, locking, requirements, payload, key };
}

describe("facilitator /verify", () => {
  it("validates a BSV exact p2pkh-rawtx payload", async () => {
    const { payload, requirements, tx } = await signedPayment(500);
    const result = await facilitatorVerify({
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    expect(result.isValid).toBe(true);
    expect(result.payer).toMatch(/^bsv:/);
    expect(verifyBsvPaymentPayload(payload, requirements as unknown as Record<string, unknown>).txid).toBe(tx.id("hex"));
  });

  it("rejects the spec EVM example (wrong network) and the BTC/BCH genesis id", async () => {
    const evm = await facilitatorVerify(SPEC_VERIFY_REQUEST_EXAMPLE);
    expect(evm.isValid).toBe(false);
    expect(evm.invalidReason).toBe("invalid_network");

    const { payload, requirements } = await signedPayment();
    const bip = await facilitatorVerify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: { ...requirements, network: "bip122:000000000019d6689c085ae165831e93" },
    });
    expect(bip.isValid).toBe(false);
    expect(bip.invalidReason).toBe("invalid_network");
  });

  it("rejects an underpay", async () => {
    const { payload, requirements } = await signedPayment(10);
    const result = await facilitatorVerify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: { ...requirements, amount: "999" },
    });
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("insufficient_funds");
  });
});

describe("facilitator /settle", () => {
  it("broadcasts a valid payment and is idempotent on the same txid", async () => {
    const db = makeTestDb();
    const { payload, requirements, tx } = await signedPayment(25);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tx") || url.includes("/raw")) {
        return new Response(JSON.stringify({ txid: tx.id("hex"), txStatus: "SEEN_ON_NETWORK" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
    const env = { DB: db } as AppEnv;
    const first = await facilitatorSettle(env, {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    expect(first.success).toBe(true);
    expect(first.transaction).toBe(tx.id("hex"));
    expect(first.network).toBe(BSV_NETWORK);
    const second = await facilitatorSettle(env, {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    expect(second.success).toBe(true);
    expect(second.extensions).toMatchObject({ status: "already_settled" });
  });

  it("returns settlement_pending with the txid when every broadcaster misses", async () => {
    const { payload, requirements, tx } = await signedPayment(25);
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const settled = await facilitatorSettle({} as AppEnv, {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("settlement_pending");
    expect(settled.transaction).toBe(tx.id("hex"));
  });
});

describe("facilitator /supported", () => {
  it("advertises BSV exact v2 and the bazaar extension", () => {
    const supported = facilitatorSupported(["1BuyerAddress"]);
    expect(supported.kinds).toEqual([
      expect.objectContaining({ x402Version: 2, scheme: "exact", network: BSV_NETWORK }),
    ]);
    expect(supported.extensions).toContain("bazaar");
    expect(supported.signers["bsv:*"]).toEqual(["1BuyerAddress"]);
  });
});
