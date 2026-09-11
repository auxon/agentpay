/**
 * Two credential types:
 *   apw_…  wallet (owner) token — minted once at wallet creation, shown once.
 *   agp_…  agent key — scoped to one wallet, optional daily limit, revocable.
 *
 * Only SHA-256 hashes are stored; the raw values never appear in the DB or logs.
 */
import { HttpError, type AgentRow, type WalletRow } from "./types";
import { randomHex, sha256Hex } from "./ids";

export const WALLET_TOKEN_PREFIX = "apw_";
export const AGENT_KEY_PREFIX = "agp_";
export const RECOVERY_CODE_PREFIX = "apr_";

export function mintWalletToken(): string {
  return `${WALLET_TOKEN_PREFIX}${randomHex(32)}`;
}

export function mintAgentKey(): string {
  return `${AGENT_KEY_PREFIX}${randomHex(24)}`;
}

export function mintRecoveryCode(): string {
  return `${RECOVERY_CODE_PREFIX}${randomHex(24)}`;
}

export function keyPrefix(key: string, length = 12): string {
  return key.slice(0, length);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export async function requireWallet(request: Request, db: D1Database): Promise<WalletRow> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Missing wallet token (Authorization: Bearer apw_…)");
  if (!token.startsWith(WALLET_TOKEN_PREFIX)) throw new HttpError(401, "That is not a wallet token");
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT * FROM ap_wallets WHERE token_hash = ? AND status = 'active'")
    .bind(hash)
    .first<WalletRow>();
  if (!row) throw new HttpError(401, "Unknown or revoked wallet token");
  return row;
}

export async function requireAgent(
  request: Request,
  db: D1Database,
): Promise<{ agent: AgentRow; wallet: WalletRow }> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Missing agent key (Authorization: Bearer agp_…)");
  if (!token.startsWith(AGENT_KEY_PREFIX)) throw new HttpError(401, "That is not an agent key");
  const hash = await sha256Hex(token);
  const agent = await db
    .prepare(
      `SELECT a.*, s.parent_agent_id, s.budget_cents AS sub_budget_cents,
              s.spent_cents AS sub_spent_cents, s.expires_at AS sub_expires_at
       FROM ap_agents a LEFT JOIN ap_subagent_budgets s ON s.agent_id = a.id
       WHERE a.key_hash = ? AND a.active = 1`,
    )
    .bind(hash)
    .first<AgentRow>();
  if (!agent) throw new HttpError(401, "Unknown or revoked agent key");
  if (agent.sub_expires_at && agent.sub_expires_at <= new Date().toISOString()) {
    throw new HttpError(401, "Sub-agent key expired — ask the parent agent for a new one", {
      code: "subagent_expired",
      expiresAt: agent.sub_expires_at,
    });
  }
  if (
    agent.sub_budget_cents !== null &&
    agent.sub_budget_cents !== undefined &&
    (agent.sub_spent_cents ?? 0) >= agent.sub_budget_cents
  ) {
    throw new HttpError(402, "Sub-agent budget exhausted — ask the parent agent for a new one", {
      code: "subagent_budget",
      budgetCents: agent.sub_budget_cents,
      spentCents: agent.sub_spent_cents ?? 0,
    });
  }
  const wallet = await db
    .prepare("SELECT * FROM ap_wallets WHERE id = ? AND status = 'active'")
    .bind(agent.wallet_id)
    .first<WalletRow>();
  if (!wallet) throw new HttpError(401, "Wallet is inactive");
  return { agent, wallet };
}
