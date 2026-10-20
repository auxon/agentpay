/**
 * x402 v2 facilitator for the BSV `exact` / `p2pkh-rawtx` rail.
 *
 * Spec §7: POST /verify (read-only), POST /settle (broadcast + consume),
 * GET /supported. BSV has no pull-settlement primitive, so the natural flow
 * is `upfront` (settle commits the signed raw transaction). /verify still
 * validates the payload without writing chain state so resource servers that
 * call verify-then-settle (authorization) also work.
 */
import { P2PKH, Transaction } from "@bsv/sdk";
import { broadcastPaymentTx } from "./broadcast";
import { claimX402Txid } from "./ledger";
import { HttpError, type AppEnv } from "./types";
import { nowIso } from "./ids";
import { payerForTx } from "./x402";
import {
  BSV_NETWORK,
  FACILITATOR_WALLET_ID,
  X402_SCHEME,
  X402_VERSION,
  extractLockingScriptHex,
  extractTxHex,
  isAmbiguousBip122,
  isBsvAsset,
  isBsvNetwork,
  isRecord,
  type FacilitatorRequest,
  type PaymentRequirements,
  type SettlementResponse,
  type SupportedKind,
  type VerifyResponse,
} from "./x402-spec";

export function parseFacilitatorRequest(body: unknown): FacilitatorRequest {
  if (!isRecord(body)) throw new HttpError(400, "invalid_payment_requirements");
  const version = Number(body.x402Version ?? X402_VERSION);
  if (version !== X402_VERSION) {
    throw new HttpError(400, "invalid_x402_version", { invalidReason: "invalid_x402_version" });
  }
  if (!isRecord(body.paymentPayload) || !isRecord(body.paymentRequirements)) {
    throw new HttpError(400, "invalid_payload", { invalidReason: "invalid_payload" });
  }
  return {
    x402Version: version,
    paymentPayload: body.paymentPayload,
    paymentRequirements: body.paymentRequirements,
  };
}

function requirementsOf(raw: Record<string, unknown>): PaymentRequirements {
  const extra = isRecord(raw.extra) ? raw.extra : undefined;
  const timeout = Number(raw.maxTimeoutSeconds);
  return {
    scheme: String(raw.scheme ?? ""),
    network: String(raw.network ?? ""),
    amount: String(raw.amount ?? ""),
    asset: String(raw.asset ?? ""),
    payTo: String(raw.payTo ?? ""),
    maxTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 900,
    extra,
  };
}

export function paidSatsToScript(tx: Transaction, lockingScriptHex: string): number {
  const want = lockingScriptHex.toLowerCase();
  return tx.outputs.reduce((sum, o) => {
    const hex = o.lockingScript?.toHex?.().toLowerCase?.() ?? "";
    return hex === want ? sum + (o.satoshis ?? 0) : sum;
  }, 0);
}

export function lockingScriptForPayTo(payTo: string): string | null {
  try {
    return new P2PKH().lock(payTo).toHex().toLowerCase();
  } catch {
    return null;
  }
}

export interface BsvVerifyResult extends VerifyResponse {
  txid?: string;
  tx?: Transaction;
  satoshis?: number;
}

export function verifyBsvPaymentPayload(
  paymentPayload: Record<string, unknown>,
  paymentRequirements: Record<string, unknown>,
): BsvVerifyResult {
  const req = requirementsOf(paymentRequirements);
  if (Number(paymentPayload.x402Version ?? X402_VERSION) !== X402_VERSION) {
    return { isValid: false, invalidReason: "invalid_x402_version" };
  }
  const accepted = isRecord(paymentPayload.accepted) ? paymentPayload.accepted : null;
  const scheme = String(accepted?.scheme ?? paymentPayload.scheme ?? req.scheme);
  if (scheme !== X402_SCHEME) {
    return { isValid: false, invalidReason: "invalid_scheme" };
  }
  const network = String(accepted?.network ?? paymentPayload.network ?? req.network);
  if (isAmbiguousBip122(network) || isAmbiguousBip122(req.network)) {
    return { isValid: false, invalidReason: "invalid_network" };
  }
  if (!isBsvNetwork(network) || network !== BSV_NETWORK || req.network !== BSV_NETWORK) {
    return { isValid: false, invalidReason: "invalid_network" };
  }
  if (!isBsvAsset(req.asset) || (accepted?.asset != null && !isBsvAsset(accepted.asset))) {
    return { isValid: false, invalidReason: "invalid_payment_requirements" };
  }
  const txHex = extractTxHex(paymentPayload);
  if (!txHex) return { isValid: false, invalidReason: "invalid_payload" };
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(txHex);
  } catch {
    return { isValid: false, invalidReason: "invalid_payload" };
  }
  const locking =
    extractLockingScriptHex(req as unknown as Record<string, unknown>, paymentPayload) ??
    (req.payTo ? lockingScriptForPayTo(req.payTo) : null) ??
    (typeof accepted?.payTo === "string" ? lockingScriptForPayTo(accepted.payTo) : null);
  if (!locking) return { isValid: false, invalidReason: "invalid_payment_requirements" };
  const satoshis = paidSatsToScript(tx, locking);
  const needed = Number.parseInt(String(req.amount ?? ""), 10);
  if (!Number.isFinite(needed) || needed <= 0) {
    return { isValid: false, invalidReason: "invalid_payment_requirements" };
  }
  const payer = payerForTx(tx);
  if (satoshis < needed) {
    return { isValid: false, invalidReason: "insufficient_funds", payer, extra: { satoshis, amount: needed } };
  }
  return { isValid: true, payer, txid: tx.id("hex"), tx, satoshis };
}

