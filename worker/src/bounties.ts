/**
 * BSVBounties bridge — the earn side of the agentpay loop.
 *
 * Agents browse and claim work on the bsv-bounties marketplace through the
 * same MCP/wallet they use to spend. Claims made here are linked to the
 * agentpay wallet, so when the bounty settles, bsv-bounties posts an event to
 * /internal/bounty-event and the linked wallet is credited (idempotent).
 */
import { cleanStr, newId, nowIso } from "./ids";
import { HttpError, type AgentRow, type AppEnv, type WalletRow } from "./types";
import { siteWalletAddress } from "./x402";
import { refundSpend, spend } from "./ledger";
import {
  arcBroadcastTx,
  buildEscrowFundingTx,
  buildEscrowSpendTx,
  createEscrowRow,
  decryptEscrowWif,
  encryptEscrowWif,
  escrowAddressFor,
  escrowKeyConfigured,
  feeBpsFromEnv,
  fetchEscrowUtxos,
  generateEscrowWif,
  getEscrowRow,
  listEscrowRows,
  spendFeeSats,
  sweepSats,
  updateEscrowRow,
  type BountyEscrowRow,
  type TxOutput,
} from "./escrow";
import { PrivateKey } from "@bsv/sdk";

/** Public fallback. Production uses the BOUNTIES service binding. */
export const BOUNTIES_FALLBACK_URL = "https://bsv-bounties.richard-hein.workers.dev";
export const BOUNTIES_API_PREFIX = "/bsvbounties/v1";

/** $25/BSV default, matching bsv-bounties' BSV_USD var. */
export const DEFAULT_SATS_PER_CENT = 40_000;

export type BountyRecord = {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  category?: string;
  amountSats?: number;
  [key: string]: unknown;
};

export interface BountyLinkRow {
  bounty_id: string;
  wallet_id: string;
  agent_id: string | null;
  worker_ref: string;
  title: string;
  amount_sats: number | null;
  status: "claimed" | "submitted" | "paid" | "refunded";
  settle_txid: string | null;
  credited_cents: number | null;
  credited_at: string | null;
  payout_address: string | null;
  created_at: string;
  updated_at: string;
}

export interface BountyEvent {
  bountyId: string;
  outcome: "paid" | "refunded" | string;
  amountSats?: number;
  workerPubKey?: string;
  workerAccount?: number;
  settleTxid?: string;
  title?: string;
  category?: string;
  /** Funding rail recorded by bsv-bounties ('agentpay' = on-chain escrow here). */
  funding?: string | null;
  /** Poster identity; agentpay-funded posts use `agentpay:<walletId>`. */
  posterRef?: string | null;
}

export function bountyRecord(payload: unknown): BountyRecord | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const record = body.bounty ?? body;
  if (!record || typeof record !== "object") return null;
  const r = record as BountyRecord;
  return r.id ? r : null;
}

export function workerRefFor(walletId: string): string {
  return `agentpay:${walletId}`;
}

