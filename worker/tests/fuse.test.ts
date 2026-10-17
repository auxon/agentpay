import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@bsv/sdk";
import { api } from "../src/api";
import { createAgent, createWallet, creditTopup, setAgentPolicy } from "../src/ledger";
import { FUSE_DEFAULT_MODEL, parseFuseChatBody, parseFuseModel } from "../src/fuse";
import { BSV_NETWORK } from "../src/x402";
import { HttpError, type AppEnv } from "../src/types";
import { makeTestDb, type TestDb } from "./helpers";

const PAY_TO = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";
const FUSE_URL = "https://fuse.test/v1/chat/completions";
const LOCKING = "76a914d69d9002e2522e3bf05f31cb7efa1e9562547f5a88ac";

function fuseChallenge(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: FUSE_URL,
      description: "Fuse Fast chat completion (500 sats, max 512 tokens)",
    },
    accepts: [
      {
        scheme: "exact",
        network: BSV_NETWORK,
        amount: "500",
        asset: "BSV",
        payTo: PAY_TO,
        extra: {
          lockingScriptHex: LOCKING,
          perCallSats: 500,
          payloadFormat: { kind: "p2pkh-rawtx" },
          model: "fuse-fast",
        },
        ...overrides,
      },
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "10000",
        asset: "USDC",
        payTo: "0x" + "ab".repeat(20),
      },
    ],
  };
}

function b64json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

