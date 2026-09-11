/**
 * Money core. All amounts are integer USD cents.
 *
 * Invariants:
 *   1. A wallet can never go negative — the debit is a single guarded UPDATE
 *      (`WHERE balance_cents >= ?`) and only proceeds when `changes === 1`.
 *   2. Every balance change writes exactly one ap_ledger event row carrying
 *      `balance_after_cents`.
 *   3. Top-ups are idempotent by external ref (Stripe session id) via
 *      ap_topup_refs, so webhook + claim cannot double-credit.
 *   4. Per-agent daily limits are enforced in the same guarded UPDATE that
 *      records the spend; a failed wallet debit compensates the agent counter.
 */
import { HttpError, type AgentPolicyRow, type AgentRow, type ApprovalRow, type LedgerRow, type PlanState, type ReceiptRow, type SubagentRow, type WalletRow } from "./types";
import { cleanStr, formatCents, newId, nowIso, sha256Hex, timingSafeEqualStr, utcDay } from "./ids";
import { mintAgentKey, mintRecoveryCode, mintWalletToken, keyPrefix, RECOVERY_CODE_PREFIX } from "./auth";
import { PLANS, getPlanState, planLimitError } from "./plans";

export const MAX_SPEND_CENTS = 1_000_000; // $10,000 per single call
export const MAX_AGENT_LIMIT_CENTS = 1_000_000;
export const WALLET_NAME_MAX = 60;
export const AGENT_NAME_MAX = 60;
export const DESCRIPTION_MAX = 200;

export function isValidSpendAmount(cents: unknown): cents is number {
  return Number.isInteger(cents) && (cents as number) >= 1 && (cents as number) <= MAX_SPEND_CENTS;
}

export function isValidDailyLimit(cents: unknown): boolean {
  return cents === null || (Number.isInteger(cents) && (cents as number) >= 1 && (cents as number) <= MAX_AGENT_LIMIT_CENTS);
}

export async function createWallet(
  db: D1Database,
  input: { name?: unknown; email?: unknown },
): Promise<{ wallet: WalletRow; token: string; recoveryCode: string }> {
  const id = newId("apw");
  const token = mintWalletToken();
  const recoveryCode = mintRecoveryCode();
  const name = cleanStr(input.name, WALLET_NAME_MAX) || "My agent wallet";
  const email = cleanStr(input.email, 160);
  const t = nowIso();
  await db
    .prepare(
      "INSERT INTO ap_wallets (id, name, email, token_hash, balance_cents, lifetime_topup_cents, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 'active', ?, ?)",
    )
    .bind(id, name, email, await sha256Hex(token), t, t)
    .run();
  await db
    .prepare("INSERT INTO ap_recovery (wallet_id, code_hash, created_at) VALUES (?, ?, ?)")
    .bind(id, await sha256Hex(recoveryCode), t)
    .run();
  const wallet = await db.prepare("SELECT * FROM ap_wallets WHERE id = ?").bind(id).first<WalletRow>();
  if (!wallet) throw new HttpError(500, "Wallet insert failed");
  return { wallet, token, recoveryCode };
}

/**
 * Reset the wallet token using the offline recovery code. The old token stops
 * working immediately; the recovery code stays valid for future recoveries.
 */
export async function recoverWallet(
  db: D1Database,
  input: { walletId: string; recoveryCode: string },
): Promise<{ token: string; wallet: WalletRow } | null> {
  const walletId = input.walletId.trim();
  const code = input.recoveryCode.trim();
  if (!walletId || !code.startsWith(RECOVERY_CODE_PREFIX)) return null;
  const row = await db
    .prepare("SELECT code_hash FROM ap_recovery WHERE wallet_id = ?")
    .bind(walletId)
    .first<{ code_hash: string }>();
  if (!row) return null;
  if (!timingSafeEqualStr(await sha256Hex(code), row.code_hash)) return null;
  const token = mintWalletToken();
  await db
    .prepare("UPDATE ap_wallets SET token_hash = ?, updated_at = ? WHERE id = ?")
    .bind(await sha256Hex(token), nowIso(), walletId)
    .run();
  await db
    .prepare("UPDATE ap_recovery SET last_used_at = ? WHERE wallet_id = ?")
    .bind(nowIso(), walletId)
    .run();
  const wallet = await db.prepare("SELECT * FROM ap_wallets WHERE id = ?").bind(walletId).first<WalletRow>();
  if (!wallet) return null;
  return { token, wallet };
}

