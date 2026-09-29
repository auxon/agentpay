/**
 * Marketplace: P2P trade with on-chain escrow + advised arbitration.
 *
 * Sellers list digital goods or physical items at a fixed price. Buyers fund
 * a per-order escrow address directly (any wallet — AdFeed's deposit pattern).
 * Sellers deliver (content hash / tracking / note), buyers approve, money
 * releases. Disputes go to a Jev recommendation via decision-oracle with
 * operator execution — never auto-execution. 2% platform fee.
 *
 * Money movement reuses escrow.ts (keys, funding/spend builders, fee math);
 * the escrow rows are shared with bounties via post_ref `market-order:<id>`.
 * Trust observations reuse bounties.ts pushers (release, dispute_lost).
 * No new custody: the daemon never holds buyer or seller keys.
 */
import { HttpError, type AppEnv } from "./types";
import { cleanStr, newId, nowIso } from "./ids";
import {
  arcBroadcastTx,
  buildEscrowSpendTx,
  createEscrowRow,
  decryptEscrowWif,
  encryptEscrowWif,
  escrowAddressFor,
  escrowKeyConfigured,
  feeBpsFromEnv,
  fetchEscrowUtxos,
  generateEscrowWif,
  getEscrowById,
  spendFeeSats,
  updateEscrowRow,
  type BountyEscrowRow,
} from "./escrow";
import { isValidBsvAddress } from "./bounties";
import { pushTrustBountyPaid } from "./bounties";
import { prepareBsvPayment } from "./x402";

export type MarketStatus =
  | "open"
  | "funded"
  | "delivered"
  | "disputed"
  | "paid"
  | "refunded"
  | "expired"
  | "cancelled";

export type Fulfillment = "digital" | "physical";

export interface DeliveryInput {
  kind: unknown;
  hash?: unknown;
  carrier?: unknown;
  tracking?: unknown;
  note?: unknown;
}

export interface Delivery {
  kind: "hash" | "tracking" | "other";
  hash: string | null;
  carrier: string | null;
  tracking: string | null;
  note: string;
  hashMatch: boolean;
  at: string;
}

export interface EvidenceItem {
  side: "buyer" | "seller";
  text: string;
  hashes: string[];
  at: string;
}