const execCtx = {
  waitUntil(p: Promise<unknown>) {
    void Promise.resolve(p).catch(() => {});
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function req(path: string, db: TestDb, init: RequestInit, envExtra: Partial<AppEnv> = {}) {
  const env = { DB: db, ...envExtra } as AppEnv;
  return api.request(path, init, env, execCtx);
}

async function jsonOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function fundedAgent(db: TestDb, cents = 500) {
  const { wallet } = await createWallet(db, { name: "Owner" });
  const { agent, key } = await createAgent(db, wallet.id, { name: "Worker" });
  await creditTopup(db, { walletId: wallet.id, amountCents: cents, ref: `cs_${wallet.id}` });
  return { wallet, agent, key };
}

function stubNetwork(opts: { fusePaid?: Record<string, unknown>; fuseStatus?: number } = {}) {
  const wifKey = PrivateKey.fromRandom();
  const utxos = [{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 100_000, height: 100 }];
  const paidCalls: Array<{ signature: string | null; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(FUSE_URL) && method === "POST") {
      const headers = new Headers(init?.headers);
      const sig = headers.get("PAYMENT-SIGNATURE");
      paidCalls.push({ signature: sig, body: JSON.parse(String(init?.body ?? "{}")) });
      if (!sig) {
        const challenge = fuseChallenge();
        return new Response(JSON.stringify(challenge), {
          status: 402,
          headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64json(challenge) },
        });
      }
      return new Response(
        JSON.stringify(
          opts.fusePaid ?? {
            id: "chatcmpl_test",
            choices: [{ message: { role: "assistant", content: "pong" } }],
          },
        ),
        {
          status: opts.fuseStatus ?? 200,
          headers: { "content-type": "application/json", "X-Fuse-Receipt": "https://entangleit.com/fuse/r/test" },
        },
      );
    }
    if (url.endsWith("/unspent")) {
      return new Response(JSON.stringify(utxos), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  });
  return { wif: wifKey.toWif(), paidCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fuse chat input", () => {
  it("defaults to fuse-fast and validates messages", () => {
    expect(parseFuseModel(undefined)).toBe(FUSE_DEFAULT_MODEL);
    const body = parseFuseChatBody({ messages: [{ role: "user", content: "ping" }] });
    expect(body.model).toBe("fuse-fast");
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("rejects unknown models and empty messages", () => {
    expect(() => parseFuseModel("gpt-4")).toThrow(HttpError);
    expect(() => parseFuseChatBody({ model: "fuse-fast", messages: [] })).toThrow(/non-empty/);
    expect(() => parseFuseChatBody({ model: "fuse-pro", messages: [{ role: "user", content: "x" }] })).toThrow(
      /Unknown model/,
    );
  });
});

describe("MCP surface", () => {
  it("advertises chat at version 0.2.0 on the agent card and llms.txt", async () => {
    const db = makeTestDb();
    const card = await jsonOf(await req("/api/agentpay/agent-card", db, { method: "GET" }));
    expect(card.status).toBe(200);
    expect(card.body.version).toBe("0.2.0");
    expect(card.body.tools).toEqual(expect.arrayContaining(["chat", "pay_service"]));
    const llms = await req("/api/agentpay/llms.txt", db, { method: "GET" });
    expect(llms.status).toBe(200);
    const text = await llms.text();
    expect(text).toMatch(/Pay-per-call LLM, no API key/i);
    expect(text).toContain("chat");
  });
});

describe("POST /agent/chat", () => {
  it("dry-runs a standard v2 Fuse 402 without debiting", async () => {
    const db = makeTestDb();
    const { key, wallet } = await fundedAgent(db);
    const { wif } = stubNetwork();
    const { status, body } = await jsonOf(
      await req(
        "/api/agentpay/agent/chat",
        db,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "fuse-fast",
            messages: [{ role: "user", content: "ping" }],
            dryRun: true,
          }),
        },
        { SITE_WALLET_WIF: wif, FUSE_CHAT_URL: FUSE_URL, X402_ALLOW_UNCONFIRMED: "1" },
      ),
    );
    expect(status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.satoshis).toBe(500);
    expect(body.chargedCents).toBe(1);
    expect(body.payTo).toBe(PAY_TO);
    const row = await db.prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?").bind(wallet.id).first<{
      balance_cents: number;
    }>();
    expect(row?.balance_cents).toBe(500);
  });

  it("pays Fuse, returns the completion, receipt URL, and txid", async () => {
    const db = makeTestDb();
    const { key, wallet } = await fundedAgent(db);
    const { wif, paidCalls } = stubNetwork();
    const { status, body } = await jsonOf(
      await req(
        "/api/agentpay/agent/chat",
        db,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "fuse-fast",
            messages: [{ role: "user", content: "ping" }],
          }),
        },
        { SITE_WALLET_WIF: wif, FUSE_CHAT_URL: FUSE_URL },
      ),
    );
    expect(status).toBe(200);
    expect(body.text).toBe("pong");
    expect(body.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(String(body.receiptUrl)).toContain("/api/agentpay/agent/receipts/");
    expect(String(body.explorerUrl)).toContain(String(body.txid));
    expect(body.satoshis).toBe(500);
    expect(body.chargedCents).toBe(1);
    expect(body.balanceCents).toBe(499);
    expect(paidCalls).toHaveLength(2);
    expect(paidCalls[1].signature).toBeTruthy();
    const payload = JSON.parse(Buffer.from(String(paidCalls[1].signature), "base64").toString("utf8")) as {
      txHex: string;
      payload?: { rawtx?: string };
    };
    expect(payload.txHex.length).toBeGreaterThan(100);
    expect(payload.payload?.rawtx).toBe(payload.txHex);
    const row = await db.prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?").bind(wallet.id).first<{
      balance_cents: number;
    }>();
    expect(row?.balance_cents).toBe(499);
  });

  it("enforces the chat allowlist", async () => {
    const db = makeTestDb();
    const { key, agent, wallet } = await fundedAgent(db);
    await setAgentPolicy(db, wallet.id, agent.id, { allowedTools: ["other:tool"] });
    const { wif } = stubNetwork();
    const { status, body } = await jsonOf(
      await req(
        "/api/agentpay/agent/chat",
        db,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: "ping" }],
          }),
        },
        { SITE_WALLET_WIF: wif, FUSE_CHAT_URL: FUSE_URL },
      ),
    );
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/allowlist/);
  });

  it("rejects an unknown model before contacting Fuse", async () => {
    const db = makeTestDb();
    const { key } = await fundedAgent(db);
    const { status, body } = await jsonOf(
      await req(
        "/api/agentpay/agent/chat",
        db,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: "ping" }],
          }),
        },
      ),
    );
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/Unknown model/);
  });
});
