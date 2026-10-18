/**
 * Durable treasury coin ledger.
 *
 * Indexers (WhatsOnChain) and broadcasters (GorillaPool ARC) can lag tens of
 * minutes behind a payment we just signed. The spent-coin HTTP check is not
 * enough: a UTXO we already spent can still look unspent, and change from a
 * just-mined parent can be spent before ARC has seen that parent (orphan).
 *
 * These tables are the source of truth for "we already spent this outpoint"
 * and "this change is ours and still unconfirmed". Selection never reuses a
 * recorded spent outpoint, whatever the indexer says.
 */
import { P2PKH, Transaction } from "@bsv/sdk";
import { nowIso } from "./ids";

export type CoinOutpoint = { tx_hash: string; tx_pos: number; value: number; height?: number };

const DDL = [
  `CREATE TABLE IF NOT EXISTS ap_treasury_spent (
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    spend_txid TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (txid, vout)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_treasury_spent_spend ON ap_treasury_spent(spend_txid)`,
  `CREATE TABLE IF NOT EXISTS ap_treasury_change (
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    hex TEXT NOT NULL DEFAULT '',
    height INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (txid, vout)
  )`,
];

export async function ensureTreasuryTables(db: D1Database): Promise<void> {
  // D1 exec() splits its input on newlines, so a multi-line CREATE TABLE fails
  // with "incomplete input". Run each statement as one prepared statement.
  for (const sql of DDL) {
    await db.prepare(sql).run();
  }
}

export function outpointKey(txid: string, vout: number): string {
  return `${txid.toLowerCase()}:${vout}`;
}

export async function recordedSpentKeys(db: D1Database, utxos: CoinOutpoint[]): Promise<Set<string>> {
  const keys = new Set<string>();
  if (utxos.length === 0) return keys;
  for (const u of utxos) {
    const row = await db
      .prepare("SELECT 1 AS ok FROM ap_treasury_spent WHERE txid = ? AND vout = ?")
      .bind(u.tx_hash.toLowerCase(), u.tx_pos)
      .first<{ ok: number }>();
    if (row) keys.add(outpointKey(u.tx_hash, u.tx_pos));
  }
  return keys;
}

export async function isRecordedSpent(db: D1Database, txid: string, vout: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM ap_treasury_spent WHERE txid = ? AND vout = ?")
    .bind(txid.toLowerCase(), vout)
    .first<{ ok: number }>();
  return Boolean(row);
}

/**
 * Drop outpoints we have already signed, and (unless allowed) unconfirmed
 * coins — including our own change that has not confirmed yet.
 */
export async function filterSpendableUtxos(
  db: D1Database,
  utxos: CoinOutpoint[],
  opts: { allowUnconfirmed?: boolean } = {},
): Promise<CoinOutpoint[]> {
  await ensureTreasuryTables(db);
  const spent = await recordedSpentKeys(db, utxos);
  const allowUnconfirmed = Boolean(opts.allowUnconfirmed);
  const out: CoinOutpoint[] = [];
  for (const u of utxos) {
    if (spent.has(outpointKey(u.tx_hash, u.tx_pos))) continue;
    if (!allowUnconfirmed && (u.height ?? 0) <= 0) continue;
    out.push(u);
  }
  return out;
}

/** Parent tx hex from a change row we created, if we still have it. */
export async function loadRecordedParentHex(db: D1Database, txid: string): Promise<string | null> {
  await ensureTreasuryTables(db);
  const row = await db
    .prepare("SELECT hex FROM ap_treasury_change WHERE txid = ? AND hex != '' LIMIT 1")
    .bind(txid.toLowerCase())
    .first<{ hex: string }>();
  const hex = row?.hex?.trim() ?? "";
  return /^[0-9a-f]+$/i.test(hex) ? hex : null;
}

export async function loadParentTx(
  txid: string,
  db: D1Database | undefined,
  fallback: (txid: string) => Promise<Transaction | null>,
): Promise<Transaction | null> {
  if (db) {
    const hex = await loadRecordedParentHex(db, txid);
    if (hex) {
      try {
        return Transaction.fromHex(hex);
      } catch {
        /* fall through to indexer */
      }
    }
  }
  return fallback(txid);
}

function changeLockHex(address: string): string {
  return new P2PKH().lock(address).toHex();
}

/**
 * Record every input as spent and every change output as ours. Call after
 * sign (before or after broadcast): the seller or we may relay the tx, so
 * the outpoints must not be selected again.
 */
export async function recordPaymentCoins(
  db: D1Database,
  tx: Transaction,
  changeAddress: string,
): Promise<void> {
  await ensureTreasuryTables(db);
  const spendTxid = tx.id("hex").toLowerCase();
  const hex = tx.toHex();
  const createdAt = nowIso();
  const lockHex = changeLockHex(changeAddress);

  for (const input of tx.inputs) {
    const txid = String(input.sourceTXID ?? "").toLowerCase();
    const vout = Number(input.sourceOutputIndex ?? 0);
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    const value = Number(input.sourceTransaction?.outputs?.[vout]?.satoshis ?? 0);
    await db
      .prepare(
        `INSERT INTO ap_treasury_spent (txid, vout, value, spend_txid, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(txid, vout) DO UPDATE SET spend_txid = excluded.spend_txid`,
      )
      .bind(txid, vout, value, spendTxid, createdAt)
      .run();
    await db.prepare("DELETE FROM ap_treasury_change WHERE txid = ? AND vout = ?").bind(txid, vout).run();
  }

  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const output = tx.outputs[vout];
    const value = Number(output.satoshis ?? 0);
    if (value <= 0) continue;
    if (output.lockingScript.toHex() !== lockHex) continue;
    await db
      .prepare(
        `INSERT INTO ap_treasury_change (txid, vout, value, hex, height, created_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(txid, vout) DO UPDATE SET value = excluded.value, hex = excluded.hex`,
      )
      .bind(spendTxid, vout, value, hex, createdAt)
      .run();
  }
}
