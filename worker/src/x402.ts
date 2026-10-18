/**
 * x402 v2 BSV rail — agentpay as the BUYER.
 *
 * Sellers answer unpaid calls with `402 + PAYMENT-REQUIRED: base64(challenge)`.
 * Two challenge shapes are accepted:
 *   1. Legacy single-object (x402market / BSV Wallets): `{ scheme, network,
 *      payTo, asset: "native:BSV", amount | extra.satoshis }`.
 *   2. Standard x402 v2 envelope: `{ x402Version: 2, resource, accepts: [...] }`
 *      — pick the BSV `exact` entry (`network: bsv:mainnet`, asset `BSV` or
 *      `native:BSV`) and ignore other rails (e.g. Base USDC).
 *
 * We pay from the site wallet: build + sign an exact P2PKH payment, send it
 * back as `PAYMENT-SIGNATURE: base64({txHex, ...})`. We also broadcast EF/BEEF
 * ourselves (GorillaPool + TAAL + WhatsOnChain) so ARC has the parent before
 * the seller relays, and we record spent outpoints in D1 so indexer lag cannot
 * make us double-spend.
 *
 * The site wallet is funded by the operator (same treasury model as Brainstorm
 * NFT mints). Agents pay USD cents into the ledger; the rail settles sats.
 */
import { OP, P2PKH, PrivateKey, Script, Transaction, type LockingScript } from "@bsv/sdk";
import { HttpError, type AppEnv } from "./types";
import { nowIso } from "./ids";
import { broadcastPaymentTx, txHexBEEF, txHexEF } from "./broadcast";
import { filterSpendableUtxos, loadParentTx, recordPaymentCoins } from "./coins";

export const BSV_NETWORK = "bsv:mainnet";
export const X402_SCHEME = "exact";
/** Legacy x402market / BSV Wallets asset id. */
export const BSV_ASSET_LEGACY = "native:BSV";
/** Standard x402 v2 BSV asset id (Fuse and the x402 spec). */
export const BSV_ASSET = "BSV";
export const P2PKH_RAWTX = "p2pkh-rawtx";
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
  /** P2PKH locking script from a v2 accept `extra.lockingScriptHex`, when present. */
  lockingScriptHex?: string | null;
  /** The chosen `accepts[]` entry (standard v2), so the retry can echo `accepted`. */
  accepted?: Record<string, unknown> | null;
}

interface RawExtra {
  satoshis?: unknown;
  perCallSats?: unknown;
  lockingScriptHex?: unknown;
  payloadFormat?: { kind?: unknown } | null;
}

