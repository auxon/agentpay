/**
 * x402 v2 BSV rail — agentpay as the BUYER.
 *
 * Sellers (e.g. BSV Wallets, Brainstorm) answer unpaid calls with
 * `402 + PAYMENT-REQUIRED: base64(requirements)`. We pay from the site wallet:
 * build + sign an exact P2PKH payment, send it back as
 * `PAYMENT-SIGNATURE: base64({txHex})`, and the seller broadcasts it.
 *
 * The site wallet is funded by the operator (same treasury model as Brainstorm
 * NFT mints). Agents pay USD cents into the ledger; the rail settles sats.
 */
import { OP, P2PKH, PrivateKey, Script, Transaction, type LockingScript } from "@bsv/sdk";
import { HttpError, type AppEnv } from "./types";
import { nowIso } from "./ids";

export const BSV_NETWORK = "bsv:mainnet";
export const X402_SCHEME = "exact";
export const DEFAULT_MAX_PAYMENT_SATS = 10_000;
/** ARC/GorillaPool enforces a relay minimum the SDK fee model undershoots. */
export const DEFAULT_FEE_SATS = 30;
export const DUST_CHANGE_SATS = 2;

const WOC = "https://api.whatsonchain.com/v1/bsv/main";

export interface BsvRequirements {
  payTo: string;
  satoshis: number;
  resourceUrl: string | null;
  description: string | null;
}

interface RawRequirements {
  scheme?: unknown;
  network?: unknown;
  amount?: unknown;
  payTo?: unknown;
  asset?: unknown;
  resource?: { url?: unknown; description?: unknown } | null;
  extra?: { satoshis?: unknown } | null;
}

/** Validate a decoded PAYMENT-REQUIRED payload for the BSV `exact` rail. */
export function parseBsvRequirements(raw: unknown): BsvRequirements {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(502, "Seller returned malformed payment requirements");
  }
  const req = raw as RawRequirements;
  if (req.network !== BSV_NETWORK) {
    throw new HttpError(502, `Unsupported x402 network "${String(req.network)}" (want ${BSV_NETWORK})`);
  }
  if (req.asset && req.asset !== "native:BSV") {
    throw new HttpError(502, `Unsupported x402 asset "${String(req.asset)}" (want native:BSV)`);
  }
  if (req.scheme && req.scheme !== X402_SCHEME) {
    throw new HttpError(502, `Unsupported x402 scheme "${String(req.scheme)}" (want ${X402_SCHEME})`);
  }
  const payTo = String(req.payTo ?? "").trim();
  if (!payTo) throw new HttpError(502, "Seller requirements are missing payTo");
  try {
    new P2PKH().lock(payTo);
  } catch {
    throw new HttpError(502, "Seller payTo is not a valid BSV P2PKH address");
  }
  const satoshis = Number.parseInt(String(req.extra?.satoshis ?? req.amount ?? ""), 10);
  if (!Number.isFinite(satoshis) || satoshis <= 0) {
    throw new HttpError(502, "Seller requirements have no payable satoshi amount");
  }
  return {
    payTo,
    satoshis,
    resourceUrl: typeof req.resource?.url === "string" ? req.resource.url : null,
    description: typeof req.resource?.description === "string" ? req.resource.description : null,
  };
}