export function satsPerCent(env: AppEnv): number {
  const raw = Number(env.BOUNTY_SATS_PER_CENT ?? env.X402_SATS_PER_CENT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SATS_PER_CENT;
}

export function centsForSats(sats: number, env: AppEnv): number {
  const perCent = satsPerCent(env);
  return Math.max(1, Math.round(sats / perCent));
}

function baseUrl(env: AppEnv): string {
  return (env.BOUNTIES_API_URL || BOUNTIES_FALLBACK_URL).replace(/\/$/, "");
}

async function bountiesFetch(
  env: AppEnv,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const url = `${BOUNTIES_API_PREFIX}${path}`;
  let res: Response;
  try {
    if (env.BOUNTIES) {
      res = await env.BOUNTIES.fetch(
        new Request(`https://bsv-bounties.internal${url}`, init),
      );
    } else {
      res = await fetch(`${baseUrl(env)}${url}`, init);
    }
  } catch (err) {
    throw new HttpError(502, `bsv-bounties unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

async function bountiesJson(
  env: AppEnv,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const { status, json } = await bountiesFetch(env, path, init);
  if (status >= 400) {
    const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const message = typeof body.error === "string" ? body.error : `bsv-bounties HTTP ${status}`;
    throw new HttpError(status === 404 ? 404 : 502, message, body);
  }
  return json;
}

export async function listBounties(
  env: AppEnv,
  query: { status?: string; category?: string; limit?: number; offset?: number } = {},
): Promise<unknown> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.category) params.set("category", query.category);
  if (query.limit != null) params.set("limit", String(query.limit));
  if (query.offset != null) params.set("offset", String(query.offset));
  const qs = params.toString();
  return bountiesJson(env, `/bounties${qs ? `?${qs}` : ""}`);
}

export async function getBounty(env: AppEnv, id: string): Promise<unknown> {
  return bountiesJson(env, `/bounties/${encodeURIComponent(id)}`);
}

export async function claimBountyRemote(
  env: AppEnv,
  id: string,
  workerRef: string,
): Promise<unknown> {
  return bountiesJson(env, `/bounties/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workerPubKey: workerRef }),
  });
}

