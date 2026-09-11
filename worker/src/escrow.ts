/**
 * agentpay-funded bounties: per-bounty on-chain sats escrow.
 *
 * A poster's wallet is debited in USD cents; the site treasury broadcasts a
 * real P2PKH escrow output to a fresh per-bounty key. On settle the escrow
 * output is spent: worker/refund + platform fee + change. Keys are stored
 * AES-GCM encrypted under BOUNTY_ESCROW_KEY.
 */
import { OP, P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { HttpError, type AppEnv } from "./types";
import { nowIso } from "./ids";
import {
  DUST_CHANGE_SATS,
  fetchParentTx,
  fetchSiteWalletUtxos,
  feeSatsFor,
  fundingMessage,
  isOutputSpent,
  type SiteUtxo,
} from "./x402";

export const DEFAULT_BOUNTY_FEE_BPS = 200; // 2%
export const ARC_FALLBACK = "https://arc.gorillapool.io/v1";

export interface TxOutput {
  address: string;
  satoshis: number;
}

export interface BountyEscrowRow {
  id: string;
  bounty_id: string | null;
  wallet_id: string;
  agent_id: string | null;
  title: string;
  amount_sats: number;
  fee_bps: number;
  charged_cents: number;
  post_ref: string;
  escrow_wif_enc: string;
  escrow_address: string;
  funding_txid: string | null;
  payout_txid: string | null;
  refund_txid: string | null;
  status: string;
  payout_address: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- key encryption (AES-GCM under BOUNTY_ESCROW_KEY) ----------

function b64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function escrowKeyConfigured(env: AppEnv): boolean {
  return Boolean(env.BOUNTY_ESCROW_KEY?.trim());
}

async function escrowAesKey(env: AppEnv, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const raw = env.BOUNTY_ESCROW_KEY?.trim();
  if (!raw) {
    throw new HttpError(503, "Bounty escrow is not configured (BOUNTY_ESCROW_KEY missing)");
  }
  const bytes = b64ToBytes(raw);
  if (bytes.length !== 32) {
    throw new HttpError(503, "BOUNTY_ESCROW_KEY must be 32 bytes (base64)");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [usage]);
}

export function generateEscrowWif(): string {
  return PrivateKey.fromRandom().toWif();
}

export function escrowAddressFor(wif: string): string {
  return PrivateKey.fromWif(wif).toAddress();
}

export async function encryptEscrowWif(env: AppEnv, wif: string): Promise<string> {
  const key = await escrowAesKey(env, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(wif)),
  );
  return JSON.stringify({ v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) });
}

export async function decryptEscrowWif(env: AppEnv, blob: string): Promise<PrivateKey> {
  const parsed = JSON.parse(blob) as { iv?: string; ct?: string };
  if (!parsed.iv || !parsed.ct) throw new HttpError(500, "Escrow key blob is corrupt");
  const key = await escrowAesKey(env, "decrypt");
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64ToBytes(parsed.iv) },
        key,
        b64ToBytes(parsed.ct),
      ),
    );
  } catch {
    throw new HttpError(500, "Escrow key could not be decrypted (BOUNTY_ESCROW_KEY changed?)");
  }
  return PrivateKey.fromWif(new TextDecoder().decode(plain));
}

// ---------- transaction building ----------

export function feeBpsFromEnv(env: AppEnv): number {
  const n = Number.parseInt(String(env.BOUNTY_FEE_BPS ?? ""), 10);
  return Number.isFinite(n) && n >= 0 && n <= 2000 ? n : DEFAULT_BOUNTY_FEE_BPS;
}

/** Network fee for a payout/refund: base fee plus a small per-output allowance. */
export function spendFeeSats(env: AppEnv, outputs: number): number {
  return feeSatsFor(env) + Math.max(1, outputs) * 5;
}

/**
 * Sats returned to treasury when sweeping an escrow UTXO back. Leaves the
 * 1-sat builder margin so the sum never exceeds the input.
 */
export function sweepSats(env: AppEnv, value: number, outputs = 1): number {
  return value - spendFeeSats(env, outputs) - 1;
}

function markerScript(text: string): Script {
  const script = new Script();
  script.writeOpCode(OP.OP_FALSE);
  script.writeOpCode(OP.OP_RETURN);
  script.writeBin(Array.from(new TextEncoder().encode(text)));
  return script;
}