export function maxPaymentSats(env: AppEnv): number {
  const n = Number.parseInt(String(env.X402_MAX_SATS ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PAYMENT_SATS;
}

/**
 * What to charge the agent wallet (integer cents, min 1).
 * Explicit `amountCents` wins; else convert with the resolved oracle rate
 * (perCent), else X402_SATS_PER_CENT; else 1 cent.
 */
export function chargeCentsFor(sats: number, env: AppEnv, override?: unknown, perCent?: number): number {
  if (Number.isInteger(override) && (override as number) >= 1) return override as number;
  if (perCent !== undefined && Number.isFinite(perCent) && perCent > 0) {
    return Math.max(1, Math.ceil(sats / perCent));
  }
  const cfg = Number.parseInt(String(env.X402_SATS_PER_CENT ?? ""), 10);
  if (Number.isFinite(cfg) && cfg > 0) return Math.max(1, Math.ceil(sats / cfg));
  return 1;
}

export function siteWalletConfigured(env: AppEnv): boolean {
  return Boolean(env.SITE_WALLET_WIF?.trim());
}

export function siteWalletAddress(env: AppEnv): string | null {
  const wif = env.SITE_WALLET_WIF?.trim();
  if (!wif) return null;
  try {
    return PrivateKey.fromWif(wif).toAddress();
  } catch {
    return null;
  }
}

export type SiteUtxo = { tx_hash: string; tx_pos: number; value: number; height: number };

/**
 * WhatsOnChain `/unspent` is cached and can list outputs that a recent
 * (unconfirmed) tx already spent. `/tx/{txid}/{vout}/spent` is authoritative:
 * 200 = spent, 404 = unspent. On any error we keep the UTXO — the random
 * nonce plus the settled-txid guard make a stale pick fail safely, not replay.
 */
export async function isOutputSpent(txid: string, vout: number): Promise<boolean> {
  try {
    const res = await fetch(`${WOC}/tx/${txid}/${vout}/spent`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchSiteWalletUtxos(address: string): Promise<SiteUtxo[]> {
  const res = await fetch(`${WOC}/address/${address}/unspent`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(502, `Could not load site wallet UTXOs (${res.status}) ${body.slice(0, 120)}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  const candidates = data
    .map((row) => {
      const r = row as { tx_hash?: string; tx_pos?: number; value?: number; height?: number };
      return {
        tx_hash: String(r.tx_hash ?? ""),
        tx_pos: Number(r.tx_pos ?? 0),
        value: Number(r.value ?? 0),
        height: Number(r.height ?? 0),
      };
    })
    .filter((u) => /^[0-9a-f]{64}$/i.test(u.tx_hash) && u.value > 0)
    .sort((a, b) => b.height - a.height || b.value - a.value);
  const checks = await Promise.all(
    candidates.slice(0, 10).map(async (u) => ({ u, spent: await isOutputSpent(u.tx_hash, u.tx_pos) })),
  );
  return checks.filter((c) => !c.spent).map((c) => c.u);
}

export function treasuryThresholdSats(env: AppEnv): number {
  const n = Number.parseInt(String(env.X402_MIN_TREASURY_SATS ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 5_000;
}

const TREASURY_CACHE_MS = 5 * 60 * 1000;

export interface TreasuryStatus {
  configured: boolean;
  address: string | null;
  sats: number | null;
  thresholdSats: number;
  low: boolean;
  stale: boolean;
  updatedAt: string | null;
}

function parseDbTime(value: string): number {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return Date.parse(normalized);
}

/**
 * Cached treasury balance for /health and the dashboard banner. Refreshes at
 * most every 5 minutes; serves the last snapshot with `stale: true` on WOC errors.
 */
export async function treasuryStatus(db: D1Database, env: AppEnv): Promise<TreasuryStatus> {
  const thresholdSats = treasuryThresholdSats(env);
  const address = siteWalletAddress(env);
  if (!address) {
    return { configured: false, address: null, sats: null, thresholdSats, low: false, stale: false, updatedAt: null };
  }
  const key = `treasury:${address}`;
  const cached = await db
    .prepare("SELECT value, updated_at FROM ap_meta WHERE key = ?")
    .bind(key)
    .first<{ value: string; updated_at: string }>();
  let cachedSats: number | null = null;
  let cachedAt: string | null = null;
  if (cached) {
    try {
      const parsed = JSON.parse(cached.value) as { sats?: unknown };
      const n = Number(parsed.sats);
      if (Number.isFinite(n)) cachedSats = n;
      cachedAt = cached.updated_at;
    } catch {
      cachedSats = null;
    }
  }
  const fresh = cachedAt !== null && Date.now() - parseDbTime(cachedAt) < TREASURY_CACHE_MS;
  if (fresh && cachedSats !== null) {
    return {
      configured: true,
      address,
      sats: cachedSats,
      thresholdSats,
      low: cachedSats < thresholdSats,
      stale: false,
      updatedAt: cachedAt,
    };
  }
  try {
    // Spent-filtered read: WOC's /unspent can list outputs our own txs already spent.
    const utxos = await fetchSiteWalletUtxos(address);
    const sats = utxos.reduce((sum, u) => sum + u.value, 0);
    const updatedAt = nowIso();
    await db
      .prepare(
        "INSERT INTO ap_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(key, JSON.stringify({ sats }), updatedAt)
      .run();
    return { configured: true, address, sats, thresholdSats, low: sats < thresholdSats, stale: false, updatedAt };
  } catch (e) {
    if (cachedSats !== null) {
      return {
        configured: true,
        address,
        sats: cachedSats,
        thresholdSats,
        low: cachedSats < thresholdSats,
        stale: true,
        updatedAt: cachedAt,
      };
    }
    throw e;
  }
}

function stubSourceTransaction(outputIndex: number, satoshis: number, lockingScript: LockingScript): Transaction {
  const source = new Transaction();
  source.outputs = Array.from({ length: outputIndex + 1 }, () => ({ satoshis: 0, lockingScript }));
  source.outputs[outputIndex] = { satoshis, lockingScript };
  return source;
}

/** Full parent tx so ARC gets EF validation data; null when unavailable. */
export async function fetchParentTx(txid: string): Promise<Transaction | null> {
  try {
    const res = await fetch(`${WOC}/tx/${txid}/hex`);
    if (!res.ok) return null;
    const text = (await res.text()).trim().replace(/^"|"$/g, "");
    if (!/^[0-9a-f]+$/i.test(text)) return null;
    return Transaction.fromHex(text);
  } catch {
    return null;
  }
}

export function feeSatsFor(env: AppEnv): number {
  const n = Number.parseInt(String(env.X402_FEE_SATS ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_FEE_SATS;
}

export function fundingMessage(opts: { address: string; haveSats: number; neededSats: number }): string {
  const short = Math.max(0, opts.neededSats - opts.haveSats);
  const bsv = (short / 1e8).toFixed(8);
  return (
    `Site wallet ${opts.address} has ${opts.haveSats} sats but needs ~${opts.neededSats} sats ` +
    `(payment + fee). Send at least ${short} sats (${bsv} BSV) to ${opts.address}.`
  );
}

export async function buildBsvPaymentTx(opts: {
  key: PrivateKey;
  utxos: SiteUtxo[];
  payTo: string;
  satoshis: number;
  feeSats?: number;
  fetchParent?: (txid: string) => Promise<Transaction | null>;
  /** Optional deterministic nonce for tests; random by default. */
  nonce?: number[];
}): Promise<Transaction> {
  const fee = opts.feeSats ?? DEFAULT_FEE_SATS;
  const changeAddress = opts.key.toAddress();
  const changeLock = new P2PKH().lock(changeAddress);
  const payLock = new P2PKH().lock(opts.payTo);
  const needed = opts.satoshis + fee + 1;

  const chosen: SiteUtxo[] = [];
  let total = 0;
  for (const u of opts.utxos) {
    if (u.value <= 0) continue;
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

  tx.addOutput({ lockingScript: payLock, satoshis: opts.satoshis });
  const change = total - opts.satoshis - fee;
  if (change >= DUST_CHANGE_SATS) {
    tx.addOutput({ lockingScript: changeLock, satoshis: change });
  }

  // Random OP_RETURN nonce: two payments can never produce the same txid, so a
  // stale UTXO cache can't alias a fresh payment with an already-settled tx.
  const nonce = opts.nonce ?? Array.from(crypto.getRandomValues(new Uint8Array(8)));
  const nonceScript = new Script();
  nonceScript.writeOpCode(OP.OP_FALSE);
  nonceScript.writeOpCode(OP.OP_RETURN);
  nonceScript.writeBin(nonce);
  tx.addOutput({ lockingScript: nonceScript, satoshis: 0 });

  await tx.sign();

  const outTotal = tx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0);
  if (outTotal > total) throw new HttpError(500, "Built transaction pays out more than its inputs");
  return tx;
}

function b64encodeJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Validate the seller requirements, pick UTXOs, and sign an exact payment.
 * Does NOT broadcast: the seller broadcasts the tx it receives.
 */
export async function prepareBsvPayment(
  env: AppEnv,
  requirements: BsvRequirements,
): Promise<{ txid: string; paymentSignature: string; address: string; satoshis: number; payer: string }> {
  const wif = env.SITE_WALLET_WIF?.trim();
  if (!wif) throw new HttpError(503, "BSV rail is not configured (site wallet WIF missing)");
  let key: PrivateKey;
  try {
    key = PrivateKey.fromWif(wif);
  } catch {
    throw new HttpError(503, "BSV rail is not configured (site wallet WIF invalid)");
  }
  const limit = maxPaymentSats(env);
  if (requirements.satoshis > limit) {
    throw new HttpError(402, `Seller asks ${requirements.satoshis} sats, above the ${limit} sat per-call cap`);
  }
  const address = key.toAddress();
  const all = await fetchSiteWalletUtxos(address);
  // Spend confirmed UTXOs only: ARC can orphan a child of a just-confirmed
  // parent it has not indexed yet, and orphans never relay. Opt in to
  // unconfirmed with X402_ALLOW_UNCONFIRMED=1 for local testing.
  const utxos = env.X402_ALLOW_UNCONFIRMED === "1" ? all : all.filter((u) => u.height > 0);
  if (utxos.length === 0) {
    const pending = all.filter((u) => u.height === 0).reduce((sum, u) => sum + u.value, 0);
    throw new HttpError(
      503,
      pending > 0
        ? `Site wallet has ${pending} sats in unconfirmed UTXOs — wait for confirmation, then retry`
        : `Site wallet ${address} has no confirmed UTXOs — fund it before paying sellers`,
    );
  }
  const tx = await buildBsvPaymentTx({
    key,
    utxos,
    payTo: requirements.payTo,
    satoshis: requirements.satoshis,
    feeSats: feeSatsFor(env),
  });
  return {
    txid: tx.id("hex"),
    // Strict x402 v2 envelope: the BSV Wallets facilitator rejects bare {txHex}.
    paymentSignature: b64encodeJson({
      x402Version: 2,
      scheme: X402_SCHEME,
      network: BSV_NETWORK,
      txHex: tx.toHex(),
      encoding: "raw-hex",
    }),
    address,
    satoshis: requirements.satoshis,
    // Mirrors the gateway's payer derivation (verifyBsvPayment): binds trust
    // attestations to this exact payment so they cannot be replayed.
    payer: payerForTx(tx),
  };
}

/** Payer identity for trust binding. Must match the gateway's derivation. */
export function payerForTx(tx: {
  inputs: Array<{ sourceTXID?: unknown; sourceTransaction?: { id?: (...args: never[]) => unknown } }>;
}): string {
  try {
    const first = tx.inputs[0];
    const rawTxid = typeof first?.sourceTXID === "string" ? first.sourceTXID : "";
    const viaTx =
      !rawTxid && typeof first?.sourceTransaction?.id === "function"
        ? String(first.sourceTransaction.id("hex" as never) ?? "")
        : "";
    const ref = rawTxid || viaTx;
    if (ref) return `bsv:input:${ref.slice(0, 16)}`;
  } catch {
    /* fall through */
  }
  return "bsv:unknown";
}
