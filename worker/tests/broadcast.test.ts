import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { ARC_GORILLA, ARC_TAAL, WOC_BROADCAST, broadcastPaymentTx, isBroadcastFailureStatus } from "../src/broadcast";
import { HttpError, type AppEnv } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedTx(): Transaction {
  const tx = new Transaction();
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) });
  return tx;
}

describe("broadcast status classification", () => {
  it("treats double-spend and orphan as failure", () => {
    expect(isBroadcastFailureStatus("DOUBLE_SPEND_ATTEMPTED")).toBe(true);
    expect(isBroadcastFailureStatus("ORPHANED")).toBe(true);
    expect(isBroadcastFailureStatus("REJECTED")).toBe(true);
    expect(isBroadcastFailureStatus("SEEN_ON_NETWORK")).toBe(false);
  });
});

describe("broadcastPaymentTx", () => {
  it("accepts when GorillaPool misses and TAAL plus WhatsOnChain take the tx", async () => {
    const tx = signedTx();
    const txid = tx.id("hex");
    const seen: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith(ARC_GORILLA) && init?.method === "POST") {
        return new Response("not found", { status: 404 });
      }
      if (url.startsWith(ARC_TAAL) && init?.method === "POST") {
        return new Response(JSON.stringify({ txid, txStatus: "ANNOUNCED_TO_NETWORK" }), { status: 200 });
      }
      if (url === WOC_BROADCAST) {
        return new Response(JSON.stringify({ txid }), { status: 200 });
      }
      if (url === `${ARC_TAAL}/tx/${txid}`) {
        return new Response(JSON.stringify({ txid, txStatus: "SEEN_ON_NETWORK" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };
    const result = await broadcastPaymentTx({} as AppEnv, tx, {
      fetch: fakeFetch as typeof fetch,
      sleep: async () => {},
      pollAttempts: 1,
    });
    expect(result.accepted).toBe(true);
    expect(result.via).toEqual(expect.arrayContaining(["whatsonchain", ARC_TAAL]));
    expect(result.status).toMatch(/SEEN_ON_NETWORK|ANNOUNCED/);
  });

  it("fails closed on a double-spend from ARC", async () => {
    const tx = signedTx();
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tx") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ status: 409, title: "conflict", extraInfo: "double spend attempted", txStatus: "DOUBLE_SPEND_ATTEMPTED" }),
          { status: 409 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };
    await expect(
      broadcastPaymentTx({} as AppEnv, tx, { fetch: fakeFetch as typeof fetch, sleep: async () => {} }),
    ).rejects.toThrow(HttpError);
  });

  it("fails closed when ARC later reports the tx orphaned", async () => {
    const tx = signedTx();
    const txid = tx.id("hex");
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tx") && init?.method === "POST") {
        return new Response(JSON.stringify({ txid, txStatus: "ANNOUNCED_TO_NETWORK" }), { status: 200 });
      }
      if (url.includes(`/tx/${txid}`)) {
        return new Response(JSON.stringify({ txid, txStatus: "ORPHANED" }), { status: 200 });
      }
      if (url === WOC_BROADCAST) {
        return new Response(JSON.stringify({ txid }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };
    await expect(
      broadcastPaymentTx({} as AppEnv, tx, {
        fetch: fakeFetch as typeof fetch,
        sleep: async () => {},
        pollAttempts: 1,
      }),
    ).rejects.toThrow(/ORPHANED/);
  });

  it("returns accepted:false when every endpoint misses", async () => {
    const tx = signedTx();
    const fakeFetch = async () => new Response("Not Found", { status: 404 });
    const result = await broadcastPaymentTx({} as AppEnv, tx, { fetch: fakeFetch as typeof fetch });
    expect(result.accepted).toBe(false);
    expect(result.via).toEqual([]);
  });
});