export async function submitWorkRemote(
  env: AppEnv,
  id: string,
  work: { workHash?: string; workUri?: string; notes?: string; milestoneIndex?: number },
): Promise<unknown> {
  return bountiesJson(env, `/bounties/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(work),
  });
}

export async function linkBounty(
  db: D1Database,
  input: {
    bountyId: string;
    walletId: string;
    agentId: string | null;
    workerRef: string;
    title?: string;
    amountSats?: number | null;
    payoutAddress?: string | null;
  },
): Promise<BountyLinkRow> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO ap_bounty_links (bounty_id, wallet_id, agent_id, worker_ref, title, amount_sats, status, payout_address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?)
       ON CONFLICT(bounty_id) DO UPDATE SET
         wallet_id = excluded.wallet_id,
         agent_id = excluded.agent_id,
         worker_ref = excluded.worker_ref,
         title = excluded.title,
         amount_sats = COALESCE(excluded.amount_sats, ap_bounty_links.amount_sats),
         payout_address = COALESCE(excluded.payout_address, ap_bounty_links.payout_address),
         status = CASE WHEN ap_bounty_links.status IN ('paid', 'refunded') THEN ap_bounty_links.status ELSE 'claimed' END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.bountyId,
      input.walletId,
      input.agentId,
      input.workerRef,
      input.title ?? "",
      input.amountSats ?? null,
      input.payoutAddress ?? null,
      now,
      now,
    )
    .run();
  const row = await getLink(db, input.bountyId);
  if (!row) throw new HttpError(500, "Failed to record bounty link");
  return row;
}

export async function getLink(db: D1Database, bountyId: string): Promise<BountyLinkRow | null> {
  return db
    .prepare("SELECT * FROM ap_bounty_links WHERE bounty_id = ?")
    .bind(bountyId)
    .first<BountyLinkRow>();
}

export async function listLinks(db: D1Database, walletId: string, limit = 50): Promise<BountyLinkRow[]> {
  const res = await db
    .prepare("SELECT * FROM ap_bounty_links WHERE wallet_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(walletId, Math.min(Math.max(limit, 1), 100))
    .all<BountyLinkRow>();
  return res.results ?? [];
}

export async function touchLinkStatus(
  db: D1Database,
  bountyId: string,
  status: BountyLinkRow["status"],
): Promise<void> {
  await db
    .prepare(
      `UPDATE ap_bounty_links
       SET status = ?, updated_at = ?
       WHERE bounty_id = ? AND status NOT IN ('paid', 'refunded')`,
    )
    .bind(status, nowIso(), bountyId)
    .run();
}

/**
 * Credits a wallet for a settled bounty. Idempotent by `bounty:<id>` ref via
 * the shared ap_topup_refs ledger guard, so webhook replays cannot double-pay.
 */
export async function creditBountyPayout(
  db: D1Database,
  env: AppEnv,
  input: { bountyId: string; walletId: string; amountSats: number; settleTxid?: string },
): Promise<{ credited: boolean; amountCents: number; balanceCents: number }> {
  const amountSats = Math.floor(input.amountSats);
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new HttpError(400, "Bounty amountSats must be a positive integer");
  }
  const amountCents = centsForSats(amountSats, env);
  const ref = `bounty:${input.bountyId}`;

  const claimed = await db
    .prepare("INSERT OR IGNORE INTO ap_topup_refs (ref, wallet_id, amount_cents, created_at) VALUES (?, ?, ?, ?)")
    .bind(ref, input.walletId, amountCents, nowIso())
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) {
    const balance = await db
      .prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?")
      .bind(input.walletId)
      .first<{ balance_cents: number }>();
    return { credited: false, amountCents: 0, balanceCents: balance?.balance_cents ?? 0 };
  }

  const wallet = await db
    .prepare("SELECT id, status FROM ap_wallets WHERE id = ?")
    .bind(input.walletId)
    .first<{ id: string; status: string }>();
  if (!wallet) throw new HttpError(404, "Wallet not found");
  if (wallet.status !== "active") throw new HttpError(403, "Wallet is frozen");

  await db
    .prepare("UPDATE ap_wallets SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?")
    .bind(amountCents, nowIso(), input.walletId)
    .run();

  const balance = await db
    .prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?")
    .bind(input.walletId)
    .first<{ balance_cents: number }>();
  const balanceCents = balance?.balance_cents ?? 0;

  await db
    .prepare(
      `INSERT INTO ap_ledger (id, wallet_id, agent_id, kind, amount_cents, balance_after_cents, currency, ref, meta_json, created_at)
       VALUES (?, ?, NULL, 'adjust', ?, ?, 'usd', ?, ?, ?)`,
    )
    .bind(
      newId("apl"),
      input.walletId,
      amountCents,
      balanceCents,
      ref,
      JSON.stringify({
        type: "bounty_payout",
        bountyId: input.bountyId,
        amountSats,
        satsPerCent: satsPerCent(env),
        settleTxid: input.settleTxid ?? null,
        description: "Bounty payout",
      }),
      nowIso(),
    )
    .run();

  await db
    .prepare(
      `UPDATE ap_bounty_links
       SET status = 'paid', credited_cents = ?, credited_at = ?, settle_txid = COALESCE(?, settle_txid), updated_at = ?
       WHERE bounty_id = ?`,
    )
    .bind(amountCents, nowIso(), input.settleTxid ?? null, nowIso(), input.bountyId)
    .run();

  return { credited: true, amountCents, balanceCents };
}

export async function handleBountyEvent(
  db: D1Database,
  env: AppEnv,
  event: BountyEvent,
): Promise<{ ok: boolean; credited: boolean; reason?: string; amountCents?: number }> {
  if (event.funding === "agentpay" || event.posterRef?.startsWith("agentpay:")) {
    return processEscrowEvent(db, env, event);
  }

  const link = await getLink(db, event.bountyId);
  if (!link) return { ok: true, credited: false, reason: "no_agentpay_link" };

  if (event.outcome === "refunded") {
    await db
      .prepare(
        `UPDATE ap_bounty_links SET status = 'refunded', settle_txid = COALESCE(?, settle_txid), updated_at = ? WHERE bounty_id = ?`,
      )
      .bind(event.settleTxid ?? null, nowIso(), event.bountyId)
      .run();
    return { ok: true, credited: false, reason: "refunded" };
  }

  if (event.outcome !== "paid") {
    return { ok: true, credited: false, reason: `ignored:${event.outcome}` };
  }

  const amountSats = event.amountSats ?? link.amount_sats ?? 0;
  if (!amountSats || amountSats <= 0) {
    return { ok: true, credited: false, reason: "missing_amount" };
  }
  const result = await creditBountyPayout(db, env, {
    bountyId: event.bountyId,
    walletId: link.wallet_id,
    amountSats,
    settleTxid: event.settleTxid,
  });
  return { ok: true, credited: result.credited, amountCents: result.amountCents };
}

/** Payout instructions returned to the claiming agent. */
export function bountyPayoutInfo(env: AppEnv): { address: string | null; note: string } {
  const address = siteWalletAddress(env);
  const note = address
    ? `When you submit, include "payout: ${address}" in your notes so the poster pays the agentpay treasury. Your agentpay balance is credited when bsv-bounties settles the bounty.`
    : "agentpay treasury is not configured yet — a human must fund it before payouts can settle.";
  return { address, note };
}

// ---------- agentpay-funded bounties (on-chain sats escrow) ----------

const P2PKH_ADDRESS = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

export function isValidBsvAddress(value: unknown): value is string {
  return typeof value === "string" && P2PKH_ADDRESS.test(value.trim());
}

/** Charges round up so treasury sats never sell below the posted rate. */
export function chargeCentsForSats(amountSats: number, env: AppEnv): number {
  return Math.max(1, Math.ceil(amountSats / satsPerCent(env)));
}

async function bountiesInternalJson(
  env: AppEnv,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const secret = env.BOUNTIES_WEBHOOK_SECRET;
  if (!secret) {
    throw new HttpError(503, "Bounties bridge is not configured (BOUNTIES_WEBHOOK_SECRET missing)");
  }
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-agentpay-internal", secret);
  return bountiesJson(env, path, { ...init, headers });
}

export interface PostBountyInput {
  wallet: WalletRow;
  agent: AgentRow | null;
  title: string;
  description: string;
  category?: string;
  amountSats: number;
  deadline?: number;
  payoutAddress?: string | null;
}

export function publicEscrow(row: BountyEscrowRow): Record<string, unknown> {
  return {
    id: row.id,
    bountyId: row.bounty_id,
    title: row.title,
    amountSats: row.amount_sats,
    feeBps: row.fee_bps,
    chargedCents: row.charged_cents,
    escrowAddress: row.escrow_address,
    fundingTxid: row.funding_txid,
    payoutTxid: row.payout_txid,
    refundTxid: row.refund_txid,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

/**
 * Post a bounty funded from the wallet balance and escrowed on-chain:
 * charge the wallet, broadcast treasury → per-bounty P2PKH, then list on
 * bsv-bounties under the agentpay funding rail. Any failure unwinds the
 * charge (and sweeps the escrow back when the listing step fails).
 */
export async function postFundedBounty(
  db: D1Database,
  env: AppEnv,
  input: PostBountyInput,
): Promise<{ bounty: BountyRecord; escrow: Record<string, unknown>; receiptId: string }> {
  if (!escrowKeyConfigured(env)) {
    throw new HttpError(503, "Bounty escrow is not configured (BOUNTY_ESCROW_KEY missing)");
  }
  const wif = env.SITE_WALLET_WIF?.trim();
  if (!wif) throw new HttpError(503, "BSV treasury is not configured (SITE_WALLET_WIF missing)");
  const treasury = siteWalletAddress(env);
  if (!treasury) throw new HttpError(503, "BSV treasury address is not available");

  const title = cleanStr(input.title, 120);
  const description = cleanStr(input.description, 2000);
  if (!title) throw new HttpError(400, "title is required");
  if (!description) throw new HttpError(400, "description is required");
  const amountSats = Math.floor(Number(input.amountSats));
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new HttpError(400, "amountSats must be a positive integer");
  }
  if (input.payoutAddress && !isValidBsvAddress(input.payoutAddress)) {
    throw new HttpError(400, "payoutAddress is not a valid BSV P2PKH address");
  }

  const amountCents = chargeCentsForSats(amountSats, env);
  const feeBps = feeBpsFromEnv(env);
  const minFeeSats = spendFeeSats(env, 2) + 1;
  if (Math.floor((amountSats * feeBps) / 10_000) < minFeeSats) {
    throw new HttpError(
      400,
      `amountSats is too small: the platform fee must cover the ~${minFeeSats}-sat network cost`,
    );
  }
  const escrowId = newId("ape");
  const postRef = `bounty-escrow:${escrowId}`;

  const charge = await spend(db, {
    walletId: input.wallet.id,
    agent: input.agent,
    amountCents,
    description: `Bounty escrow: ${title}`,
    service: "bsvbounties",
    tool: "post_bounty",
    ref: postRef,
    meta: { amountSats, feeBps, escrowId, category: input.category ?? null },
  });

  const escrowWif = generateEscrowWif();
  const escrowAddress = escrowAddressFor(escrowWif);
  const escrowWifEnc = await encryptEscrowWif(env, escrowWif);
  await createEscrowRow(db, {
    id: escrowId,
    walletId: input.wallet.id,
    agentId: input.agent?.id ?? null,
    title,
    amountSats,
    feeBps,
    chargedCents: amountCents,
    postRef,
    escrowWifEnc,
    escrowAddress,
    status: "pending",
  });

  let fundingTxid: string;
  try {
    const tx = await buildEscrowFundingTx({
      env,
      treasuryKey: PrivateKey.fromWif(wif),
      escrowAddress,
      satoshis: amountSats,
      marker: `agentpay:bounty:${escrowId}`,
    });
    const broadcast = await arcBroadcastTx(env, tx.toHex());
    fundingTxid = broadcast.txid || tx.id("hex");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await refundSpend(db, {
      walletId: input.wallet.id,
      agentId: input.agent?.id ?? null,
      amountCents,
      ref: `${postRef}:refund`,
      description: `Bounty funding failed: ${title}`,
      receiptId: charge.receipt.id,
    });
    await updateEscrowRow(db, escrowId, { status: "failed", error: message });
    throw new HttpError(502, `Escrow funding failed: ${message}`);
  }
  await updateEscrowRow(db, escrowId, { funding_txid: fundingTxid, status: "funded" });

  try {
    const created = await bountiesInternalJson(env, "/internal/agentpay/bounties", {
      method: "POST",
      body: JSON.stringify({
        title,
        description,
        category: input.category ?? "other",
        amountSats,
        deadline: input.deadline,
        escrowTxid: fundingTxid,
        posterRef: workerRefFor(input.wallet.id),
        feeBps,
        payoutAddress: input.payoutAddress ?? null,
      }),
    });
    const record = bountyRecord(created);
    if (!record?.id) throw new HttpError(502, "bsv-bounties did not return a bounty id");
    await updateEscrowRow(db, escrowId, { bounty_id: record.id, status: "open" });
    return {
      bounty: record,
      escrow: { id: escrowId, address: escrowAddress, fundingTxid, amountSats, chargedCents: amountCents },
      receiptId: charge.receipt.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let recovered = false;
    try {
      const escrowKey = PrivateKey.fromWif(escrowWif);
      const utxos = await fetchEscrowUtxos(escrowAddress);
      const utxo = utxos.find((u) => u.tx_hash === fundingTxid) ?? utxos[0];
      if (utxo) {
        const refundTx = await buildEscrowSpendTx({
          env,
          escrowKey,
          utxo,
          outputs: [{ address: treasury, satoshis: Math.max(1, sweepSats(env, utxo.value, 1)) }],
          marker: `agentpay:bounty-unwind:${escrowId}`,
        });
        await arcBroadcastTx(env, refundTx.toHex());
        recovered = true;
      }
    } catch {
      /* leave the escrow for manual recovery */
    }
    await refundSpend(db, {
      walletId: input.wallet.id,
      agentId: input.agent?.id ?? null,
      amountCents,
      ref: `${postRef}:refund`,
      description: `Bounty listing failed: ${title}`,
      receiptId: charge.receipt.id,
    });
    await updateEscrowRow(db, escrowId, {
      status: recovered ? "funding_failed" : "recovery_needed",
      error: message,
    });
    throw new HttpError(502, `Bounty listing failed: ${message}`);
  }
}

/** Poster approval/refund: settle on bsv-bounties; the event drives the payout. */
export async function settleFundedBounty(
  db: D1Database,
  env: AppEnv,
  input: { walletId: string; bountyId: string; outcome: "paid" | "refunded" },
): Promise<{ result: unknown; escrow: Record<string, unknown> | null }> {
  const row = await getEscrowRow(db, input.bountyId);
  if (!row || row.wallet_id !== input.walletId) {
    throw new HttpError(404, "Agentpay-funded bounty not found for this wallet");
  }
  if (row.status === "paid" || row.status === "refunded") {
    throw new HttpError(409, `Bounty is already ${row.status}`);
  }
  const result = await bountiesInternalJson(
    env,
    `/internal/agentpay/bounties/${encodeURIComponent(input.bountyId)}/settle`,
    { method: "POST", body: JSON.stringify({ outcome: input.outcome }) },
  );
  const after = await getEscrowRow(db, input.bountyId);
  return { result, escrow: after ? publicEscrow(after) : null };
}

/** Retry a payout/refund that was blocked (missing address, ARC hiccup). */
export async function retryFundedBounty(
  db: D1Database,
  env: AppEnv,
  input: { walletId: string; bountyId: string },
): Promise<{ ok: boolean; credited: boolean; reason?: string; amountCents?: number }> {
  const row = await getEscrowRow(db, input.bountyId);
  if (!row || row.wallet_id !== input.walletId) {
    throw new HttpError(404, "Agentpay-funded bounty not found for this wallet");
  }
  if (row.status === "paid" || row.status === "refunded") {
    return { ok: true, credited: false, reason: `already_${row.status}` };
  }
  const record = bountyRecord(await getBounty(env, input.bountyId));
  const status = typeof record?.status === "string" ? record.status : "";
  if (status !== "paid" && status !== "refunded") {
    throw new HttpError(409, `Bounty is ${status || "unknown"}, not settled`);
  }
  return processEscrowEvent(db, env, {
    bountyId: input.bountyId,
    outcome: status,
    amountSats: row.amount_sats,
    funding: "agentpay",
    posterRef: workerRefFor(row.wallet_id),
  });
}

/**
 * Executes the on-chain payout/refund for an agentpay-funded bounty once
 * bsv-bounties reports the outcome. Idempotent: terminal rows are skipped.
 */
export async function processEscrowEvent(
  db: D1Database,
  env: AppEnv,
  event: BountyEvent,
): Promise<{ ok: boolean; credited: boolean; reason?: string; amountCents?: number }> {
  const row = await getEscrowRow(db, event.bountyId);
  if (!row) return { ok: true, credited: false, reason: "no_agentpay_escrow" };
  if (row.status === "paid" || row.status === "refunded") {
    return { ok: true, credited: false, reason: `already_${row.status}` };
  }
  const treasury = siteWalletAddress(env);
  if (!treasury) return { ok: true, credited: false, reason: "treasury_unavailable" };

  const escrowKey = await decryptEscrowWif(env, row.escrow_wif_enc);
  const utxos = await fetchEscrowUtxos(row.escrow_address);
  let utxo = utxos.find((u) => u.tx_hash === row.funding_txid) ?? utxos[0];
  if (!utxo && row.funding_txid) {
    // WOC's address index lags fresh outputs; output 0 of the funding tx is
    // always the escrow P2PKH, and its value is the posted amount.
    utxo = { tx_hash: row.funding_txid, tx_pos: 0, value: row.amount_sats, height: 0 };
  }
  if (!utxo) {
    await updateEscrowRow(db, row.id, {
      status: "payout_pending",
      error: "escrow UTXO not found (spent or unindexed)",
    });
    return { ok: true, credited: false, reason: "escrow_utxo_missing" };
  }

  const networkFee = spendFeeSats(env, 2);
  const fee = Math.floor((row.amount_sats * row.fee_bps) / 10_000);
  if (fee < networkFee + 1) {
    await updateEscrowRow(db, row.id, {
      status: "payout_pending",
      error: `platform fee (${fee} sats) cannot cover the network fee (${networkFee} sats)`,
    });
    return { ok: true, credited: false, reason: "fee_below_network_cost" };
  }
  const operatorFee = fee - networkFee - 1;
  const net = row.amount_sats - fee;

  if (event.outcome === "refunded") {
    try {
      const tx = await buildEscrowSpendTx({
        env,
        escrowKey,
        utxo,
        outputs: [
          { address: treasury, satoshis: Math.max(1, sweepSats(env, utxo.value, 2)) },
        ],
        marker: `agentpay:bounty-refund:${event.bountyId}`,
      });
      const broadcast = await arcBroadcastTx(env, tx.toHex());
      const txid = broadcast.txid || tx.id("hex");
      await updateEscrowRow(db, row.id, { status: "refunded", refund_txid: txid, error: null });
      await refundSpend(db, {
        walletId: row.wallet_id,
        agentId: row.agent_id,
        amountCents: row.charged_cents,
        ref: `bounty-refund:${event.bountyId}`,
        description: `Bounty refunded: ${row.title}`,
      });
      await bountiesInternalJson(
        env,
        `/internal/agentpay/bounties/${encodeURIComponent(event.bountyId)}/txid`,
        { method: "PATCH", body: JSON.stringify({ txid, status: "refunded" }) },
      ).catch(() => {});
      return { ok: true, credited: false, reason: "refunded" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateEscrowRow(db, row.id, { status: "refund_pending", error: message });
      return { ok: true, credited: false, reason: `refund_pending: ${message}` };
    }
  }

  if (event.outcome !== "paid") {
    return { ok: true, credited: false, reason: `ignored:${event.outcome}` };
  }

  const link = await getLink(db, event.bountyId);
  const payoutAddress = link?.payout_address ?? null;
  if (!link && !isValidBsvAddress(payoutAddress)) {
    await updateEscrowRow(db, row.id, {
      status: "payout_pending",
      error: "worker has no agentpay link or payout address",
    });
    return { ok: true, credited: false, reason: "payout_target_missing" };
  }

  const direct = isValidBsvAddress(payoutAddress);
  const outputs: TxOutput[] = [];
  outputs.push({ address: direct ? payoutAddress : treasury, satoshis: net });
  if (operatorFee > 0) outputs.push({ address: treasury, satoshis: operatorFee });

  try {
    const tx = await buildEscrowSpendTx({
      env,
      escrowKey,
      utxo,
      outputs,
      marker: `agentpay:bounty-payout:${event.bountyId}`,
    });
    const broadcast = await arcBroadcastTx(env, tx.toHex());
    const txid = broadcast.txid || tx.id("hex");
    await updateEscrowRow(db, row.id, { status: "paid", payout_txid: txid, error: null });

    let creditedCents = 0;
    if (!direct && link) {
      const credited = await creditBountyPayout(db, env, {
        bountyId: event.bountyId,
        walletId: link.wallet_id,
        amountSats: net,
        settleTxid: txid,
      });
      creditedCents = credited.amountCents;
    }
    await bountiesInternalJson(
      env,
      `/internal/agentpay/bounties/${encodeURIComponent(event.bountyId)}/txid`,
      { method: "PATCH", body: JSON.stringify({ txid, status: "paid" }) },
    ).catch(() => {});
    return { ok: true, credited: !direct && Boolean(link), amountCents: creditedCents };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateEscrowRow(db, row.id, { status: "payout_pending", error: message });
    return { ok: true, credited: false, reason: `payout_pending: ${message}` };
  }
}

export { listEscrowRows };