export interface MarketOrderRow {
  id: string;
  seller_wallet_id: string;
  seller_agent_id: string | null;
  buyer_wallet_id: string | null;
  buyer_agent_id: string | null;
  buyer_refund_address: string | null;
  /** Optional pre-approved buyer wallet (private/OTC listing). */
  buyer_allow_wallet_id: string | null;
  title: string;
  description: string;
  price_sats: number;
  fee_bps: number;
  fulfillment: Fulfillment;
  content_hash: string | null;
  status: MarketStatus;
  escrow_id: string | null;
  delivery_json: string | null;
  dispute_reason: string | null;
  dispute_at: string | null;
  evidence_json: string;
  resolution_json: string | null;
  payout_txid: string | null;
  refund_txid: string | null;
  delivered_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Buyer approval window before auto-release; funded-but-silent refund horizon. */
export const APPROVAL_DAYS = 7;
export const STALE_FUND_DAYS = 30;
export const MAX_EVIDENCE_ITEMS = 10;

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function fail(code: number, message: string): never {
  throw new HttpError(code, message);
}

function approvalDays(env: AppEnv): number {
  const n = Number.parseInt(String(env.MARKET_APPROVAL_DAYS ?? ""), 10);
  return Number.isFinite(n) && n >= 1 && n <= 90 ? n : APPROVAL_DAYS;
}

function orderUrl(env: AppEnv, id: string): string {
  const base = String(env.APP_ORIGIN ?? "https://entangleit.com").replace(/\/$/, "");
  return `${base}/market/${id}`;
}

export function validateListing(input: {
  title?: unknown;
  description?: unknown;
  priceSats?: unknown;
  fulfillment?: unknown;
  contentHash?: unknown;
  payoutAddress?: unknown;
  buyerWalletId?: unknown;
}): {
  title: string;
  description: string;
  priceSats: number;
  fulfillment: Fulfillment;
  contentHash: string | null;
  payoutAddress: string;
  buyerWalletId: string | null;
} {
  const title = cleanStr(input.title, 120);
  const description = cleanStr(input.description, 2000);
  if (!title) fail(400, "title is required");
  if (!description) fail(400, "description is required");
  const priceSats = Math.floor(Number(input.priceSats));
  if (!Number.isInteger(priceSats) || priceSats <= 0) fail(400, "priceSats must be a positive integer");
  const fulfillment = input.fulfillment === "physical" ? "physical" : "digital";
  let contentHash: string | null = null;
  if (input.contentHash !== undefined && input.contentHash !== null && String(input.contentHash) !== "") {
    if (!HEX64_RE.test(String(input.contentHash).trim())) fail(400, "contentHash must be 64 hex characters");
    contentHash = String(input.contentHash).trim().toLowerCase();
  }
  const payoutAddress = String(input.payoutAddress ?? "").trim();
  if (!isValidBsvAddress(payoutAddress)) fail(400, "payoutAddress is not a valid BSV P2PKH address");
  // Optional pre-approved buyer (private/OTC listing): only this wallet id
  // can claim the buyer role at fund time. Empty = public listing where the
  // first funder claims it — every action is wallet-signed and visible, so
  // griefing is attributable (reputation is the fee).
  let buyerWalletId: string | null = null;
  if (input.buyerWalletId !== undefined && input.buyerWalletId !== null && String(input.buyerWalletId) !== "") {
    buyerWalletId = String(input.buyerWalletId).trim();
    if (!/^apw_[A-Za-z0-9]+$/.test(buyerWalletId)) fail(400, "buyerWalletId must be an agentpay wallet id");
  }
  return { title, description, priceSats, fulfillment, contentHash, payoutAddress, buyerWalletId };
}

export function validateDelivery(
  fulfillment: Fulfillment,
  input: DeliveryInput,
): Omit<Delivery, "hashMatch" | "at"> {
  if (input.kind !== "hash" && input.kind !== "tracking" && input.kind !== "other") {
    fail(400, "delivery kind must be hash, tracking, or other");
  }
  const kind = input.kind;
  const note = cleanStr(input.note, 2000);
  if (kind === "hash") {
    const hash = String(input.hash ?? "").trim().toLowerCase();
    if (!HEX64_RE.test(hash)) fail(400, "delivery hash must be 64 hex characters");
    return { kind, hash, carrier: null, tracking: null, note };
  }
  if (kind === "tracking") {
    const tracking = cleanStr(input.tracking, 120);
    if (!tracking) fail(400, "tracking number required for physical delivery");
    return { kind, hash: null, carrier: cleanStr(input.carrier, 60) || null, tracking, note };
  }
  if (!note) fail(400, "a delivery note is required");
  return { kind, hash: null, carrier: null, tracking: null, note };
}

export async function getOrder(db: D1Database, id: string): Promise<MarketOrderRow | null> {
  if (!ID_RE.test(id)) return null;
  return db.prepare("SELECT * FROM ap_market_orders WHERE id = ?").bind(id).first<MarketOrderRow>();
}

export async function listOpenOrders(db: D1Database, limit = 25): Promise<MarketOrderRow[]> {
  const res = await db
    .prepare("SELECT * FROM ap_market_orders WHERE status = 'open' ORDER BY created_at DESC LIMIT ?")
    .bind(Math.min(Math.max(limit, 1), 50))
    .all<MarketOrderRow>();
  return res.results ?? [];
}

export interface PublicOrder {
  id: string;
  title: string;
  description: string;
  price_sats: number;
  fee_bps: number;
  fulfillment: Fulfillment;
  has_content_hash: boolean;
  status: MarketStatus;
  escrow_address: string | null;
  delivery: Delivery | null;
  dispute_reason: string | null;
  evidence: EvidenceItem[];
  resolution: Resolution | null;
  created_at: string;
  updated_at: string;
}

/**
 * Public view: no wallet/agent ids, no refund address. Delivery tracking
 * and evidence show only once disputed or later (transparency); while
 * funded/delivered they stay party-only.
 */
export async function publicOrder(db: D1Database, order: MarketOrderRow): Promise<PublicOrder> {
  let delivery: Delivery | null = null;
  try {
    const parsed = order.delivery_json ? (JSON.parse(order.delivery_json) as Delivery) : null;
    if (parsed && typeof parsed === "object") delivery = parsed;
  } catch {
    delivery = null;
  }
  let evidence: EvidenceItem[] = [];
  try {
    const parsed = JSON.parse(order.evidence_json || "[]") as EvidenceItem[];
    if (Array.isArray(parsed)) evidence = parsed;
  } catch {
    evidence = [];
  }
  let resolution: PublicOrder["resolution"] = null;
  try {
    resolution = order.resolution_json ? (JSON.parse(order.resolution_json) as PublicOrder["resolution"]) : null;
  } catch {
    resolution = null;
  }
  const escrow = order.escrow_id ? await getEscrowById(db, order.escrow_id).catch(() => null) : null;
  const open = order.status === "disputed" || order.status === "paid" || order.status === "refunded";
  return {
    id: order.id,
    title: order.title,
    description: order.description,
    price_sats: order.price_sats,
    fee_bps: order.fee_bps,
    fulfillment: order.fulfillment,
    has_content_hash: Boolean(order.content_hash),
    status: order.status,
    escrow_address: escrow?.escrow_address ?? null,
    delivery: open ? delivery : null,
    dispute_reason: open ? order.dispute_reason : null,
    evidence: open ? evidence : [],
    resolution,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

/** Seller lists: validates, prices the fee floor, provisions escrow. */
export async function createOrder(
  db: D1Database,
  env: AppEnv,
  seller: { walletId: string; agentId: string | null },
  input: { title?: unknown; description?: unknown; priceSats?: unknown; fulfillment?: unknown; contentHash?: unknown; payoutAddress?: unknown; buyerWalletId?: unknown },
): Promise<{ order: MarketOrderRow; escrowAddress: string }> {
  if (!escrowKeyConfigured(env)) fail(503, "Marketplace escrow is not configured (BOUNTY_ESCROW_KEY missing)");
  const v = validateListing(input);
  const feeBps = feeBpsFromEnv(env);
  const fee = Math.floor((v.priceSats * feeBps) / 10_000);
  const minFee = spendFeeSats(env, 2) + 1;
  if (fee < minFee) {
    fail(400, `price too small: the ${feeBps / 100}% fee (${fee} sats) cannot cover the network fee (${minFee} sats)`);
  }
  const now = nowIso();
  const id = newId("mkt");
  const escrowId = newId("ape");
  const escrowWif = generateEscrowWif();
  const escrowAddress = escrowAddressFor(escrowWif);
  await createEscrowRow(db, {
    id: escrowId,
    walletId: seller.walletId,
    agentId: seller.agentId,
    title: v.title,
    amountSats: v.priceSats,
    feeBps,
    chargedCents: 0,
    postRef: `market-order:${id}`,
    escrowWifEnc: await encryptEscrowWif(env, escrowWif),
    escrowAddress,
    status: "open",
  });
  await db
    .prepare(
      `INSERT INTO ap_market_orders (id, seller_wallet_id, seller_agent_id, buyer_allow_wallet_id, title, description, price_sats, fee_bps, fulfillment, content_hash, status, escrow_id, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, '[]', ?, ?)`,
    )
    .bind(
      id, seller.walletId, seller.agentId, v.buyerWalletId, v.title, v.description, v.priceSats, feeBps,
      v.fulfillment, v.contentHash, escrowId, now, now,
    )
    .run();
  // Stash the seller payout address on the escrow row (address-only column).
  await updateEscrowRow(db, escrowId, { payout_address: v.payoutAddress });
  const order = (await getOrder(db, id))!;
  return { order, escrowAddress };
}

async function escrowFor(db: D1Database, order: MarketOrderRow): Promise<BountyEscrowRow> {
  if (!order.escrow_id) fail(500, "order has no escrow");
  const escrow = await getEscrowById(db, order.escrow_id);
  if (!escrow) fail(500, "escrow row missing");
  return escrow!;
}

function touch(db: D1Database, id: string, patch: Record<string, unknown>) {
  return db
    .prepare(`UPDATE ap_market_orders SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...Object.values(patch), nowIso(), id)
    .run();
}

/**
 * Buyer funds by paying the escrow address directly (any wallet). Called
 * explicitly after paying, or by status polls: UTXO sum >= price flips the
 * order to funded and records the buyer. Idempotent.
 */
export async function checkFunding(
  db: D1Database,
  env: AppEnv,
  orderId: string,
  buyer: { walletId: string; agentId: string | null },
  opts: { refundAddress?: unknown } = {},
): Promise<{ order: MarketOrderRow; funded: boolean; observedSats: number }> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  // Past "open", money already landed or the order terminally closed.
  if (order!.status !== "open") return { order: order!, funded: true, observedSats: 0 };
  if (order!.buyer_allow_wallet_id && order!.buyer_allow_wallet_id !== buyer.walletId) {
    fail(403, "this is a private listing for another buyer");
  }
  let refundAddress: string | null = null;
  if (opts.refundAddress !== undefined && opts.refundAddress !== null && String(opts.refundAddress) !== "") {
    refundAddress = String(opts.refundAddress).trim();
    if (!isValidBsvAddress(refundAddress)) fail(400, "refundAddress is not a valid BSV P2PKH address");
  }
  const escrow = await escrowFor(db, order!);
  const utxos = await fetchEscrowUtxos(escrow.escrow_address);
  const observed = utxos.reduce((sum, u) => sum + (u.value || 0), 0);
  if (observed < order!.price_sats) return { order: order!, funded: false, observedSats: observed };
  const biggest = [...utxos].sort((a, b) => b.value - a.value)[0]!;
  await touch(db, order!.id, {
    status: "funded",
    buyer_wallet_id: buyer.walletId,
    buyer_agent_id: buyer.agentId,
    funding_txid: biggest.tx_hash,
    ...(refundAddress ? { buyer_refund_address: refundAddress } : {}),
  });
  await updateEscrowRow(db, escrow.id, { status: "funded", funding_txid: biggest.tx_hash });
  return { order: (await getOrder(db, order!.id))!, funded: true, observedSats: observed };
}

function requireRole(order: MarketOrderRow, walletId: string, role: "seller" | "buyer"): void {
  const holder = role === "seller" ? order.seller_wallet_id : order.buyer_wallet_id;
  if (!holder || holder !== walletId) fail(403, `only the ${role} acts here`);
}

/** Buyer approves: release to the seller, push the settled-trade fact. */
export async function approveOrder(
  db: D1Database,
  env: AppEnv,
  orderId: string,
  walletId: string,
): Promise<{ order: MarketOrderRow; txid: string }> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  requireRole(order!, walletId, "buyer");
  if (order!.status !== "delivered") fail(409, `order is ${order!.status}, nothing to approve`);
  const { txid } = await executePayout(db, env, order!, "seller", "agentpay:market-release");
  await touch(db, order!.id, { status: "paid", payout_txid: txid });
  await updateEscrowRow(db, order!.escrow_id!, { status: "paid", payout_txid: txid });
  const done = (await getOrder(db, order!.id))!;
  await pushTrustBountyPaid(env, {
    subject: `wallet:${done.seller_wallet_id}`,
    bountyId: done.id,
    amountSats: done.price_sats,
    txid,
  }).catch(() => false);
  return { order: done, txid };
}

const MIN_DISPUTE_REASON = 20;

/** Buyer disputes within the approval window; money freezes until resolve. */
export async function disputeOrder(
  db: D1Database,
  orderId: string,
  walletId: string,
  reason: unknown,
): Promise<{ order: MarketOrderRow }> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  requireRole(order!, walletId, "buyer");
  if (order!.status !== "delivered") fail(409, `order is ${order!.status}, nothing to dispute`);
  const text = cleanStr(reason, 2000);
  if (text.length < MIN_DISPUTE_REASON) {
    fail(400, `dispute needs a reason (at least ${MIN_DISPUTE_REASON} characters) so the arbiter has something to judge`);
  }
  await touch(db, order!.id, { status: "disputed", dispute_reason: text, dispute_at: nowIso() });
  return { order: (await getOrder(db, order!.id))! };
}

/** Either party appends evidence while disputed. */
export async function disputeEvidence(
  db: D1Database,
  orderId: string,
  walletId: string,
  input: { text?: unknown; hashes?: unknown },
): Promise<{ order: MarketOrderRow; evidence: EvidenceItem[] }> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  if (order!.status !== "disputed") fail(409, `order is ${order!.status}, not disputed`);
  const side = order!.seller_wallet_id === walletId ? "seller" : order!.buyer_wallet_id === walletId ? "buyer" : null;
  if (!side) fail(403, "only the buyer or seller adds evidence here");
  const text = cleanStr(input.text, 2000);
  if (!text) fail(400, "evidence text required");
  const hashes = (Array.isArray(input.hashes) ? input.hashes : [])
    .map((h) => String(h ?? "").trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h))
    .slice(0, 10);
  let evidence: EvidenceItem[] = [];
  try {
    const parsed = JSON.parse(order!.evidence_json || "[]") as EvidenceItem[];
    if (Array.isArray(parsed)) evidence = parsed;
  } catch {
    evidence = [];
  }
  if (evidence.length >= MAX_EVIDENCE_ITEMS) fail(400, `evidence capped at ${MAX_EVIDENCE_ITEMS} items per dispute`);
  evidence.push({ side, text, hashes, at: nowIso() });
  await touch(db, order!.id, { evidence_json: JSON.stringify(evidence) });
  return { order: (await getOrder(db, order!.id))!, evidence };
}

export interface Arbitration {
  recommendation: "release" | "refund";
  confidence: number;
  oracleTxid: string | null;
  oracleCostSats: number;
}

function oracleUrl(env: AppEnv): string {
  return String(env.ORACLE_URL ?? "https://entangleit.com/oracle").replace(/\/$/, "");
}

/** Seller cancels while open (no money moved yet). */
export async function cancelOrder(
  db: D1Database,
  walletId: string,
  orderId: string,
): Promise<{ order: MarketOrderRow }> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  requireRole(order!, walletId, "seller");
  if (order!.status !== "open") fail(409, `order is ${order!.status}, too late to cancel`);
  await touch(db, order!.id, { status: "cancelled" });
  if (order!.escrow_id) await updateEscrowRow(db, order!.escrow_id, { status: "cancelled" }).catch(() => {});
  return { order: (await getOrder(db, order!.id))! };
}

export interface SettledDue {
  orderId: string;
  action: "released" | "refunded";
  txid: string;
}

/**
 * Lazy expiry, run on order-touching reads (no cron trigger exists yet).
 * Delivered past the approval window auto-releases to the seller; funded
 * with no delivery past the stale horizon refunds the buyer. Each execution
 * is idempotent through the terminal-state guards in executePayout.
 */
export async function settleDueOrders(
  db: D1Database,
  env: AppEnv,
  now: number = Date.now(),
): Promise<SettledDue[]> {
  const done: SettledDue[] = [];
  const rows = (await db
    .prepare("SELECT * FROM ap_market_orders WHERE status IN ('delivered', 'funded')")
    .all<MarketOrderRow>()).results ?? [];
  for (const row of rows) {
    try {
      if (row.status === "delivered" && row.expires_at && Date.parse(row.expires_at) <= now) {
        const { txid } = await executePayout(db, env, row, "seller", "agentpay:market-expire");
        await touch(db, row.id, { status: "expired", payout_txid: txid });
        await updateEscrowRow(db, row.escrow_id!, { status: "paid", payout_txid: txid });
        const settled = (await getOrder(db, row.id))!;
        await pushTrustBountyPaid(env, {
          subject: `wallet:${settled.seller_wallet_id}`,
          bountyId: settled.id,
          amountSats: settled.price_sats,
          txid,
        }).catch(() => false);
        done.push({ orderId: row.id, action: "released", txid });
      } else if (row.status === "funded") {
        const fundedAt = Date.parse(row.updated_at);
        if (Number.isFinite(fundedAt) && now - fundedAt > STALE_FUND_DAYS * 86_400_000) {
          const full = (await getOrder(db, row.id))!;
          const { txid } = await executePayout(db, env, full, "buyer", "agentpay:market-stale");
          await touch(db, row.id, { status: "refunded", refund_txid: txid });
          await updateEscrowRow(db, row.escrow_id!, { status: "refunded", refund_txid: txid });
          done.push({ orderId: row.id, action: "refunded", txid });
        }
      }
    } catch {
      /* one stuck order must not block the rest */
    }
  }
  return done;
}

export interface Resolution {
  recommendation: "release" | "refund";
  confidence: number;
  executed: "release" | "refund";
  overridden: boolean;
  txid: string;
  oracleTxid: string | null;
  oracleCostSats: number;
}

/**
 * Operator resolves a dispute: Jev recommends (always called, always
 * recorded), the operator executes the recommendation or an explicit
 * override. Either way the ruling — and who ruled — is on the record.
 * Reputation follows the money: release pushes settled-trade, a refund
 * against the seller pushes dispute_lost on the seller.
 */
export async function resolveOrder(
  db: D1Database,
  env: AppEnv,
  orderId: string,
  opts: { override?: "release" | "refund" } = {},
): Promise<{ order: MarketOrderRow; resolution: Resolution }> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  if (order!.status !== "disputed") fail(409, `order is ${order!.status}, not disputed`);
  if (opts.override !== undefined && opts.override !== "release" && opts.override !== "refund") {
    fail(400, "override must be 'release' or 'refund'");
  }
  const arb = await arbitrateDispute(db, env, orderId);
  const executed = opts.override ?? arb.recommendation;
  const dest = executed === "release" ? "seller" : "buyer";
  const { txid } = await executePayout(db, env, order!, dest, "agentpay:market-resolve");
  await touch(db, order!.id, {
    status: executed === "release" ? "paid" : "refunded",
    ...(executed === "release" ? { payout_txid: txid } : { refund_txid: txid }),
    resolution_json: JSON.stringify({
      recommendation: arb.recommendation,
      confidence: arb.confidence,
      executed,
      overridden: opts.override !== undefined && opts.override !== arb.recommendation,
      txid,
      oracleTxid: arb.oracleTxid,
      oracleCostSats: arb.oracleCostSats,
      at: nowIso(),
    }),
  });
  await updateEscrowRow(db, order!.escrow_id!, {
    status: executed === "release" ? "paid" : "refunded",
    ...(executed === "release" ? { payout_txid: txid } : { refund_txid: txid }),
  });
  const done = (await getOrder(db, order!.id))!;
  if (executed === "release") {
    await pushTrustBountyPaid(env, {
      subject: `wallet:${done.seller_wallet_id}`,
      bountyId: done.id,
      amountSats: done.price_sats,
      txid,
    }).catch(() => false);
  } else {
    await pushTrustBountyPaid(env, {
      subject: `wallet:${done.seller_wallet_id}`,
      bountyId: done.id,
      amountSats: done.price_sats,
      txid,
      kind: "dispute_lost",
    }).catch(() => false);
  }
  const resolution: Resolution = {
    recommendation: arb.recommendation,
    confidence: arb.confidence,
    executed,
    overridden: opts.override !== undefined && opts.override !== arb.recommendation,
    txid,
    oracleTxid: arb.oracleTxid,
    oracleCostSats: arb.oracleCostSats,
  };
  return { order: done, resolution };
}

/**
 * Ask decision-oracle to judge the dispute (blind: listing + delivery +
 * both evidence bundles). Paid 5 sats from the site treasury per call.
 * Never executes — the operator does that with resolveOrder.
 */
export async function arbitrateDispute(
  db: D1Database,
  env: AppEnv,
  orderId: string,
): Promise<Arbitration> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  if (order!.status !== "disputed") fail(409, `order is ${order!.status}, not disputed`);
  let evidence: EvidenceItem[] = [];
  try {
    const parsed = JSON.parse(order!.evidence_json || "[]") as EvidenceItem[];
    if (Array.isArray(parsed)) evidence = parsed;
  } catch {
    evidence = [];
  }
  const content = [
    `Marketplace dispute for order ${order!.id}: "${order!.title}" (${order!.price_sats} sats, ${order!.fulfillment}).`,
    `Listing: ${order!.description}`.slice(0, 1000),
    `Delivery: ${order!.delivery_json ?? "none recorded"}`.slice(0, 800),
    `Buyer reason: ${order!.dispute_reason ?? "none"}`.slice(0, 1000),
    ...evidence.slice(0, 10).map((e, i) => `Evidence ${i + 1} (${e.side}): ${e.text}`.slice(0, 800)),
  ].join("\n").slice(0, 4000);
  const ask = {
    content,
    questions: [{
      id: "outcome",
      type: "choice",
      question: "Should escrow release to the seller (work delivered as described) or refund the buyer?",
      options: ["release", "refund"],
    }],
  };
  const probe = await fetch(`${oracleUrl(env)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ask),
  });
  if (probe.status !== 402) fail(502, `oracle did not quote (got ${probe.status})`);
  const header = probe.headers.get("PAYMENT-REQUIRED");
  if (!header) fail(502, "402 without PAYMENT-REQUIRED header");
  let requirements: unknown;
  try {
    const bin = atob(header);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    requirements = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(502, "PAYMENT-REQUIRED is not decodable");
  }
  const { parseBsvRequirements } = await import("./x402");
  const prepared = await prepareBsvPayment(env, parseBsvRequirements(requirements));
  const paid = await fetch(`${oracleUrl(env)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": prepared.paymentSignature },
    body: JSON.stringify(ask),
  });
  if (!paid.ok) fail(502, `oracle call failed (${paid.status})`);
  const out = (await paid.json().catch(() => null)) as {
    results?: Array<{ id?: string; value?: unknown; confidence?: unknown }>;
  } | null;
  const pick = out?.results?.find((r) => r.id === "outcome");
  if (pick?.value !== "release" && pick?.value !== "refund") fail(502, "oracle returned no usable verdict");
  return {
    recommendation: pick.value,
    confidence: Number(pick.confidence) || 0,
    oracleTxid: prepared.txid,
    oracleCostSats: prepared.satoshis,
  };
}

/** Seller delivers: hash (digital), tracking (physical), or a note. */
export async function deliverOrder(
  db: D1Database,
  env: AppEnv,
  walletId: string,
  orderId: string,
  input: DeliveryInput,
): Promise<{ order: MarketOrderRow; hashMatch: boolean }> {
  const order = await getOrder(db, orderId);
  if (!order) fail(404, "order not found");
  requireRole(order!, walletId, "seller");
  if (order!.status !== "funded") fail(409, `order is ${order!.status}, not funded`);
  const d = validateDelivery(order!.fulfillment, input);
  const hashMatch = Boolean(
    d.kind === "hash" && order!.content_hash && d.hash!.toLowerCase() === order!.content_hash.toLowerCase(),
  );
  const delivery: Delivery = { ...d, hashMatch, at: nowIso() };
  await touch(db, order!.id, {
    status: "delivered",
    delivery_json: JSON.stringify(delivery),
    delivered_at: nowIso(),
    expires_at: new Date(Date.now() + approvalDays(env) * 86_400_000).toISOString(),
  });
  return { order: (await getOrder(db, order!.id))!, hashMatch };
}

/**
 * Shared release/refund executor: builds, broadcasts, records. Idempotent:
 * terminal escrow rows return the recorded txid. Refunds go to the buyer's
 * stated refund address (kept at fund time); without one the money stays
 * locked and the resolve fails loudly for manual handling.
 */
async function executePayout(
  db: D1Database,
  env: AppEnv,
  order: MarketOrderRow,
  to: "seller" | "buyer",
  marker: string,
): Promise<{ txid: string }> {
  const escrow = await escrowFor(db, order);
  if (escrow.status === "paid" || escrow.status === "refunded") {
    return { txid: escrow.payout_txid || escrow.refund_txid || "" };
  }
  const key = await decryptEscrowWif(env, escrow.escrow_wif_enc).catch(() => null);
  if (!key) fail(503, "payout signing is not configured");
  const dest = to === "seller" ? escrow.payout_address : order.buyer_refund_address;
  if (!dest || !isValidBsvAddress(dest)) {
    fail(409, to === "seller" ? "seller payout address missing" : "buyer refund address missing — supply one and resolve again");
  }
  const utxos = await fetchEscrowUtxos(escrow.escrow_address);
  const utxo = utxos.find((u) => u.value >= order.price_sats) ?? utxos[0];
  if (!utxo) fail(409, "escrow UTXO not found (spent or unindexed)");
  const { siteWalletAddress } = await import("./x402");
  const treasury = siteWalletAddress(env);
  const networkFee = spendFeeSats(env, 2);
  const fee = Math.floor((order.price_sats * order.fee_bps) / 10_000);
  const operatorFee = fee - networkFee - 1;
  const net = order.price_sats - fee;
  const outputs = [{ address: dest!, satoshis: Math.max(1, net) }];
  if (to === "seller" && treasury && operatorFee > 0) outputs.push({ address: treasury, satoshis: operatorFee });
  const tx = await buildEscrowSpendTx({ env, escrowKey: key!, utxo, outputs, marker: `${marker}:${order.id}` });
  const broadcast = await arcBroadcastTx(env, tx.toHex());
  return { txid: broadcast.txid || tx.id("hex") };
}
