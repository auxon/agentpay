import { describe, expect, it } from "vitest";
import { api } from "../src/api";
import { makeTestDb, type TestDb } from "./helpers";
import { createWallet, createAgent, creditTopup, getBalanceCents, listLedger, setAgentPolicy } from "../src/ledger";
import { isAgentpayWalletId, isWalletTokenShape, parseSendDest } from "../src/bounties";
import { HttpError, type AppEnv } from "../src/types";

const P2PKH = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

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
  const { wallet } = await createWallet(db, { name: "Sender" });
  const { agent, key } = await createAgent(db, wallet.id, { name: "Payer" });
  await creditTopup(db, { walletId: wallet.id, amountCents: cents, ref: `cs_${wallet.id}` });
  // Pin BSV/USD so send does not call CoinGecko (25 USD → 40_000 sats/cent).
  await db
    .prepare(
      "INSERT INTO ap_meta (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind("price:BSV_USD", "25")
    .run();
  return { wallet, agent, key };
}

function send(db: TestDb, key: string, body: Record<string, unknown>, envExtra: Partial<AppEnv> = {}) {
  return req(
    "/api/agentpay/agent/send",
    db,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    envExtra,
  );
}

describe("ap_sends idempotency", () => {
  it("creates the ap_sends table with the expected columns", async () => {
    const db = makeTestDb();
    const cols = await db
      .prepare("SELECT name FROM pragma_table_info('ap_sends') ORDER BY name")
      .all<{ name: string }>();
    const names = cols.results.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("wallet_id");
    expect(names).toContain("dest");
    expect(names).toContain("sats");
    expect(names).toContain("idempotency_key");
    expect(names).toContain("txid");
    expect(names).toContain("status");
    expect(names).toContain("settlement");
    expect(names).toContain("dest_wallet_id");
  });

  it("enforces unique idempotency_key per wallet", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent } = await createAgent(db, wallet.id, { name: "Test" });

    await db
      .prepare(
        `INSERT INTO ap_sends (id, wallet_id, agent_id, dest, sats, idempotency_key, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .bind("snd_1", wallet.id, agent.id, P2PKH, 1000, "key-123")
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO ap_sends (id, wallet_id, agent_id, dest, sats, idempotency_key, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind("snd_2", wallet.id, agent.id, P2PKH, 1000, "key-123")
        .run(),
    ).rejects.toThrow();

    const { wallet: wallet2 } = await createWallet(db, { name: "Owner2" });
    await expect(
      db
        .prepare(
          `INSERT INTO ap_sends (id, wallet_id, agent_id, dest, sats, idempotency_key, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind("snd_3", wallet2.id, agent.id, P2PKH, 1000, "key-123")
        .run(),
    ).resolves.toBeTruthy();

    await db
      .prepare(
        `INSERT INTO ap_sends (id, wallet_id, dest, sats, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .bind("snd_4", wallet.id, P2PKH, 500)
      .run();
    await db
      .prepare(
        `INSERT INTO ap_sends (id, wallet_id, dest, sats, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .bind("snd_5", wallet.id, P2PKH, 600)
      .run();
  });

  it("retrieves prior completed send by idempotency key", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });

    await db
      .prepare(
        `INSERT INTO ap_sends (id, wallet_id, dest, sats, memo, idempotency_key, txid, status, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', datetime('now'))`,
      )
      .bind("snd_1", wallet.id, P2PKH, 1000, "test", "key-abc", "abcd".repeat(16))
      .run();

    const prior = await db
      .prepare("SELECT txid, status, sats, dest FROM ap_sends WHERE wallet_id = ? AND idempotency_key = ?")
      .bind(wallet.id, "key-abc")
      .first<{ txid: string; status: string; sats: number; dest: string }>();

    expect(prior?.status).toBe("complete");
    expect(prior?.txid).toBe("abcd".repeat(16));
    expect(prior?.sats).toBe(1000);
  });
});

describe("parseSendDest", () => {
  it("accepts P2PKH addresses and public wallet ids, rejects tokens", () => {
    expect(parseSendDest(P2PKH)).toEqual({ kind: "p2pkh", dest: P2PKH });
    expect(isAgentpayWalletId("apw_m3k2abc123def456")).toBe(true);
    expect(parseSendDest("apw_m3k2abc123def456")).toEqual({
      kind: "wallet",
      dest: "apw_m3k2abc123def456",
    });
    const token = "apw_" + "ab".repeat(32);
    expect(isWalletTokenShape(token)).toBe(true);
    expect(isAgentpayWalletId(token)).toBe(false);
    expect(() => parseSendDest(token)).toThrow(HttpError);
    expect(() => parseSendDest("not-an-address")).toThrow(/P2PKH address or an agentpay wallet id/);
    expect(() => parseSendDest("")).toThrow(/dest is required/);
  });
});

