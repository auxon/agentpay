/**
 * BSV/USD price oracle (Phase D) — CoinGecko with ap_meta cache.
 *
 * - Source: CoinGecko Simple Price (bitcoin-sv vs USD), 8s timeout.
 * - Cache: ap_meta key price:BSV_USD (+updated_at). TTL 1h, stale 2h.
 * - Fresh cache → derived sats/cent. Stale → refresh inline, fall back to
 *   the last cache, then to the operator's configured rate. Never throws.
 * - sats/cent derivation: 1 BSV = 1e8 sats; cents per BSV = usd*100.
 */
import type { AppEnv } from "./types";
import { nowIso } from "./ids";

/** $25/BSV default, matching bsv-bounties' BSV_USD var (mirrors bounties.ts). */
export const PRICE_DEFAULT_SATS_PER_CENT = 40_000;

export const PRICE_META_KEY = "price:BSV_USD";
export const PRICE_TTL_MS = 3_600_000;
export const PRICE_STALE_MS = 7_200_000;
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-sv&vs_currencies=usd";

export function satsPerCentFromUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return PRICE_DEFAULT_SATS_PER_CENT;
  return Math.max(1, Math.round(100_000_000 / (usd * 100)));
}

export async function getCachedBsvUsd(db: D1Database): Promise<{ usd: number; atMs: number } | null> {
  try {
    const row = await db
      .prepare("SELECT value, updated_at FROM ap_meta WHERE key = ?")
      .bind(PRICE_META_KEY)
      .first<{ value: string; updated_at: string }>();
    if (!row) return null;
    const usd = Number(row.value);
    const atMs = Date.parse(row.updated_at);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return { usd, atMs: Number.isFinite(atMs) ? atMs : 0 };
  } catch {
    return null;
  }
}

export async function refreshBsvUsd(env: AppEnv, db: D1Database): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(COINGECKO_URL, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "agentpay-price/1" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = (await res.json()) as { "bitcoin-sv"?: { usd?: number } };
    const usd = Number(body?.["bitcoin-sv"]?.usd);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    await db
      .prepare(
        "INSERT INTO ap_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(PRICE_META_KEY, String(usd), nowIso())
      .run()
      .catch(() => {});
    return usd;
  } catch {
    return null;
  }
}

/**
 * Resolve sats-per-cent: fresh oracle cache wins, else refresh inline, else
 * operator-configured rate. Returns {perCent, source} for audit trails.
 */
export async function resolveSatsPerCent(
  env: AppEnv,
  db: D1Database,
  fallback: number,
): Promise<{ perCent: number; source: "oracle" | "oracle-refresh" | "configured" }> {
  const cached = await getCachedBsvUsd(db);
  const now = Date.now();
  if (cached && now - cached.atMs < PRICE_TTL_MS) {
    return { perCent: satsPerCentFromUsd(cached.usd), source: "oracle" };
  }
  const refreshed = await refreshBsvUsd(env, db);
  if (refreshed !== null) return { perCent: satsPerCentFromUsd(refreshed), source: "oracle-refresh" };
  if (cached) return { perCent: satsPerCentFromUsd(cached.usd), source: "oracle" };
  return { perCent: fallback, source: "configured" };
}
