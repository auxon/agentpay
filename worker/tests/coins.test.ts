import { describe, expect, it } from "vitest";
import { ensureTreasuryTables } from "../src/coins";
import { makeTestDb } from "./helpers";

const MULTI_LINE_CREATE = `CREATE TABLE IF NOT EXISTS ap_exec_probe (
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  PRIMARY KEY (txid, vout)
)`;

describe("ensureTreasuryTables", () => {
  it("creates the ledger tables through prepare().run(), not D1 exec()", async () => {
    const db = makeTestDb();
    db.raw.exec("DROP TABLE IF EXISTS ap_treasury_spent");
    db.raw.exec("DROP TABLE IF EXISTS ap_treasury_change");

    await ensureTreasuryTables(db);

    await db
      .prepare("INSERT INTO ap_treasury_spent (txid, vout, value, spend_txid) VALUES (?, ?, ?, ?)")
      .bind("aa".repeat(32), 0, 100, "bb".repeat(32))
      .run();
    await db
      .prepare("INSERT INTO ap_treasury_change (txid, vout, value, hex, height) VALUES (?, ?, ?, ?, ?)")
      .bind("cc".repeat(32), 1, 50, "00", 0)
      .run();
    const spent = await db
      .prepare("SELECT COUNT(*) AS n FROM ap_treasury_spent")
      .first<{ n: number }>();
    const change = await db
      .prepare("SELECT COUNT(*) AS n FROM ap_treasury_change")
      .first<{ n: number }>();
    expect(spent?.n).toBe(1);
    expect(change?.n).toBe(1);
  });

  it("fails closed if someone passes multi-line DDL to db.exec (D1 newline split)", async () => {
    const db = makeTestDb();
    await expect(db.exec(MULTI_LINE_CREATE)).rejects.toThrow(/incomplete input/i);
    await db.prepare(MULTI_LINE_CREATE).run();
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'ap_exec_probe'")
      .first<{ name: string }>();
    expect(row?.name).toBe("ap_exec_probe");
  });
});