export async function listAgents(db: D1Database, walletId: string): Promise<AgentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, s.parent_agent_id, s.budget_cents AS sub_budget_cents,
              s.spent_cents AS sub_spent_cents, s.expires_at AS sub_expires_at
       FROM ap_agents a LEFT JOIN ap_subagent_budgets s ON s.agent_id = a.id
       WHERE a.wallet_id = ? ORDER BY a.created_at DESC`,
    )
    .bind(walletId)
    .all<AgentRow>();
  return results ?? [];
}

export async function createAgent(
  db: D1Database,
  walletId: string,
  input: { name?: unknown; dailyLimitCents?: unknown },
  planArg?: PlanState,
): Promise<{ agent: AgentRow; key: string }> {
  // Entitlements are always resolved server-side; callers may pass an
  // already-fetched plan to avoid a second read.
  const plan = planArg ?? (await getPlanState(db, walletId));
  const name = cleanStr(input.name, AGENT_NAME_MAX);
  if (!name) throw new HttpError(400, "Agent name is required");
  const limit =
    input.dailyLimitCents === null || input.dailyLimitCents === undefined || input.dailyLimitCents === ""
      ? null
      : Number(input.dailyLimitCents);
  if (!isValidDailyLimit(limit)) {
    throw new HttpError(400, `dailyLimitCents must be 1..${MAX_AGENT_LIMIT_CENTS} or null`);
  }
  if (limit !== null && limit > plan.limits.maxDailyLimitCents) {
    throw planLimitError(
      `${plan.id} plan allows daily limits up to ${formatCents(plan.limits.maxDailyLimitCents)} per agent — upgrade to Pro for ${formatCents(PLANS.pro.limits.maxDailyLimitCents)}.`,
      { plan: plan.id, maxDailyLimitCents: plan.limits.maxDailyLimitCents, requestedDailyLimitCents: limit },
    );
  }
  const active = await db
    .prepare("SELECT COUNT(*) AS n FROM ap_agents WHERE wallet_id = ? AND active = 1")
    .bind(walletId)
    .first<{ n: number }>();
  const activeAgents = Number(active?.n ?? 0);
  if (activeAgents >= plan.limits.maxAgents) {
    throw planLimitError(
      `${plan.id} plan allows ${plan.limits.maxAgents} active agent keys — upgrade to Pro for ${PLANS.pro.limits.maxAgents}.`,
      { plan: plan.id, maxAgents: plan.limits.maxAgents, activeAgents },
    );
  }
  const key = mintAgentKey();
  const id = newId("aga");
  await db
    .prepare(
      "INSERT INTO ap_agents (id, wallet_id, name, key_hash, key_prefix, daily_limit_cents, spent_day, spent_today_cents, active, created_at) VALUES (?, ?, ?, ?, ?, ?, '', 0, 1, ?)",
    )
    .bind(id, walletId, name, await sha256Hex(key), keyPrefix(key), limit, nowIso())
    .run();
  const agent = await db.prepare("SELECT * FROM ap_agents WHERE id = ?").bind(id).first<AgentRow>();
  if (!agent) throw new HttpError(500, "Agent insert failed");
  return { agent, key };
}

export async function revokeAgent(db: D1Database, walletId: string, agentId: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE ap_agents SET active = 0 WHERE id = ? AND wallet_id = ?")
    .bind(agentId, walletId)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) return false;
  // Safety: revoking a parent revokes every sub-agent it minted.
  await db
    .prepare(
      "UPDATE ap_agents SET active = 0 WHERE id IN (SELECT agent_id FROM ap_subagent_budgets WHERE parent_agent_id = ?) AND wallet_id = ?",
    )
    .bind(agentId, walletId)
    .run();
  return true;
}

// ---------- sub-agents (delegation) ----------

export const MAX_SUBAGENT_BUDGET_CENTS = 1_000_000; // $10,000 lifetime budget
export const MAX_SUBAGENT_TTL_MINUTES = 60 * 24 * 30; // 30 days

export function isValidBudgetCents(cents: unknown): cents is number | null {
  return (
    cents === null ||
    cents === undefined ||
    (Number.isInteger(cents) && (cents as number) >= 1 && (cents as number) <= MAX_SUBAGENT_BUDGET_CENTS)
  );
}

export async function getSubagent(db: D1Database, agentId: string): Promise<SubagentRow | null> {
  return db
    .prepare("SELECT * FROM ap_subagent_budgets WHERE agent_id = ?")
    .bind(agentId)
    .first<SubagentRow>();
}

/** Load one agent (with sub-agent fields) scoped to a wallet. */
export async function getAgentForWallet(
  db: D1Database,
  walletId: string,
  agentId: string,
): Promise<AgentRow | null> {
  return db
    .prepare(
      `SELECT a.*, s.parent_agent_id, s.budget_cents AS sub_budget_cents,
              s.spent_cents AS sub_spent_cents, s.expires_at AS sub_expires_at
       FROM ap_agents a LEFT JOIN ap_subagent_budgets s ON s.agent_id = a.id
       WHERE a.id = ? AND a.wallet_id = ?`,
    )
    .bind(agentId, walletId)
    .first<AgentRow>();
}

export async function listSubagents(db: D1Database, parentAgentId: string): Promise<AgentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, s.parent_agent_id, s.budget_cents AS sub_budget_cents,
              s.spent_cents AS sub_spent_cents, s.expires_at AS sub_expires_at
       FROM ap_subagent_budgets s JOIN ap_agents a ON a.id = s.agent_id
       WHERE s.parent_agent_id = ? ORDER BY s.created_at DESC`,
    )
    .bind(parentAgentId)
    .all<AgentRow>();
  return results ?? [];
}