export async function facilitatorVerify(body: unknown): Promise<VerifyResponse> {
  const req = parseFacilitatorRequest(body);
  const result = verifyBsvPaymentPayload(
    req.paymentPayload as Record<string, unknown>,
    req.paymentRequirements as Record<string, unknown>,
  );
  return {
    isValid: result.isValid,
    ...(result.invalidReason ? { invalidReason: result.invalidReason } : {}),
    ...(result.payer ? { payer: result.payer } : {}),
    ...(result.extra ? { extra: result.extra } : {}),
  };
}

export async function facilitatorSettle(env: AppEnv, body: unknown): Promise<SettlementResponse> {
  const req = parseFacilitatorRequest(body);
  const checked = verifyBsvPaymentPayload(
    req.paymentPayload as Record<string, unknown>,
    req.paymentRequirements as Record<string, unknown>,
  );
  const network = BSV_NETWORK;
  if (!checked.isValid || !checked.tx || !checked.txid) {
    return {
      success: false,
      errorReason: checked.invalidReason ?? "invalid_payload",
      transaction: "",
      network,
      ...(checked.payer ? { payer: checked.payer } : {}),
    };
  }
  const already = env.DB
    ? await env.DB.prepare("SELECT txid FROM ap_x402_payments WHERE txid = ?")
        .bind(checked.txid)
        .first<{ txid: string }>()
    : null;
  if (already) {
    return {
      success: true,
      transaction: checked.txid,
      network,
      payer: checked.payer,
      amount: String(checked.satoshis ?? ""),
      extensions: { status: "already_settled" },
    };
  }
  let broadcastAccepted = false;
  try {
    const result = await broadcastPaymentTx(env, checked.tx);
    broadcastAccepted = result.accepted;
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (/already|known|duplicate/i.test(message) && !/double.?spend|orphan|reject/i.test(message)) {
      broadcastAccepted = true;
    } else if (/double.?spend|orphan|reject/i.test(message)) {
      return {
        success: false,
        errorReason: "invalid_transaction_state",
        transaction: checked.txid,
        network,
        payer: checked.payer,
      };
    } else {
      return {
        success: false,
        errorReason: "unexpected_settle_error",
        transaction: checked.txid,
        network,
        payer: checked.payer,
      };
    }
  }
  if (env.DB) {
    await claimX402Txid(env.DB, {
      txid: checked.txid,
      walletId: FACILITATOR_WALLET_ID,
      service: "x402-facilitator",
      tool: "settle",
    });
  }
  if (!broadcastAccepted) {
    return {
      success: false,
      errorReason: "settlement_pending",
      transaction: checked.txid,
      network,
      payer: checked.payer,
      amount: String(checked.satoshis ?? ""),
    };
  }
  return {
    success: true,
    transaction: checked.txid,
    network,
    payer: checked.payer,
    amount: String(checked.satoshis ?? ""),
    extensions: { status: "mempool" },
  };
}

export function facilitatorSupported(signers: string[] = []): {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
} {
  return {
    kinds: [
      {
        x402Version: X402_VERSION,
        scheme: X402_SCHEME,
        network: BSV_NETWORK,
        extra: { payloadFormat: { kind: "p2pkh-rawtx" }, paymentFlow: "upfront" },
      },
    ],
    extensions: ["bazaar"],
    signers: { "bsv:*": signers },
  };
}

export async function recordInvoice(
  db: D1Database,
  invoiceId: string,
  value: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ap_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(`x402-inv:${invoiceId}`, JSON.stringify(value), nowIso())
    .run();
}

export async function loadInvoice(
  db: D1Database,
  invoiceId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare("SELECT value FROM ap_meta WHERE key = ?")
    .bind(`x402-inv:${invoiceId}`)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
