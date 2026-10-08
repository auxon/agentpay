import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createWallet, createAgent } from "../src/ledger";

// createAgent(db, walletId, { name }) — walletId is positional.

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
      .bind("snd_1", wallet.id, agent.id, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", 1000, "key-123")
      .run();

    // Same wallet + same key → unique constraint violation.
    await expect(
      db
        .prepare(
          `INSERT INTO ap_sends (id, wallet_id, agent_id, dest, sats, idempotency_key, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind("snd_2", wallet.id, agent.id, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", 1000, "key-123")
        .run(),
    ).rejects.toThrow();

    // Different wallet + same key → allowed.
    const { wallet: wallet2 } = await createWallet(db, { name: "Owner2" });
    await expect(
      db
        .prepare(
          `INSERT INTO ap_sends (id, wallet_id, agent_id, dest, sats, idempotency_key, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .bind("snd_3", wallet2.id, agent.id, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", 1000, "key-123")
        .run(),
    ).resolves.toBeTruthy();

    // Null keys → multiple allowed (no idempotency requested).
    await db
      .prepare(
        `INSERT INTO ap_sends (id, wallet_id, dest, sats, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .bind("snd_4", wallet.id, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", 500)
      .run();
    await db
      .prepare(
        `INSERT INTO ap_sends (id, wallet_id, dest, sats, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .bind("snd_5", wallet.id, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", 600)
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
      .bind(
        "snd_1",
        wallet.id,
        "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        1000,
        "test",
        "key-abc",
        "abcd".repeat(16),
      )
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