/** Minimal parent when WOC is unreachable — only the spent output matters. */
function stubSourceTransaction(
  outputIndex: number,
  satoshis: number,
  lockingScript: import("@bsv/sdk").LockingScript,
): Transaction {
  const source = new Transaction();
  source.outputs = Array.from({ length: outputIndex + 1 }, () => ({ satoshis: 0, lockingScript }));
  source.outputs[outputIndex] = { satoshis, lockingScript };
  return source;
}

/**
 * Generic 1+ input P2PKH tx: pays `outputs`, change back to `key`, plus an
 * OP_RETURN nonce so no two builds share a txid.
 */
export async function buildP2pkhTx(opts: {
  key: PrivateKey;
  utxos: SiteUtxo[];
  outputs: TxOutput[];
  feeSats: number;
  marker?: string;
  fetchParent?: (txid: string) => Promise<Transaction | null>;
  nonce?: number[];
}): Promise<Transaction> {
  if (opts.outputs.length === 0) throw new HttpError(400, "A transaction needs at least one output");
  const changeAddress = opts.key.toAddress();
  const changeLock = new P2PKH().lock(changeAddress);
  const outTotal = opts.outputs.reduce((sum, o) => sum + o.satoshis, 0);
  const needed = outTotal + opts.feeSats + 1;

  const utxos = opts.utxos.filter((u) => u.value > 0);
  const chosen: SiteUtxo[] = [];
  let total = 0;
  for (const u of utxos) {
    chosen.push(u);
    total += u.value;
    if (total >= needed) break;
  }
  if (chosen.length === 0 || total < needed) {
    throw new HttpError(
      503,
      fundingMessage({ address: changeAddress, haveSats: total, neededSats: needed }),
    );
  }

  const loadParent = opts.fetchParent ?? fetchParentTx;
  const tx = new Transaction();
  for (const u of chosen) {
    const parent = await loadParent(u.tx_hash);
    tx.addInput({
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      sourceTransaction: parent ?? stubSourceTransaction(u.tx_pos, u.value, changeLock),
      unlockingScriptTemplate: new P2PKH().unlock(opts.key, "all", false, u.value, changeLock),
      sequence: 0xffffffff,
    });
  }
  for (const o of opts.outputs) {
    tx.addOutput({ lockingScript: new P2PKH().lock(o.address), satoshis: o.satoshis });
  }
  const change = total - outTotal - opts.feeSats;
  if (change >= DUST_CHANGE_SATS) {
    tx.addOutput({ lockingScript: changeLock, satoshis: change });
  }
  const marker = opts.marker ?? "agentpay";
  tx.addOutput({ lockingScript: markerScript(marker), satoshis: 0 });

  const nonce = opts.nonce ?? Array.from(crypto.getRandomValues(new Uint8Array(8)));
  const nonceOutput = new Script();
  nonceOutput.writeOpCode(OP.OP_FALSE);
  nonceOutput.writeOpCode(OP.OP_RETURN);
  nonceOutput.writeBin(Array.from(nonce));
  tx.addOutput({ lockingScript: nonceOutput, satoshis: 0 });

  await tx.sign();

  const paid = tx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0);
  if (paid > total) throw new HttpError(500, "Built transaction pays out more than its inputs");
  return tx;
}

/** Confirmed treasury UTXOs only, mirroring the x402 rail's ARC safety rule. */
export async function treasuryUtxos(env: AppEnv, address: string): Promise<SiteUtxo[]> {
  const all = await fetchSiteWalletUtxos(address);
  return env.X402_ALLOW_UNCONFIRMED === "1" ? all : all.filter((u) => (u.height ?? 0) > 0);
}

/** Treasury → escrow P2PKH output, with an audit marker OP_RETURN. */
export async function buildEscrowFundingTx(opts: {
  env: AppEnv;
  treasuryKey: PrivateKey;
  escrowAddress: string;
  satoshis: number;
  marker: string;
}): Promise<Transaction> {
  const address = opts.treasuryKey.toAddress();
  const utxos = await treasuryUtxos(opts.env, address);
  if (utxos.length === 0) {
    throw new HttpError(503, `Treasury ${address} has no confirmed UTXOs to escrow from`);
  }
  return buildP2pkhTx({
    key: opts.treasuryKey,
    utxos,
    outputs: [{ address: opts.escrowAddress, satoshis: opts.satoshis }],
    feeSats: feeSatsFor(opts.env),
    marker: opts.marker,
  });
}