describe("POST /agent/send", () => {
  it("credits another agentpay wallet internally and is idempotent", async () => {
    const db = makeTestDb();
    const sender = await fundedAgent(db, 500);
    const { wallet: dest } = await createWallet(db, { name: "Winner" });

    const first = await jsonOf(
      await send(db, sender.key, {
        dest: dest.id,
        sats: 40_000,
        memo: "swarmgit bounty",
        idempotency_key: "swarmgit:task:worker:alice",
      }),
    );
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.settlement).toBe("internal");
    expect(first.body.dest).toBe(dest.id);
    expect(first.body.sats).toBe(40_000);
    expect(typeof first.body.txid).toBe("string");
    expect(String(first.body.txid).startsWith("snd_")).toBe(true);
    expect(first.body.receiptId).toBe(first.body.txid);
    expect(await getBalanceCents(db, sender.wallet.id)).toBe(499);
    expect(await getBalanceCents(db, dest.id)).toBe(1);

    const replay = await jsonOf(
      await send(db, sender.key, {
        dest: dest.id,
        sats: 40_000,
        idempotency_key: "swarmgit:task:worker:alice",
      }),
    );
    expect(replay.status).toBe(200);
    expect(replay.body.txid).toBe(first.body.txid);
    expect(replay.body.settlement).toBe("internal");
    expect(await getBalanceCents(db, sender.wallet.id)).toBe(499);
    expect(await getBalanceCents(db, dest.id)).toBe(1);

    const destLedger = await listLedger(db, dest.id);
    expect(destLedger.some((e) => e.kind === "adjust" && e.amount_cents === 1)).toBe(true);
  });

  it("rejects unknown, frozen, and self wallet destinations", async () => {
    const db = makeTestDb();
    const sender = await fundedAgent(db, 500);
    const { wallet: dest } = await createWallet(db, { name: "Closed" });
    await db.prepare("UPDATE ap_wallets SET status = 'frozen' WHERE id = ?").bind(dest.id).run();

    const unknown = await jsonOf(await send(db, sender.key, { dest: "apw_doesnotexistxx", sats: 1000 }));
    expect(unknown.status).toBe(404);
    expect(String(unknown.body.error)).toMatch(/Unknown destination wallet/);

    const frozen = await jsonOf(await send(db, sender.key, { dest: dest.id, sats: 1000 }));
    expect(frozen.status).toBe(403);
    expect(String(frozen.body.error)).toMatch(/frozen/);

    const self = await jsonOf(await send(db, sender.key, { dest: sender.wallet.id, sats: 1000 }));
    expect(self.status).toBe(400);
    expect(String(self.body.error)).toMatch(/own wallet/);
  });

  it("does not take the internal path for a P2PKH dest, and still requires the treasury", async () => {
    const db = makeTestDb();
    const sender = await fundedAgent(db, 500);
    const res = await jsonOf(await send(db, sender.key, { dest: P2PKH, sats: 1000 }));
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/SITE_WALLET_WIF/);
    expect(await getBalanceCents(db, sender.wallet.id)).toBe(500);
  });

  it("rejects a wallet token used as dest and invalid dests", async () => {
    const db = makeTestDb();
    const sender = await fundedAgent(db, 500);
    const token = "apw_" + "cd".repeat(32);
    const asToken = await jsonOf(await send(db, sender.key, { dest: token, sats: 1000 }));
    expect(asToken.status).toBe(400);
    expect(String(asToken.body.error)).toMatch(/wallet token/);

    const bad = await jsonOf(await send(db, sender.key, { dest: "not-valid", sats: 1000 }));
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/P2PKH address or an agentpay wallet id/);
  });

  it("enforces balance, allowlist, and approval threshold", async () => {
    const db = makeTestDb();
    const sender = await fundedAgent(db, 1);
    const { wallet: dest } = await createWallet(db, { name: "Winner" });

    const broke = await jsonOf(await send(db, sender.key, { dest: dest.id, sats: 80_000 }));
    expect(broke.status).toBe(402);
    expect(String(broke.body.error)).toMatch(/Insufficient balance/);

    await setAgentPolicy(db, sender.wallet.id, sender.agent.id, { allowedTools: ["other:tool"] });
    const blocked = await jsonOf(await send(db, sender.key, { dest: dest.id, sats: 1000 }));
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error)).toMatch(/does not permit send/);

    await setAgentPolicy(db, sender.wallet.id, sender.agent.id, {
      allowedTools: ["agent_send"],
      approvalAboveCents: 1,
    });
    const gated = await jsonOf(await send(db, sender.key, { dest: dest.id, sats: 1000 }));
    expect(gated.status).toBe(402);
    expect(gated.body.error).toBe("approval_required");
    expect(gated.body.approvalId).toBeTruthy();
  });
});