/**
 * Mint a delegated child key. Only top-level agents can delegate (no nesting);
 * the plan's agent cap still applies, and the child inherits nothing except the
 * wallet — its scope is its own budget, expiry, daily limit and allowlist.
 */
export async function createSubagent(
  db: D1Database,
  parent: AgentRow,
  input: {
    name?: unknown;
    budgetCents?: unknown;
    dailyLimitCents?: unknown;
    expiresInMinutes?: unknown;
    allowedTools?: unknown;
    approvalAboveCents?: unknown;
  },
): Promise<{ agent: AgentRow; key: string; subagent: SubagentRow }> {
  if (parent.parent_agent_id) {
    throw new HttpError(403, "Sub-agents cannot mint sub-agents — ask the parent agent");
  }
  const name = cleanStr(input.name, AGENT_NAME_MAX);
  if (!name) throw new HttpError(400, "Sub-agent name is required");

  const budget =
    input.budgetCents === null || input.budgetCents === undefined || input.budgetCents === ""
      ? null
      : Number(input.budgetCents);
  if (!isValidBudgetCents(budget)) {
    throw new HttpError(400, `budgetCents must be 1..${MAX_SUBAGENT_BUDGET_CENTS} or null`);
  }

  let expiresAt: string | null = null;
  if (input.expiresInMinutes !== null && input.expiresInMinutes !== undefined && input.expiresInMinutes !== "") {
    const minutes = Number(input.expiresInMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SUBAGENT_TTL_MINUTES) {
      throw new HttpError(400, `expiresInMinutes must be 1..${MAX_SUBAGENT_TTL_MINUTES} or null`);
    }
    expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  }

  // createAgent enforces the plan cap and the per-agent daily-limit ceiling.
  const { agent, key } = await createAgent(db, parent.wallet_id, {
    name,
    dailyLimitCents: input.dailyLimitCents,
  });
  await db
    .prepare(
      "INSERT INTO ap_subagent_budgets (agent_id, parent_agent_id, budget_cents, spent_cents, expires_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(agent.id, parent.id, budget, expiresAt, nowIso(), nowIso())
    .run();
  if (input.allowedTools !== undefined || input.approvalAboveCents !== undefined) {
    await setAgentPolicy(db, parent.wallet_id, agent.id, {
      allowedTools: input.allowedTools,
      approvalAboveCents: input.approvalAboveCents,
    });
  }
  const subagent = await getSubagent(db, agent.id);
  const fresh = await db
    .prepare(
      `SELECT a.*, s.parent_agent_id, s.budget_cents AS sub_budget_cents,
              s.spent_cents AS sub_spent_cents, s.expires_at AS sub_expires_at
       FROM ap_agents a JOIN ap_subagent_budgets s ON s.agent_id = a.id WHERE a.id = ?`,
    )
    .bind(agent.id)
    .first<AgentRow>();
  return { agent: fresh ?? agent, key, subagent: subagent! };
}

/** Mint a fresh key for an agent and invalidate the old one immediately. */
export async function rotateAgentKey(
  db: D1Database,
  walletId: string,
  agentId: string,
): Promise<{ agent: AgentRow; key: string } | null> {
  const key = mintAgentKey();
  const res = await db
    .prepare("UPDATE ap_agents SET key_hash = ?, key_prefix = ?, active = 1 WHERE id = ? AND wallet_id = ?")
    .bind(await sha256Hex(key), keyPrefix(key), agentId, walletId)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) return null;
  const agent = await db.prepare("SELECT * FROM ap_agents WHERE id = ?").bind(agentId).first<AgentRow>();
  return agent ? { agent, key } : null;
}