/** Escrow key spends its single P2PKH UTXO into payout/refund outputs. */
export async function buildEscrowSpendTx(opts: {
  env: AppEnv;
  escrowKey: PrivateKey;
  utxo: SiteUtxo;
  outputs: TxOutput[];
  marker: string;
}): Promise<Transaction> {
  if (await isOutputSpent(opts.utxo.tx_hash, opts.utxo.tx_pos)) {
    throw new HttpError(409, "Escrow output is already spent");
  }
  return buildP2pkhTx({
    key: opts.escrowKey,
    utxos: [opts.utxo],
    outputs: opts.outputs,
    feeSats: spendFeeSats(opts.env, opts.outputs.length),
    marker: opts.marker,
  });
}

export async function fetchEscrowUtxos(address: string): Promise<SiteUtxo[]> {
  return fetchSiteWalletUtxos(address);
}

// ---------- broadcast ----------

export async function arcBroadcastTx(
  env: AppEnv,
  txHex: string,
): Promise<{ txid: string; raw: unknown; via: string }> {
  const primary = (env.ARC_URL || ARC_FALLBACK).replace(/\/$/, "");
  const fallbacks = [primary, "https://arc.taal.com/v1"];
  if (typeof env.ARC_FALLBACK_URL === "string" && env.ARC_FALLBACK_URL) {
    fallbacks.splice(1, 0, env.ARC_FALLBACK_URL.replace(/\/$/, ""));
  }
  const apiKey = env.ARC_API_KEY?.trim();
  let lastError = "";
  for (const base of [...new Set(fallbacks)]) {
    try {
      const res = await fetch(`${base}/tx`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
          "xdeployment-id": "agentpay-bounties-v1",
        },
        body: JSON.stringify({ rawTx: txHex }),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 2000) };
      }
      if (!res.ok) {
        lastError = `ARC rejected escrow broadcast (${res.status}): ${text.slice(0, 300)}`;
        continue;
      }
      const txid =
        (json.txid as string) ?? (json.txId as string) ?? (json.hash as string) ?? "";
      if (!txid) {
        lastError = `ARC ${base} accepted but returned no txid`;
        continue;
      }
      return { txid, raw: json, via: base };
    } catch (err) {
      lastError = `ARC ${base} unreachable: ${(err as Error).message}`;
    }
  }
  throw new HttpError(502, lastError || "All ARC endpoints failed");
}

// ---------- escrow rows ----------

export async function createEscrowRow(
  db: D1Database,
  input: {
    id: string;
    walletId: string;
    agentId: string | null;
    title: string;
    amountSats: number;
    feeBps: number;
    chargedCents: number;
    postRef: string;
    escrowWifEnc: string;
    escrowAddress: string;
    status: string;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO ap_bounty_escrows
        (id, bounty_id, wallet_id, agent_id, title, amount_sats, fee_bps, charged_cents, post_ref, escrow_wif_enc, escrow_address, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.walletId,
      input.agentId,
      input.title,
      input.amountSats,
      input.feeBps,
      input.chargedCents,
      input.postRef,
      input.escrowWifEnc,
      input.escrowAddress,
      input.status,
      now,
      now,
    )
    .run();
}

export async function getEscrowRow(db: D1Database, bountyId: string): Promise<BountyEscrowRow | null> {
  return db
    .prepare("SELECT * FROM ap_bounty_escrows WHERE bounty_id = ?")
    .bind(bountyId)
    .first<BountyEscrowRow>();
}

export async function getEscrowById(db: D1Database, id: string): Promise<BountyEscrowRow | null> {
  return db
    .prepare("SELECT * FROM ap_bounty_escrows WHERE id = ?")
    .bind(id)
    .first<BountyEscrowRow>();
}

export async function listEscrowRows(
  db: D1Database,
  walletId: string,
  limit = 50,
): Promise<BountyEscrowRow[]> {
  const res = await db
    .prepare("SELECT * FROM ap_bounty_escrows WHERE wallet_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(walletId, Math.min(Math.max(limit, 1), 100))
    .all<BountyEscrowRow>();
  return res.results ?? [];
}

export async function updateEscrowRow(
  db: D1Database,
  id: string,
  patch: Partial<
    Pick<
      BountyEscrowRow,
      "bounty_id" | "funding_txid" | "payout_txid" | "refund_txid" | "status" | "payout_address" | "error"
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(nowIso(), id);
  await db
    .prepare(`UPDATE ap_bounty_escrows SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}
