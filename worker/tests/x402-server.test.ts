import { describe, expect, it } from "vitest";
import { PrivateKey } from "@bsv/sdk";
import { api } from "../src/api";
import { type AppEnv } from "../src/types";
import { makeTestDb, type TestDb } from "./helpers";
import {
  BSV_NETWORK,
  decodeX402Json,
  paymentRequiredGaps,
  paymentPayloadGaps,
  readPaymentRequiredHeader,
  readPaymentSignatureHeader,
} from "../src/x402-spec";
import { paymentSignaturePayload } from "../src/x402";

const execCtx = {
  waitUntil(p: Promise<unknown>) {
    void Promise.resolve(p).catch(() => {});
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function req(path: string, db: TestDb, init: RequestInit = {}, envExtra: Partial<AppEnv> = {}) {
  const env = { DB: db, ...envExtra } as AppEnv;
  return api.request(path, init, env, execCtx);
}

describe("x402 discovery + well-known", () => {
  it("serves /.well-known/x402 with Fuse + agentpay resources and facilitator URLs", async () => {
    const db = makeTestDb();
    const wif = PrivateKey.fromRandom().toWif();
    const res = await req("/api/agentpay/.well-known/x402", db, {}, { SITE_WALLET_WIF: wif });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      x402Version: number;
      network: string;
      resources: string[];
      facilitator: { verify: string; settle: string };
    };
    expect(body.version).toBe(1);
    expect(body.x402Version).toBe(2);
    expect(body.network).toBe(BSV_NETWORK);
    expect(body.resources.some((u) => u.endsWith("/x402/chat"))).toBe(true);
    expect(body.resources.some((u) => u.includes("/fuse/v1/chat/completions"))).toBe(true);
    expect(body.facilitator.verify).toContain("/x402/verify");
  });

  it("lists discovery resources in the spec catalog shape", async () => {
    const db = makeTestDb();
    const res = await req("/api/agentpay/discovery/resources?network=bsv:mainnet", db);
    const body = (await res.json()) as {
      x402Version: number;
      items: Array<{ resource: string; type: string; accepts: unknown[]; lastUpdated: string }>;
      pagination: { total: number };
    };
    expect(body.x402Version).toBe(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(item.type).toBe("http");
      expect(item.accepts.length).toBeGreaterThan(0);
      expect(item.lastUpdated).toBeTruthy();
    }
  });
});

describe("x402 resource server 402 challenges", () => {
  it("returns a spec-complete PAYMENT-REQUIRED for unpaid chat (GET probe)", async () => {
    const db = makeTestDb();
    const key = PrivateKey.fromRandom();
    const res = await req("/api/agentpay/x402/chat", db, { method: "GET" }, { SITE_WALLET_WIF: key.toWif() });
    expect(res.status).toBe(402);
    const header = readPaymentRequiredHeader(res.headers);
    expect(header).toBeTruthy();
    const required = decodeX402Json(header!);
    expect(paymentRequiredGaps(required)).toEqual([]);
    const body = (await res.json()) as { accepts: Array<{ network: string; amount: string; extra: Record<string, unknown> }> };
    expect(body.accepts[0].network).toBe(BSV_NETWORK);
    expect(typeof body.accepts[0].amount).toBe("string");
    expect(body.accepts[0].extra.payloadFormat).toEqual({ kind: "p2pkh-rawtx" });
    expect(body.accepts[0].extra.paymentFlow).toBe("upfront");
    expect((required as { extensions: { bazaar: { info: unknown } } }).extensions.bazaar.info).toBeTruthy();
  });

  it("returns a spec-complete 402 for unpaid extract POST without a payment header", async () => {
    const db = makeTestDb();
    const key = PrivateKey.fromRandom();
    const res = await req(
      "/api/agentpay/x402/extract",
      db,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      { SITE_WALLET_WIF: key.toWif() },
    );
    expect(res.status).toBe(402);
    expect(paymentRequiredGaps(decodeX402Json(readPaymentRequiredHeader(res.headers)!))).toEqual([]);
  });

  it("503s the challenge when the site wallet is not configured", async () => {
    const db = makeTestDb();
    const res = await req("/api/agentpay/x402/chat", db, { method: "GET" });
    expect(res.status).toBe(503);
  });
});

describe("facilitator HTTP routes", () => {
  it("exposes /x402/supported and the spec /supported alias", async () => {
    const db = makeTestDb();
    const wif = PrivateKey.fromRandom().toWif();
    const res = await req("/api/agentpay/x402/supported", db, {}, { SITE_WALLET_WIF: wif });
    const alias = await req("/api/agentpay/supported", db, {}, { SITE_WALLET_WIF: wif });
    expect(res.status).toBe(200);
    expect(await alias.json()).toEqual(await res.json());
    const supported = await req("/api/agentpay/x402/supported", db, {}, { SITE_WALLET_WIF: wif });
    const body = (await supported.json()) as { kinds: Array<{ network: string }>; extensions: string[] };
    expect(body.kinds[0].network).toBe(BSV_NETWORK);
    expect(body.extensions).toContain("bazaar");
  });

  it("POST /x402/verify rejects a malformed body with invalid_payload", async () => {
    const db = makeTestDb();
    const res = await req("/api/agentpay/x402/verify", db, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("payer PaymentPayload is spec-shaped", () => {
  it("always includes accepted + payload (v2) while keeping legacy txHex", () => {
    const payload = paymentSignaturePayload("00".repeat(50), {
      payTo: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4",
      satoshis: 10,
      resourceUrl: "https://seller.test/x",
      description: "x",
      accepted: null,
    });
    expect(paymentPayloadGaps(payload)).toEqual([]);
    expect(payload.txHex).toBe("00".repeat(50));
    expect((payload.payload as { rawtx: string }).rawtx).toBe("00".repeat(50));
    expect(readPaymentSignatureHeader(new Headers({ "X-PAYMENT": "legacy-only" }))).toBe("legacy-only");
  });
});