// ---------- per-agent policy ----------

export const MAX_APPROVAL_THRESHOLD_CENTS = 1_000_000;
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

function sanitizeTools(list: unknown[]): string[] {
  return list
    .map((v) => cleanStr(v, 120))
    .filter(Boolean)
    .slice(0, 100);
}

/** Accepts a JSON array (stored form), a comma-separated string, or an array. */
export function parseAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) return sanitizeTools(value);
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return sanitizeTools(parsed);
    } catch {
      /* fall through to comma parsing */
    }
  }
  return sanitizeTools(raw.split(",").map((s) => s.trim()));
}

export function agentToolAllowed(allowed: string[], serviceId: string, toolName: string): boolean {
  if (allowed.length === 0) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(`${serviceId}:${toolName}`) || allowed.includes(`${serviceId}:*`);
}

export function agentSpendAllowed(allowed: string[]): boolean {
  return allowed.length === 0 || allowed.includes("*") || allowed.includes("spend");
}

export async function getAgentPolicy(db: D1Database, agentId: string): Promise<AgentPolicyRow> {
  const row = await db
    .prepare("SELECT * FROM ap_agent_policies WHERE agent_id = ?")
    .bind(agentId)
    .first<AgentPolicyRow>();
  return row ?? { agent_id: agentId, approval_above_cents: null, allowed_tools_json: "[]", updated_at: "" };
}

/** Merge-update a policy. `undefined` keeps the current value. */
export async function setAgentPolicy(
  db: D1Database,
  walletId: string,
  agentId: string,
  input: { approvalAboveCents?: unknown; allowedTools?: unknown },
): Promise<AgentPolicyRow> {
  const agent = await db.prepare("SELECT id FROM ap_agents WHERE id = ? AND wallet_id = ?").bind(agentId, walletId).first();
  if (!agent) throw new HttpError(404, "Agent not found");
  const current = await getAgentPolicy(db, agentId);

  let threshold = current.approval_above_cents;
  if (input.approvalAboveCents !== undefined) {
    const raw = input.approvalAboveCents;
    threshold =
      raw === null || raw === "" ? null : Number(raw);
    if (threshold !== null && (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_APPROVAL_THRESHOLD_CENTS)) {
      throw new HttpError(400, `approvalAboveCents must be 1..${MAX_APPROVAL_THRESHOLD_CENTS} or null`);
    }
  }
  const tools = input.allowedTools === undefined ? parseAllowedTools(current.allowed_tools_json) : parseAllowedTools(input.allowedTools);

  await db
    .prepare(
      "INSERT INTO ap_agent_policies (agent_id, approval_above_cents, allowed_tools_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET approval_above_cents = excluded.approval_above_cents, allowed_tools_json = excluded.allowed_tools_json, updated_at = excluded.updated_at",
    )
    .bind(agentId, threshold, JSON.stringify(tools), nowIso())
    .run();
  return getAgentPolicy(db, agentId);
}

