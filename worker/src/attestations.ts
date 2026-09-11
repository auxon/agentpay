/**
 * Proof-of-spend attestations.
 *
 * A wallet can ask agentpay to sign a summary of its settled activity. The
 * signature is ECDSA P-256 / SHA-256 over the canonical JSON (sorted keys,
 * IEEE P1363 raw signature, base64url). Sellers verify with the published
 * public key — offline or via `/attestations/verify` — and can price trust
 * instead of guessing. The signing key lives in the `ATTESTATION_KEY_JWK`
 * secret; nothing is signed when it is unset.
 */
import { HttpError, type AppEnv } from "./types";
import { nowIso } from "./ids";
import { sinceBounds } from "./reports";

export const ATTESTATION_VERSION = 1;
export const ATTESTATION_ISSUER = "agentpay.entangleit.com";
export const ATTESTATION_DAYS_DEFAULT = 30;
export const ATTESTATION_DAYS_MAX = 365;

export interface AttestationMetrics {
  settledPayments: number;
  distinctServices: number;
  /** Distinct on-chain payees (anti-wash; 0 when unsettled off-chain). */
  distinctPayTo: number;
  spentCents: number;
  refundedCents: number;
  /** Bounty payouts credited to this wallet in the window. */
  bountyPayouts: number;
  /** USD cents earned from those payouts. */
  earnedCents: number;
  firstPaymentAt: string | null;
  lastPaymentAt: string | null;
}

export interface Attestation {
  v: number;
  iss: string;
  wallet: string;
  /** Optional claimant binding (workerPubKey or account ref). Verified by bounties. */
  sub?: string;
  windowDays: number;
  issuedAt: string;
  expiresAt: string;
  metrics: AttestationMetrics;
}

interface SigningKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  keyId: string;
}

let cache: { source: string; key: SigningKey | null } | null = null;

/** Deterministic JSON: object keys sorted, arrays in order. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** RFC 7638-style thumbprint over the required public JWK members. */
export async function signingKeyId(publicJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** Parse ATTESTATION_KEY_JWK (private JWK JSON) into a signing key. Cached. */
export async function loadSigningKey(env: AppEnv): Promise<SigningKey | null> {
  const source = env.ATTESTATION_KEY_JWK;
  if (!source) return null;
  if (cache && cache.source === source) return cache.key;
  try {
    const jwk = JSON.parse(source) as JsonWebKey;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) {
      cache = { source, key: null };
      return null;
    }
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    // Public JWK must carry only the public members: the private JWK's
    // key_ops/ext would otherwise poison verify-side imports.
    const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const key: SigningKey = { privateKey, publicJwk, keyId: await signingKeyId(publicJwk) };
    cache = { source, key };
    return key;
  } catch {
    cache = { source, key: null };
    return null;
  }
}

export async function attestationPublicKey(
  env: AppEnv,
): Promise<{ alg: string; keyId: string; publicJwk: JsonWebKey } | null> {
  const key = await loadSigningKey(env);
  if (!key) return null;
  return { alg: "ES256", keyId: key.keyId, publicJwk: key.publicJwk };
}

export async function signAttestation(
  env: AppEnv,
  attestation: Attestation,
): Promise<{ signature: string; keyId: string; alg: string } | null> {
  const key = await loadSigningKey(env);
  if (!key) return null;
  const bytes = new TextEncoder().encode(stableStringify(attestation));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, bytes);
  return { signature: toBase64Url(new Uint8Array(sig)), keyId: key.keyId, alg: "ES256" };
}

export async function verifyAttestation(
  publicJwk: JsonWebKey,
  attestation: Attestation,
  signature: string,
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const sig = fromBase64Url(signature);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sig,
      new TextEncoder().encode(stableStringify(attestation)),
    );
  } catch {
    return false;
  }
}

export function clampAttestationDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return ATTESTATION_DAYS_DEFAULT;
  return Math.min(ATTESTATION_DAYS_MAX, Math.max(1, Math.round(n)));
}

/**
 * Build the unsigned attestation from receipts + refunds. Returns null when the
 * wallet has no settled payments in the window (nothing to attest).
 */
export async function buildAttestation(
  db: D1Database,
  walletId: string,
  days: number,
  opts: { sub?: string } = {},
): Promise<Attestation | null> {
  const since = sinceBounds(days);
  const window = await db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT NULLIF(service, '')) AS services,
              SUM(amount_cents) AS cents, MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM ap_receipts WHERE wallet_id = ? AND (created_at >= ? OR created_at >= ?)`,
    )
    .bind(walletId, since.iso, since.sql)
    .first<{ n: number; services: number; cents: number | null; first_at: string | null; last_at: string | null }>();
  const settledPayments = Number(window?.n ?? 0);

  const earned = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
       FROM ap_ledger
       WHERE wallet_id = ? AND kind = 'adjust'
         AND json_extract(meta_json, '$.type') = 'bounty_payout'
         AND (created_at >= ? OR created_at >= ?)`,
    )
    .bind(walletId, since.iso, since.sql)
    .first<{ n: number; cents: number }>();
  const bountyPayouts = Number(earned?.n ?? 0);

  if (settledPayments <= 0 && bountyPayouts <= 0) return null;

  const refunds = await db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM ap_ledger WHERE wallet_id = ? AND kind = 'refund' AND (created_at >= ? OR created_at >= ?)",
    )
    .bind(walletId, since.iso, since.sql)
    .first<{ cents: number }>();

  const firstEver = await db
    .prepare("SELECT MIN(created_at) AS at FROM ap_receipts WHERE wallet_id = ?")
    .bind(walletId)
    .first<{ at: string | null }>();

  const payees = await db
    .prepare(
      `SELECT COUNT(DISTINCT json_extract(meta_json, '$.payTo')) AS n FROM ap_ledger
       WHERE wallet_id = ? AND kind = 'debit'
         AND json_extract(meta_json, '$.payTo') IS NOT NULL
         AND (created_at >= ? OR created_at >= ?)`,
    )
    .bind(walletId, since.iso, since.sql)
    .first<{ n: number }>();

  const issuedAt = nowIso();
  return {
    v: ATTESTATION_VERSION,
    iss: ATTESTATION_ISSUER,
    wallet: walletId,
    ...(opts.sub ? { sub: opts.sub } : {}),
    windowDays: days,
    issuedAt,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    metrics: {
      settledPayments,
      distinctServices: Number(window?.services ?? 0),
      distinctPayTo: Number(payees?.n ?? 0),
      spentCents: Math.abs(Number(window?.cents ?? 0)),
      refundedCents: Math.abs(Number(refunds?.cents ?? 0)),
      bountyPayouts,
      earnedCents: Math.abs(Number(earned?.cents ?? 0)),
      firstPaymentAt: firstEver?.at ?? window?.first_at ?? null,
      lastPaymentAt: window?.last_at ?? null,
    },
  };
}

/** Shape returned to callers: the signed offer plus verification instructions. */
export function signedAttestationResponse(
  attestation: Attestation,
  signed: { signature: string; keyId: string; alg: string },
  origin: string,
) {
  return {
    attestation,
    signature: signed.signature,
    alg: signed.alg,
    keyId: signed.keyId,
    verify: {
      endpoint: `${origin}/attestations/verify`,
      publicKey: `${origin}/attestations/key`,
      note: "Verify ECDSA P-256 / SHA-256 over the canonical JSON (sorted keys) of `attestation`, signature is base64url (raw P1363).",
    },
  };
}

export function assertSigningConfigured(): never {
  throw new HttpError(503, "Attestation signing is not configured — set the ATTESTATION_KEY_JWK secret");
}