interface RawAccept {
  scheme?: unknown;
  network?: unknown;
  amount?: unknown;
  payTo?: unknown;
  asset?: unknown;
  resource?: { url?: unknown; description?: unknown } | null;
  extra?: RawExtra | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBsvAsset(asset: unknown): boolean {
  if (asset === undefined || asset === null || asset === "") return true;
  return asset === BSV_ASSET || asset === BSV_ASSET_LEGACY;
}

function payloadKind(extra: RawExtra | null | undefined): string | null {
  const kind = extra?.payloadFormat?.kind;
  return typeof kind === "string" && kind ? kind : null;
}

/** True when an `accepts[]` entry is a BSV exact P2PKH payment we can sign. */
export function isBsvAccept(entry: unknown): entry is RawAccept {
  if (!isRecord(entry)) return false;
  const req = entry as RawAccept;
  if (req.network !== BSV_NETWORK) return false;
  if (req.scheme && req.scheme !== X402_SCHEME) return false;
  if (!isBsvAsset(req.asset)) return false;
  const kind = payloadKind(req.extra);
  if (kind && kind !== P2PKH_RAWTX) return false;
  return true;
}

function parseOneAccept(
  req: RawAccept,
  envelopeResource?: { url?: unknown; description?: unknown } | null,
  accepted: Record<string, unknown> | null = null,
): BsvRequirements {
  if (req.network !== BSV_NETWORK) {
    throw new HttpError(502, `Unsupported x402 network "${String(req.network)}" (want ${BSV_NETWORK})`);
  }
  if (!isBsvAsset(req.asset)) {
    throw new HttpError(502, `Unsupported x402 asset "${String(req.asset)}" (want ${BSV_ASSET} or ${BSV_ASSET_LEGACY})`);
  }
  if (req.scheme && req.scheme !== X402_SCHEME) {
    throw new HttpError(502, `Unsupported x402 scheme "${String(req.scheme)}" (want ${X402_SCHEME})`);
  }
  const kind = payloadKind(req.extra);
  if (kind && kind !== P2PKH_RAWTX) {
    throw new HttpError(502, `Unsupported x402 payloadFormat "${kind}" (want ${P2PKH_RAWTX})`);
  }
  const payTo = String(req.payTo ?? "").trim();
  if (!payTo) throw new HttpError(502, "Seller requirements are missing payTo");
  try {
    new P2PKH().lock(payTo);
  } catch {
    throw new HttpError(502, "Seller payTo is not a valid BSV P2PKH address");
  }
  const satoshis = Number.parseInt(String(req.extra?.satoshis ?? req.extra?.perCallSats ?? req.amount ?? ""), 10);
  if (!Number.isFinite(satoshis) || satoshis <= 0) {
    throw new HttpError(502, "Seller requirements have no payable satoshi amount");
  }
  const resource = req.resource ?? envelopeResource ?? null;
  const locking = req.extra?.lockingScriptHex;
  return {
    payTo,
    satoshis,
    resourceUrl: typeof resource?.url === "string" ? resource.url : null,
    description: typeof resource?.description === "string" ? resource.description : null,
    lockingScriptHex: typeof locking === "string" && /^[0-9a-f]+$/i.test(locking) ? locking.toLowerCase() : null,
    accepted,
  };
}

/**
 * Validate a decoded PAYMENT-REQUIRED payload for the BSV `exact` rail.
 * Accepts the legacy single-object challenge and the standard v2 `accepts[]`
 * envelope (choosing the first payable BSV entry).
 */
export function parseBsvRequirements(raw: unknown): BsvRequirements {
  if (!isRecord(raw)) {
    throw new HttpError(502, "Seller returned malformed payment requirements");
  }
  const envelopeResource = isRecord(raw.resource)
    ? (raw.resource as { url?: unknown; description?: unknown })
    : null;

  if (Object.prototype.hasOwnProperty.call(raw, "accepts")) {
    if (!Array.isArray(raw.accepts)) {
      throw new HttpError(502, "Seller returned malformed payment requirements");
    }
    const bsv = raw.accepts.find(isBsvAccept);
    if (!bsv) {
      throw new HttpError(
        502,
        `Seller 402 has no BSV exact accept (want ${BSV_NETWORK}, asset ${BSV_ASSET})`,
      );
    }
    return parseOneAccept(bsv, envelopeResource, isRecord(bsv) ? { ...bsv } : null);
  }

  return parseOneAccept(raw as RawAccept, envelopeResource, null);
}

/** Decode a PAYMENT-REQUIRED header (standard or URL-safe base64 JSON). */
export function decodePaymentRequiredHeader(header: string): unknown {
  const trimmed = header.trim();
  const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
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
    const listed = await fetchSiteWalletUtxos(address);
    const utxos = await filterSpendableUtxos(db, listed, { allowUnconfirmed: true });
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

/** PAYMENT-SIGNATURE JSON. Always includes txHex for existing sellers; v2
 *  accepts[] challenges also echo `accepted` and `payload.{rawtx,lockingScriptHex}`.
 *  EF/BEEF are extra so a seller/broadcaster that understands them can take the
 *  parent along; encoding stays raw-hex for compatibility. */
export function paymentSignaturePayload(
  txHex: string,
  requirements: BsvRequirements,
  extra?: { txHexEF?: string | null; txHexBEEF?: string | null },
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    x402Version: 2,
    scheme: X402_SCHEME,
    network: BSV_NETWORK,
    txHex,
    encoding: "raw-hex",
  };
  if (extra?.txHexEF) envelope.txHexEF = extra.txHexEF;
  if (extra?.txHexBEEF) envelope.txHexBEEF = extra.txHexBEEF;
  if (requirements.accepted || requirements.lockingScriptHex) {
    envelope.accepted = requirements.accepted ?? undefined;
    envelope.payload = {
      txHex,
      rawtx: txHex,
      ...(extra?.txHexEF ? { txHexEF: extra.txHexEF } : {}),
      ...(extra?.txHexBEEF ? { txHexBEEF: extra.txHexBEEF } : {}),
      ...(requirements.lockingScriptHex ? { lockingScriptHex: requirements.lockingScriptHex } : {}),
    };
  }
  return envelope;
}

function b64encodeJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Validate the seller requirements, pick UTXOs, sign an exact payment, record
 * the spent coins, and broadcast EF/BEEF to multiple endpoints. The seller
 * still receives raw txHex (plus EF/BEEF when we have them).
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
  const allowUnconfirmed = env.X402_ALLOW_UNCONFIRMED === "1";
  // Spend confirmed UTXOs only: ARC can orphan a child of a just-confirmed
  // parent it has not indexed yet. D1 spent rows win over a lagging indexer.
  const indexed = allowUnconfirmed ? all : all.filter((u) => u.height > 0);
  const utxos = env.DB ? await filterSpendableUtxos(env.DB, indexed, { allowUnconfirmed }) : indexed;
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
    utxos: utxos.map((u) => ({
      tx_hash: u.tx_hash,
      tx_pos: u.tx_pos,
      value: u.value,
      height: u.height ?? 0,
    })),
    payTo: requirements.payTo,
    satoshis: requirements.satoshis,
    feeSats: feeSatsFor(env),
    fetchParent: (txid) => loadParentTx(txid, env.DB, fetchParentTx),
  });
  if (env.DB) {
    await recordPaymentCoins(env.DB, tx, address);
  }
  await broadcastPaymentTx(env, tx);
  const raw = tx.toHex();
  return {
    txid: tx.id("hex"),
    // Strict x402 v2 envelope: the BSV Wallets facilitator rejects bare {txHex}.
    // Fuse also accepts this `{txHex}` payload; when the challenge was an
    // accepts[] entry we echo `accepted` + `payload.rawtx` as well. EF/BEEF
    // travel as extras so a broadcaster can take the parent with the child.
    paymentSignature: b64encodeJson(
      paymentSignaturePayload(raw, requirements, { txHexEF: txHexEF(tx), txHexBEEF: txHexBEEF(tx) }),
    ),
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