// ---------- purchase approvals ----------

export async function getApproval(db: D1Database, id: string): Promise<ApprovalRow | null> {
  return db.prepare("SELECT * FROM ap_approvals WHERE id = ?").bind(id).first<ApprovalRow>();
}

export async function createApproval(
  db: D1Database,
  input: { walletId: string; agentId: string | null; amountCents: number; description: string; service: string; tool: string; ref: string },
): Promise<ApprovalRow> {
  const id = newId("apa");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  await db
    .prepare(
      "INSERT INTO ap_approvals (id, wallet_id, agent_id, amount_cents, description, service, tool, ref, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(
      id,
      input.walletId,
      input.agentId,
      input.amountCents,
      cleanStr(input.description, 200),
      cleanStr(input.service, 80),
      cleanStr(input.tool, 80),
      cleanStr(input.ref, 120),
      createdAt,
      expiresAt,
    )
    .run();
  const row = await getApproval(db, id);
  if (!row) throw new HttpError(500, "Approval insert failed");
  return row;
}

/** Newest first, lazily expiring stale pending rows. */
export async function listApprovals(db: D1Database, walletId: string, limit = 25): Promise<ApprovalRow[]> {
  await db
    .prepare("UPDATE ap_approvals SET status = 'expired' WHERE wallet_id = ? AND status = 'pending' AND expires_at < ?")
    .bind(walletId, nowIso())
    .run();
  const { results } = await db
    .prepare("SELECT * FROM ap_approvals WHERE wallet_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(walletId, Math.min(Math.max(1, limit), 100))
    .all<ApprovalRow>();
  return results ?? [];
}

export async function decideApproval(
  db: D1Database,
  walletId: string,
  approvalId: string,
  approve: boolean,
  reason = "",
): Promise<ApprovalRow> {
  const row = await getApproval(db, approvalId);
  if (!row || row.wallet_id !== walletId) throw new HttpError(404, "Approval not found");
  if (row.status !== "pending") throw new HttpError(409, `Approval is already ${row.status}`);
  if (row.expires_at < nowIso()) {
    await db.prepare("UPDATE ap_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(approvalId).run();
    throw new HttpError(409, "Approval expired — ask the agent to request again");
  }
  const res = await db
    .prepare("UPDATE ap_approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(approve ? "approved" : "denied", cleanStr(reason, 200), nowIso(), approvalId)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) throw new HttpError(409, "Approval already decided");
  const fresh = await getApproval(db, approvalId);
  if (!fresh) throw new HttpError(500, "Approval update failed");
  return fresh;
}

/**
 * Consume an approved request exactly once. Returns null when the approval is
 * missing, not approved, expired, already used, or does not match the purchase.
 */
export async function consumeApproval(
  db: D1Database,
  input: { walletId: string; agentId: string | null; approvalId: string; amountCents: number; service?: string; tool?: string },
): Promise<ApprovalRow | null> {
  const row = await getApproval(db, input.approvalId);
  if (!row) return null;
  if (row.wallet_id !== input.walletId || row.agent_id !== input.agentId) return null;
  if (row.status === "pending" && row.expires_at < nowIso()) {
    await db.prepare("UPDATE ap_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(row.id).run();
    return null;
  }
  if (row.status !== "approved") return null;
  if (row.expires_at < nowIso()) return null;
  if (row.amount_cents !== input.amountCents) return null;
  if (input.service && row.service && row.service !== input.service) return null;
  if (input.tool && row.tool && row.tool !== input.tool) return null;
  const claimed = await db
    .prepare("UPDATE ap_approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'")
    .bind(nowIso(), row.id)
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) return null;
  return getApproval(db, row.id);
}

export async function getBalanceCents(db: D1Database, walletId: string): Promise<number> {
  const row = await db
    .prepare("SELECT balance_cents FROM ap_wallets WHERE id = ?")
    .bind(walletId)
    .first<{ balance_cents: number }>();
  return row?.balance_cents ?? 0;
}

/** Idempotent credit keyed by an external ref (Stripe Checkout session id). */
export async function creditTopup(
  db: D1Database,
  input: { walletId: string; amountCents: number; ref: string; meta?: Record<string, unknown> },
): Promise<{ credited: boolean; amountCents: number; balanceCents: number; ledgerId: string | null }> {
  const { walletId, amountCents, ref } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new HttpError(400, "Invalid top-up amount");
  }
  if (!ref) throw new HttpError(400, "Top-up ref is required");

  const claimed = await db
    .prepare("INSERT OR IGNORE INTO ap_topup_refs (ref, wallet_id, amount_cents, created_at) VALUES (?, ?, ?, ?)")
    .bind(ref, walletId, amountCents, nowIso())
    .run();

  if ((claimed.meta?.changes ?? 0) === 0) {
    return { credited: false, amountCents: 0, balanceCents: await getBalanceCents(db, walletId), ledgerId: null };
  }

  const wallet = await db
    .prepare("SELECT id, status FROM ap_wallets WHERE id = ?")
    .bind(walletId)
    .first<{ id: string; status: string }>();
  if (!wallet) throw new HttpError(404, "Wallet not found");
  if (wallet.status !== "active") throw new HttpError(403, "Wallet is frozen");

  await db
    .prepare(
      "UPDATE ap_wallets SET balance_cents = balance_cents + ?, lifetime_topup_cents = lifetime_topup_cents + ?, updated_at = ? WHERE id = ?",
    )
    .bind(amountCents, amountCents, nowIso(), walletId)
    .run();

  const balanceCents = await getBalanceCents(db, walletId);
  const ledgerId = newId("apl");
  await db
    .prepare(
      "INSERT INTO ap_ledger (id, wallet_id, agent_id, kind, amount_cents, balance_after_cents, currency, ref, meta_json, created_at) VALUES (?, ?, NULL, 'topup', ?, ?, 'usd', ?, ?, ?)",
    )
    .bind(ledgerId, walletId, amountCents, balanceCents, ref, JSON.stringify(input.meta ?? {}), nowIso())
    .run();

  return { credited: true, amountCents, balanceCents, ledgerId };
}

export interface SpendInput {
  walletId: string;
  agent: AgentRow | null;
  amountCents: number;
  description: string;
  service?: string;
  tool?: string;
  ref?: string;
  meta?: Record<string, unknown>;
}

export interface SpendResult {
  receipt: ReceiptRow;
  ledger: LedgerRow;
  balanceCents: number;
  agentSpentTodayCents: number | null;
}

export async function spend(db: D1Database, input: SpendInput): Promise<SpendResult> {
  const amountCents = input.amountCents;
  if (!isValidSpendAmount(amountCents)) {
    throw new HttpError(400, `amountCents must be an integer 1..${MAX_SPEND_CENTS}`);
  }
  const description = cleanStr(input.description, DESCRIPTION_MAX);
  if (!description) throw new HttpError(400, "description is required");

  // 1. Agent daily limit (guarded UPDATE also records the spend).
  if (input.agent) {
    const day = utcDay();
    const res = await db
      .prepare(
        "UPDATE ap_agents SET spent_today_cents = CASE WHEN spent_day = ? THEN spent_today_cents + ? ELSE ? END, spent_day = ?, last_used_at = ? WHERE id = ? AND active = 1 AND (daily_limit_cents IS NULL OR (CASE WHEN spent_day = ? THEN spent_today_cents ELSE 0 END) + ? <= daily_limit_cents)",
      )
      .bind(day, amountCents, amountCents, day, nowIso(), input.agent.id, day, amountCents)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) {
      throw new HttpError(
        402,
        `Daily limit would be exceeded for agent "${input.agent.name}" (limit ${formatCents(input.agent.daily_limit_cents ?? 0)}/day)`,
      );
    }
  }

  // 1b. Sub-agent lifetime budget (guarded UPDATE) — only for delegated keys.
  if (input.agent?.parent_agent_id) {
    const budget = await db
      .prepare(
        "UPDATE ap_subagent_budgets SET spent_cents = spent_cents + ?, updated_at = ? WHERE agent_id = ? AND (budget_cents IS NULL OR spent_cents + ? <= budget_cents) AND (expires_at IS NULL OR expires_at > ?)",
      )
      .bind(amountCents, nowIso(), input.agent.id, amountCents, nowIso())
      .run();
    if ((budget.meta?.changes ?? 0) !== 1) {
      await db
        .prepare(
          "UPDATE ap_agents SET spent_today_cents = CASE WHEN spent_today_cents >= ? THEN spent_today_cents - ? ELSE 0 END WHERE id = ?",
        )
        .bind(amountCents, amountCents, input.agent.id)
        .run();
      throw new HttpError(402, "Sub-agent budget exhausted or key expired — ask the parent agent for a new one", {
        code: "subagent_budget",
      });
    }
  }

  // 2. Wallet debit — never below zero.
  const debit = await db
    .prepare(
      "UPDATE ap_wallets SET balance_cents = balance_cents - ?, updated_at = ? WHERE id = ? AND status = 'active' AND balance_cents >= ?",
    )
    .bind(amountCents, nowIso(), input.walletId, amountCents)
    .run();
  if ((debit.meta?.changes ?? 0) !== 1) {
    if (input.agent) {
      await db
        .prepare(
          "UPDATE ap_agents SET spent_today_cents = CASE WHEN spent_today_cents >= ? THEN spent_today_cents - ? ELSE 0 END WHERE id = ?",
        )
        .bind(amountCents, amountCents, input.agent.id)
        .run();
      if (input.agent.parent_agent_id) {
        await db
          .prepare(
            "UPDATE ap_subagent_budgets SET spent_cents = CASE WHEN spent_cents >= ? THEN spent_cents - ? ELSE 0 END, updated_at = ? WHERE agent_id = ?",
          )
          .bind(amountCents, amountCents, nowIso(), input.agent.id)
          .run();
      }
    }
    throw new HttpError(402, "Insufficient balance — create a top-up link to fund this wallet");
  }

  const balanceCents = await getBalanceCents(db, input.walletId);
  const ledgerId = newId("apl");
  const meta = {
    description,
    service: cleanStr(input.service, 80),
    tool: cleanStr(input.tool, 80),
    ...(input.meta ?? {}),
  };
  await db
    .prepare(
      "INSERT INTO ap_ledger (id, wallet_id, agent_id, kind, amount_cents, balance_after_cents, currency, ref, meta_json, created_at) VALUES (?, ?, ?, 'debit', ?, ?, 'usd', ?, ?, ?)",
    )
    .bind(
      ledgerId,
      input.walletId,
      input.agent?.id ?? null,
      -amountCents,
      balanceCents,
      cleanStr(input.ref, 120),
      JSON.stringify(meta),
      nowIso(),
    )
    .run();

  const receiptId = newId("apr");
  await db
    .prepare(
      "INSERT INTO ap_receipts (id, ledger_id, wallet_id, agent_id, service, tool, description, amount_cents, currency, request_ref, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?)",
    )
    .bind(
      receiptId,
      ledgerId,
      input.walletId,
      input.agent?.id ?? null,
      meta.service,
      meta.tool,
      description,
      amountCents,
      cleanStr(input.ref, 120),
      JSON.stringify(input.meta ?? {}),
      nowIso(),
    )
    .run();

  const ledger = await db.prepare("SELECT * FROM ap_ledger WHERE id = ?").bind(ledgerId).first<LedgerRow>();
  const receipt = await db.prepare("SELECT * FROM ap_receipts WHERE id = ?").bind(receiptId).first<ReceiptRow>();
  if (!ledger || !receipt) throw new HttpError(500, "Ledger write failed");

  let agentSpentTodayCents: number | null = null;
  if (input.agent) {
    const fresh = await db
      .prepare("SELECT spent_today_cents FROM ap_agents WHERE id = ?")
      .bind(input.agent.id)
      .first<{ spent_today_cents: number }>();
    agentSpentTodayCents = fresh?.spent_today_cents ?? null;
  }

  return { receipt, ledger, balanceCents, agentSpentTodayCents };
}

/**
 * Return a debit to the wallet (e.g. x402 seller rejected the payment after we
 * charged). Also unwinds the agent's daily-limit counter. Idempotent by ref.
 */
export async function refundSpend(
  db: D1Database,
  input: {
    walletId: string;
    agentId: string | null;
    amountCents: number;
    ref?: string;
    description?: string;
    receiptId?: string;
  },
): Promise<{ refunded: boolean; balanceCents: number; ledgerId: string | null }> {
  const amountCents = input.amountCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new HttpError(400, "Invalid refund amount");
  }
  const ref = cleanStr(input.ref, 120);
  if (ref) {
    const existing = await db
      .prepare("SELECT id FROM ap_ledger WHERE wallet_id = ? AND kind = 'refund' AND ref = ? LIMIT 1")
      .bind(input.walletId, ref)
      .first<{ id: string }>();
    if (existing) {
      return { refunded: false, balanceCents: await getBalanceCents(db, input.walletId), ledgerId: existing.id };
    }
  }

  await db
    .prepare("UPDATE ap_wallets SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ? AND status = 'active'")
    .bind(amountCents, nowIso(), input.walletId)
    .run();
  if (input.agentId) {
    await db
      .prepare(
        "UPDATE ap_agents SET spent_today_cents = CASE WHEN spent_today_cents >= ? THEN spent_today_cents - ? ELSE 0 END WHERE id = ?",
      )
      .bind(amountCents, amountCents, input.agentId)
      .run();
    await db
      .prepare(
        "UPDATE ap_subagent_budgets SET spent_cents = CASE WHEN spent_cents >= ? THEN spent_cents - ? ELSE 0 END, updated_at = ? WHERE agent_id = ?",
      )
      .bind(amountCents, amountCents, nowIso(), input.agentId)
      .run();
  }

  const balanceCents = await getBalanceCents(db, input.walletId);
  const ledgerId = newId("apl");
  await db
    .prepare(
      "INSERT INTO ap_ledger (id, wallet_id, agent_id, kind, amount_cents, balance_after_cents, currency, ref, meta_json, created_at) VALUES (?, ?, ?, 'refund', ?, ?, 'usd', ?, ?, ?)",
    )
    .bind(
      ledgerId,
      input.walletId,
      input.agentId,
      amountCents,
      balanceCents,
      ref,
      JSON.stringify({ description: cleanStr(input.description, DESCRIPTION_MAX) }),
      nowIso(),
    )
    .run();

  if (input.receiptId) {
    await db
      .prepare("UPDATE ap_receipts SET result_json = json_set(result_json, '$.refunded', json('true')) WHERE id = ?")
      .bind(input.receiptId)
      .run();
  }

  return { refunded: true, balanceCents, ledgerId };
}

