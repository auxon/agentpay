/**
 * Two-way trust read — agentpay side (work -> spend).
 * Read-only: fetches BSVBounties reputation via service binding and
 * computes an approval fast-path (x2 threshold). Never raises daily
 * limits, never touches escrow. Fail closed on any fetch/parse error.
 */
import type { AppEnv } from "./types";
import { BOUNTIES_API_PREFIX } from "./bounties";

export const TRUST_REPUTATION_MIN_SCORE = 650;
export const TRUST_APPROVAL_MULTIPLIER = 2;

export type TrustGateMode = "off" | "log" | "enforce";

export function trustPayMode(env: AppEnv): TrustGateMode {
  const v = (env as unknown as Record<string, unknown>).TRUST_GATE_PAY;
  if (v === "enforce") return "enforce";
  if (v === "off") return "off";
  return "log"; // 3-day log-only default per CEO #3
}

export interface ReputationLite {
  score: number;
  provisional: boolean;
  slashes: number;
  tier?: string;
  verified?: boolean;
}

export interface PayTrustDecision {
  fastPath: boolean;
  reason: string;
  reputation: ReputationLite | null;
  effectiveMultiplier: number;
}

export function decidePayTrust(rep: ReputationLite | null): PayTrustDecision {
  if (!rep || typeof rep.score !== "number") {
    return { fastPath: false, reason: "no_reputation", reputation: rep, effectiveMultiplier: 1 };
  }
  if (rep.provisional) return { fastPath: false, reason: "provisional", reputation: rep, effectiveMultiplier: 1 };
  if ((rep.slashes ?? 0) > 0) return { fastPath: false, reason: "has_slashes", reputation: rep, effectiveMultiplier: 1 };
  if (rep.score < TRUST_REPUTATION_MIN_SCORE) {
    return { fastPath: false, reason: "score_too_low", reputation: rep, effectiveMultiplier: 1 };
  }
  return { fastPath: true, reason: "trusted_worker", reputation: rep, effectiveMultiplier: TRUST_APPROVAL_MULTIPLIER };
}

export function applyTrustMultiplier(base: number | null, d: PayTrustDecision): number | null {
  if (base === null || !d.fastPath) return base;
  return base * d.effectiveMultiplier;
}

const repCache = new Map<string, { at: number; rep: ReputationLite | null }>();
const REP_TTL_MS = 5 * 60_000;

function baseUrl(env: AppEnv): string {
  return (env.BOUNTIES_API_URL || "https://bsv-bounties.richard-hein.workers.dev").replace(/\/$/, "");
}

/**
 * Fetch reputation for a bounty account number.
 * Uses BOUNTIES service binding first (bypasses same-zone routing),
 * falls back to BOUNTIES_API_URL workers.dev. Cached 5 min.
 */
export async function fetchReputation(
  env: AppEnv,
  accountNumber: number | null | undefined,
): Promise<ReputationLite | null> {
  if (!accountNumber || !Number.isFinite(accountNumber)) return null;
  const key = String(accountNumber);
  const hit = repCache.get(key);
  if (hit && Date.now() - hit.at < REP_TTL_MS) return hit.rep;
  try {
    let res: Response;
    const path = `${BOUNTIES_API_PREFIX}/accounts/${accountNumber}`;
    if (env.BOUNTIES) {
      res = await env.BOUNTIES.fetch(new Request(`https://bsv-bounties.internal${path}`));
    } else {
      res = await fetch(`${baseUrl(env)}${path}`);
    }
    if (!res.ok) {
      repCache.set(key, { at: Date.now(), rep: null });
      return null;
    }
    const body = (await res.json()) as Record<string, unknown>;
    const rep = (body.reputation ?? body) as Record<string, unknown>;
    if (typeof rep.score !== "number") {
      repCache.set(key, { at: Date.now(), rep: null });
      return null;
    }
    const out: ReputationLite = {
      score: Number(rep.score),
      provisional: Boolean(rep.provisional),
      slashes: Number(rep.slashes ?? 0),
      tier: typeof rep.tier === "string" ? rep.tier : undefined,
      verified: typeof rep.verified === "boolean" ? rep.verified : undefined,
    };
    repCache.set(key, { at: Date.now(), rep: out });
    return out;
  } catch {
    return null;
  }
}

/** Resolve the worker's bounty account from the wallet's most recent link. */
export async function linkedBountyAccount(db: D1Database, walletId: string): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT worker_ref FROM ap_bounty_links WHERE wallet_id = ? ORDER BY updated_at DESC LIMIT 1")
      .bind(walletId)
      .first<{ worker_ref: string }>();
    if (!row?.worker_ref) return null;
    // worker_ref for agentpay links is `agentpay:<walletId>`; the numeric
    // account (if known) is stored via claim metadata — try to parse a
    // trailing #N hint, else fall back to null (no gating, fail closed).
    const m = /#(\d+)\b/.exec(row.worker_ref);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
