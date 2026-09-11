/**
 * Trial faucet (Phase F) — self-serve $0 onboarding for agents.
 *
 * POST /trial mints a real wallet pre-funded with TRIAL_CENTS (default 25¢)
 * plus a tight agent key, so an agent can make its first paid x402 calls
 * with zero human steps. Abuse controls:
 * - Operator kill switch: TRIAL_ENABLED must be "1".
 * - One claim per IP per UTC day (UNIQUE(ip_hash, day) — races fail closed).
 * - Operator total budget: TRIAL_TOTAL_CAP_CENTS (default $10), best-effort.
 * - Trial wallets hold exactly TRIAL_CENTS; the agent daily limit equals it.
 * - Every issuance is a ledger `topup` (ref trial:<walletId>) + ap_meta total.
 */
import { HttpError, type AppEnv } from "./types";
import { cleanStr, nowIso } from "./ids";
import { createAgent, createWallet, creditTopup } from "./ledger";

export const TRIAL_DEFAULT_CENTS = 25;
export const TRIAL_DEFAULT_TOTAL_CAP_CENTS = 1000;

export function trialEnabled(env: AppEnv): boolean {
  return (env as unknown as Record<string, unknown>).TRIAL_ENABLED === "1";
}

export function trialCents(env: AppEnv): number {
  const n = Number((env as unknown as Record<string, unknown>).TRIAL_CENTS);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : TRIAL_DEFAULT_CENTS;
}

export function trialTotalCapCents(env: AppEnv): number {
  const n = Number((env as unknown as Record<string, unknown>).TRIAL_TOTAL_CAP_CENTS);
  return Number.isInteger(n) && n >= 0 ? n : TRIAL_DEFAULT_TOTAL_CAP_CENTS;
}

export async function ipHash(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`trial:${ip.trim()}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function trialIssuedTotal(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM ap_meta WHERE key = 'trial_issued_total_cents'")
    .first<{ value: string }>()
    .catch(() => null);
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface TrialClaim {
  walletId: string;
  token: string;
  recoveryCode: string;
  agentName: string;
  key: string;
  amountCents: number;
}

export async function claimTrial(
  db: D1Database,
  env: AppEnv,
  clientIp: string,
  name?: unknown,
): Promise<TrialClaim> {
  if (!trialEnabled(env)) throw new HttpError(403, "Trial faucet is disabled");
  const ip = cleanStr(clientIp, 80) || "anon";
  const amountCents = trialCents(env);
  const day = utcDay();

  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS ap_trial_claims (ip_hash TEXT NOT NULL, day TEXT NOT NULL, wallet_id TEXT NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (ip_hash, day))",
    )
    .run()
    .catch(() => {});

  const total = await trialIssuedTotal(db);
  if (total + amountCents > trialTotalCapCents(env)) {
    throw new HttpError(429, "Trial budget exhausted — fund a wallet in the dashboard instead");
  }

  // Claim the daily slot first: concurrent double-claims fail closed here.
  const hash = await ipHash(ip);
  const slot = await db
    .prepare(
      "INSERT OR IGNORE INTO ap_trial_claims (ip_hash, day, wallet_id, amount_cents, created_at) VALUES (?, ?, '', ?, ?)",
    )
    .bind(hash, day, amountCents, nowIso())
    .run()
    .catch(() => null);
  if (!slot || (slot.meta?.changes ?? 0) === 0) {
    throw new HttpError(429, "One trial per IP per day — try again tomorrow or fund a wallet in the dashboard");
  }

  const { wallet, token, recoveryCode } = await createWallet(db, {
    name: cleanStr(name, 60) || "Trial wallet",
  });
  const agentName = "trial-agent";
  const { key } = await createAgent(db, wallet.id, { name: agentName, dailyLimitCents: amountCents });
  await creditTopup(db, {
    walletId: wallet.id,
    amountCents,
    ref: `trial:${wallet.id}`,
    meta: { type: "trial", ipHash: hash },
  });
  await db
    .prepare("UPDATE ap_trial_claims SET wallet_id = ? WHERE ip_hash = ? AND day = ?")
    .bind(wallet.id, hash, day)
    .run()
    .catch(() => {});
  await db
    .prepare(
      "INSERT INTO ap_meta (key, value, updated_at) VALUES ('trial_issued_total_cents', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(String(total + amountCents), nowIso())
    .run()
    .catch(() => {});
  return { walletId: wallet.id, token, recoveryCode, agentName, key, amountCents };
}

export function trialResponse(claim: TrialClaim, origin: string) {
  return {
    ...claim,
    keyPrefix: claim.key.slice(0, 8),
    connect: `${origin}/api/agentpay/connect?key=${encodeURIComponent(claim.key)}`,
    starter: `${origin}/api/agentpay/start`,
    limits: { dailyLimitCents: claim.amountCents, perIpPerDay: 1 },
    note: "One trial per IP per day from a limited operator budget. When it's spent, fund the wallet in the dashboard — same wallet, same key.",
  };
}