/** Replay guard for x402 settlements: true when this txid is newly claimed. */
export async function claimX402Txid(
  db: D1Database,
  input: { txid: string; walletId: string; service?: string; tool?: string; receiptId?: string },
): Promise<boolean> {
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO ap_x402_payments (txid, wallet_id, service, tool, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      input.txid,
      input.walletId,
      cleanStr(input.service, 80),
      cleanStr(input.tool, 80),
      input.receiptId ?? null,
      nowIso(),
    )
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function listLedger(db: D1Database, walletId: string, limit = 25): Promise<LedgerRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM ap_ledger WHERE wallet_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(walletId, Math.min(Math.max(1, limit), 100))
    .all<LedgerRow>();
  return results ?? [];
}

export async function listReceipts(db: D1Database, walletId: string, limit = 25): Promise<ReceiptRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM ap_receipts WHERE wallet_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(walletId, Math.min(Math.max(1, limit), 100))
    .all<ReceiptRow>();
  return results ?? [];
}

export async function getReceipt(
  db: D1Database,
  walletId: string,
  receiptId: string,
): Promise<ReceiptRow | null> {
  return db
    .prepare("SELECT * FROM ap_receipts WHERE id = ? AND wallet_id = ?")
    .bind(receiptId, walletId)
    .first<ReceiptRow>();
}

export async function setStripeCustomerId(db: D1Database, walletId: string, customerId: string): Promise<void> {
  await db
    .prepare("UPDATE ap_wallets SET stripe_customer_id = ?, updated_at = ? WHERE id = ?")
    .bind(customerId, nowIso(), walletId)
    .run();
}
