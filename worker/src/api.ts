/**
 * agentpay REST API — mounted at /api/agentpay/*.
 *
 * Owner routes (apw_ bearer token): wallet, agents, top-up.
 * Agent routes (agp_ bearer key): balance, spend, receipts, top-up link.
 * Public routes: health, x402market services + live quotes.
 * Stripe webhook is signature-verified and idempotent.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  HttpError,
  type AgentPolicyRow,
  type AgentRow,
  type AppEnv,
  type ApprovalRow,
  type GoogleUserRow,
  type LedgerRow,
  type PlanState,
  type ReceiptRow,
  type SubagentRow,
  type WalletRow,
} from "./types";
import { requireAgent, requireWallet, mintWalletToken, WALLET_TOKEN_PREFIX } from "./auth";
import {
  agentSpendAllowed,
  agentToolAllowed,
  claimX402Txid,
  consumeApproval,
  createAgent,
  createApproval,
  createSubagent,
  createWallet,
  decideApproval,
  getAgentPolicy,
  getAgentForWallet,
  getApproval,
  getReceipt,
  getSubagent,
  listAgents,
  listApprovals,
  listLedger,
  listReceipts,
  listSubagents,
  parseAllowedTools,
  recoverWallet,
  refundSpend,
  revokeAgent,
  rotateAgentKey,
  setAgentPolicy,
  spend,
} from "./ledger";
import {
  TOPUP_MAX_CENTS,
  TOPUP_MIN_CENTS,
  TOPUP_PRESETS,
  claimTopup,
  createBillingPortalSession,
  createSubscriptionCheckout,
  createTopupCheckout,
  handleStripeEvent,
  stripeConfigured,
  stripeEnvLivemode,
  stripeClient,
} from "./stripe";
import { PLANS, getPlanState, planLimitError, upgradeUrl } from "./plans";
import {
  ALERT_EVENTS,
  deleteWebhook,
  getWebhook,
  isValidWebhookUrl,
  listDeliveries,
  lowBalanceDefault,
  maybeAlertTreasury,
  notifyApprovalDecided,
  notifyApprovalRequired,
  notifyBudgetExhausted,
  notifyLowBalance,
  notifySpend,
  parseAlertEvents,
  redeliverFailed,
  rotateWebhookSecret,
  sendTestEvent,
  setWebhook,
} from "./notify";
import {
  buildReport,
  createReportLink,
  getActiveReportLink,
  listReportLinks,
  renderReportHtml,
  revokeReportLink,
  touchReportLink,
} from "./reports";
import {
  ATTESTATION_ISSUER,
  assertSigningConfigured,
  attestationPublicKey,
  buildAttestation,
  clampAttestationDays,
  signAttestation,
  signedAttestationResponse,
  verifyAttestation,
  type Attestation,
} from "./attestations";
import { callServiceTool, getService, listServices, quoteService, registryAvailable } from "./registry";
import { applyTrustMultiplier, decidePayTrust, fetchReputation, resolveBountyAccount, trustPayMode } from "./trust";
import { getCachedBsvUsd } from "./price";
import {
  bountyPayoutInfo,
  bountyRecord,
  claimBountyRemote,
  getBounty,
  getLink,
  handleBountyEvent,
  isValidBsvAddress,
  linkBounty,
  listBounties,
  listEscrowRows,
  listLinks,
  postFundedBounty,
  publicEscrow,
  retryFundedBounty,
  settleFundedBounty,
  submitWorkRemote,
  touchLinkStatus,
  workerRefFor,
} from "./bounties";
import {
  chargeCentsFor,
  maxPaymentSats,
  parseBsvRequirements,
  prepareBsvPayment,
  siteWalletAddress,
  siteWalletConfigured,
  treasuryStatus,
} from "./x402";
import { API_PREFIX, APP_PREFIX, MCP_PATH, PUBLIC_SITE, siteOrigin } from "./paths";
import { cleanStr, nowIso, sha256Hex, timingSafeEqualStr } from "./ids";
import { verifyGoogleIdToken } from "./google";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function publicPlan(plan: PlanState) {
  return {
    id: plan.id,
    name: plan.id === "pro" ? PLANS.pro.name : PLANS.free.name,
    subscribedPlan: plan.subscribedPlan,
    active: plan.active,
    status: plan.status,
    currentPeriodEnd: plan.currentPeriodEnd,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
    priceCents: plan.priceCents,
    limits: plan.limits,
    upgradeUrl: upgradeUrl(),
  };
}

function publicWallet(w: WalletRow) {
  return {
    id: w.id,
    name: w.name,
    email: w.email,
    balanceCents: w.balance_cents,
    lifetimeTopupCents: w.lifetime_topup_cents,
    status: w.status,
    stripeCustomer: Boolean(w.stripe_customer_id),
    createdAt: w.created_at,
  };
}

function publicAgent(a: AgentRow, policy?: AgentPolicyRow) {
  const budget = a.sub_budget_cents ?? null;
  const spent = a.sub_spent_cents ?? 0;
  return {
    id: a.id,
    name: a.name,
    keyPrefix: a.key_prefix,
    dailyLimitCents: a.daily_limit_cents,
    spentTodayCents: a.spent_today_cents,
    spentDay: a.spent_day,
    active: a.active === 1,
    approvalAboveCents: policy?.approval_above_cents ?? null,
    allowedTools: policy ? parseAllowedTools(policy.allowed_tools_json) : [],
    createdAt: a.created_at,
    lastUsedAt: a.last_used_at,
    subagent: a.parent_agent_id
      ? {
          parentAgentId: a.parent_agent_id,
          budgetCents: budget,
          spentCents: spent,
          remainingCents: budget === null ? null : Math.max(0, budget - spent),
          expiresAt: a.sub_expires_at ?? null,
          expired: Boolean(a.sub_expires_at && a.sub_expires_at <= nowIso()),
        }
      : null,
  };
}

function publicPolicy(p: AgentPolicyRow) {
  return {
    agentId: p.agent_id,
    approvalAboveCents: p.approval_above_cents,
    allowedTools: parseAllowedTools(p.allowed_tools_json),
    updatedAt: p.updated_at,
  };
}

function publicApproval(a: ApprovalRow) {
  return {
    id: a.id,
    agentId: a.agent_id,
    amountCents: a.amount_cents,
    description: a.description,
    service: a.service,
    tool: a.tool,
    ref: a.ref,
    status: a.status,
    reason: a.reason,
    createdAt: a.created_at,
    expiresAt: a.expires_at,
    decidedAt: a.decided_at,
    consumedAt: a.consumed_at,
  };
}

function publicLedger(l: LedgerRow) {
  const meta = parseJson<Record<string, string>>(l.meta_json, {});
  return {
    id: l.id,
    kind: l.kind,
    amountCents: l.amount_cents,
    balanceAfterCents: l.balance_after_cents,
    currency: l.currency,
    ref: l.ref,
    type: meta.type ?? "",
    description: meta.description ?? "",
    service: meta.service ?? "",
    tool: meta.tool ?? "",
    agentId: l.agent_id,
    createdAt: l.created_at,
  };
}

function publicReceipt(r: ReceiptRow) {
  return {
    id: r.id,
    ledgerId: r.ledger_id,
    service: r.service,
    tool: r.tool,
    description: r.description,
    amountCents: r.amount_cents,
    currency: r.currency,
    requestRef: r.request_ref,
    createdAt: r.created_at,
  };
}

const SELLER_BODY_MAX = 16_000;

async function sellerResponse(res: Response): Promise<{ status: number; contentType: string; body: string }> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: body.length > SELLER_BODY_MAX ? `${body.slice(0, SELLER_BODY_MAX)}…[truncated]` : body,
  };
}

function safeParseB64(value: string): unknown {
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { raw: value.slice(0, 200) };
  }
}

type ApiContext = Context<{ Bindings: AppEnv }>;

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n")}\r\n`;
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

type GateResult = { response: Response } | { consume: true } | null;

/**
 * Scope + approval gate for spending routes. Returns a 402 Response when the
 * purchase needs human approval, `{ consume: true }` when an approved request
 * is ready (consumed only at settlement time), or null when no approval is
 * needed. Throws 403 on scope violations.
 */
async function gateSpend(
  c: ApiContext,
  input: {
    wallet: WalletRow;
    agent: AgentRow;
    amountCents: number;
    description: string;
    ref: string;
    approvalId: string;
    serviceId?: string;
    toolName?: string;
    serviceLabel?: string;
    toolLabel?: string;
    thresholdOverride?: number | null;
  },
): Promise<GateResult> {
  const policy = await getAgentPolicy(c.env.DB, input.agent.id);
  const allowed = parseAllowedTools(policy.allowed_tools_json);
  if (input.serviceId && input.toolName) {
    if (!agentToolAllowed(allowed, input.serviceId, input.toolName)) {
      throw new HttpError(403, `Tool ${input.serviceId}:${input.toolName} is not in this agent's allowlist`);
    }
  } else if (!agentSpendAllowed(allowed)) {
    throw new HttpError(403, "This agent's allowlist does not permit generic spend");
  }

  const threshold = input.thresholdOverride !== undefined ? input.thresholdOverride : policy.approval_above_cents;
  if (threshold === null || input.amountCents < threshold) return null;

  if (!input.approvalId) {
    const approval = await createApproval(c.env.DB, {
      walletId: input.wallet.id,
      agentId: input.agent.id,
      amountCents: input.amountCents,
      description: input.description,
      service: input.serviceLabel ?? "",
      tool: input.toolLabel ?? "",
      ref: input.ref,
    });
    c.executionCtx.waitUntil(notifyApprovalRequired(c.env, input.wallet, approval));
    return {
      response: c.json(
        {
          error: "approval_required",
          approvalId: approval.id,
          approvalUrl: `${PUBLIC_SITE}${APP_PREFIX}/?approval=${approval.id}`,
          amountCents: input.amountCents,
          description: input.description,
          expiresAt: approval.expires_at,
          note: "A human must approve this purchase in the agentpay dashboard, then retry with approvalId.",
        },
        402,
      ),
    };
  }

  // Validate the approval now; it is consumed only once settlement can proceed.
  const approved = await getApproval(c.env.DB, input.approvalId);
  if (!approved || approved.wallet_id !== input.wallet.id || approved.agent_id !== input.agent.id) {
    throw new HttpError(402, "Approval not found for this agent");
  }
  if (approved.status !== "approved") {
    throw new HttpError(402, `Approval is ${approved.status} — a human must approve it first`);
  }
  if (approved.expires_at < nowIso()) {
    throw new HttpError(402, "Approval expired — request a new one");
  }
  if (approved.amount_cents !== input.amountCents) {
    throw new HttpError(402, "Approval amount no longer matches this purchase");
  }
  if (input.serviceLabel && approved.service && approved.service !== input.serviceLabel) {
    throw new HttpError(402, "Approval was for a different service");
  }
  if (input.toolLabel && approved.tool && approved.tool !== input.toolLabel) {
    throw new HttpError(402, "Approval was for a different tool");
  }
  return { consume: true };
}

/** Consume an approved request exactly once, immediately before settlement. */
async function consumeGate(
  c: ApiContext,
  input: { walletId: string; agentId: string; approvalId: string; amountCents: number; service?: string; tool?: string },
): Promise<void> {
  const consumed = await consumeApproval(c.env.DB, {
    walletId: input.walletId,
    agentId: input.agentId,
    approvalId: input.approvalId,
    amountCents: input.amountCents,
    service: input.service,
    tool: input.tool,
  });
  if (!consumed) {
    throw new HttpError(402, "Approval was already used or expired before settlement — request a new one");
  }
}

/** Spend/low-balance notifications. Callers hand this to `waitUntil`. */
async function afterSpend(
  c: ApiContext,
  wallet: WalletRow,
  result: { receipt: ReceiptRow; balanceCents: number },
): Promise<void> {
  try {
    const hook = await getWebhook(c.env.DB, wallet.id);
    const threshold = hook?.low_balance_cents ?? lowBalanceDefault(c.env);
    const prevBalance = result.balanceCents + result.receipt.amount_cents;
    await notifySpend(c.env, wallet.id, {
      amountCents: result.receipt.amount_cents,
      description: result.receipt.description,
      service: result.receipt.service,
      tool: result.receipt.tool,
      balanceCents: result.balanceCents,
    });
    if (result.balanceCents < threshold && prevBalance >= threshold) {
      await notifyLowBalance(c.env, wallet, result.balanceCents, threshold);
    }
  } catch (err) {
    console.error("[agentpay-notify] afterSpend", err);
  }
}

export const api = new Hono<{ Bindings: AppEnv }>().basePath(API_PREFIX);

api.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  await next();
  for (const [key, value] of Object.entries(CORS_HEADERS)) c.res.headers.set(key, value);
});

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...(err.payload ?? {}) }, err.status as 400);
  console.error("[agentpay]", err);
  return c.json({ error: "Internal error" }, 500);
});

api.notFound((c) => c.json({ error: `No such endpoint: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));

function subagentCreated(child: AgentRow, subagent: SubagentRow, key: string) {
  return {
    agent: publicAgent(child),
    subagent: {
      parentAgentId: subagent.parent_agent_id,
      budgetCents: subagent.budget_cents,
      spentCents: subagent.spent_cents,
      remainingCents:
        subagent.budget_cents === null ? null : Math.max(0, subagent.budget_cents - subagent.spent_cents),
      expiresAt: subagent.expires_at,
    },
    key,
    note: "Store this sub-agent key now — it is shown only once. It can spend only up to its budget, before its expiry, within its allowlist.",
  };
}

// ---------- public ----------

api.get("/health", async (c) => {
  const env = c.env;
  let treasury = null;
  try {
    treasury = await treasuryStatus(env.DB, env);
  } catch {
    treasury = {
      configured: siteWalletConfigured(env),
      address: siteWalletAddress(env),
      sats: null,
      thresholdSats: 0,
      low: false,
      stale: true,
      updatedAt: null,
    };
  }
  return c.json({
    ok: true,
    service: "agentpay",
    site: `${PUBLIC_SITE}/agentpay/`,
    mcp: `${PUBLIC_SITE}${MCP_PATH}`,
    stripe: stripeConfigured(env),
    livemode: stripeEnvLivemode(env),
    registry: await registryAvailable(env.DB),
    price: await getCachedBsvUsd(env.DB)
      .then((p) => (p ? { usd: p.usd, atMs: p.atMs, source: "coingecko" } : { usd: null, source: "configured" }))
      .catch(() => ({ usd: null, source: "configured" })),
    x402: {
      siteWalletConfigured: siteWalletConfigured(env),
      siteWalletAddress: siteWalletAddress(env),
      maxPaymentSats: maxPaymentSats(env),
      treasury,
    },
  });
});

// ---------- Google sign-in (public) ----------

/** Google OAuth client id, or 501 when unconfigured. */
function googleClientId(c: Context<{ Bindings: AppEnv }>): string {
  const id = (c.env.GOOGLE_CLIENT_ID ?? "").trim();
  if (!id) throw new HttpError(501, "Google login is not configured");
  return id;
}

api.get("/auth/google/config", (c) => {
  const clientId = (c.env.GOOGLE_CLIENT_ID ?? "").trim();
  return c.json({ configured: !!clientId, clientId: clientId || null });
});

/** Rotate the wallet token and return the fresh one (only the hash is stored). */
async function rotateWalletToken(db: D1Database, walletId: string): Promise<string> {
  const token = mintWalletToken();
  await db
    .prepare("UPDATE ap_wallets SET token_hash = ?, updated_at = ? WHERE id = ?")
    .bind(await sha256Hex(token), nowIso(), walletId)
    .run();
  return token;
}

/**
 * Sign in with a Google ID token (GIS flow). New identity → new wallet + user
 * row, returns the wallet token and a one-time recovery code. Returning
 * identity → fresh wallet token (old sessions stop working).
 */
api.post("/auth/google", async (c) => {
  const clientId = googleClientId(c);
  const body = (await c.req.json().catch(() => ({}))) as { idToken?: unknown };
  const idToken = String(body.idToken ?? "");
  if (!idToken) throw new HttpError(400, "idToken is required");
  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken, clientId);
  } catch (err) {
    throw new HttpError(401, err instanceof Error ? err.message : "Invalid ID token");
  }
  const db = c.env.DB;
  const existing = await db
    .prepare("SELECT * FROM ap_users WHERE google_sub = ?")
    .bind(identity.sub)
    .first<GoogleUserRow>();
  if (!existing) {
    const { wallet, token, recoveryCode } = await createWallet(db, {
      name: identity.name,
      email: identity.email,
    });
    const t = nowIso();
    await db
      .prepare(
        "INSERT INTO ap_users (google_sub, email, name, wallet_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(identity.sub, identity.email, identity.name, wallet.id, t, t)
      .run();
    return c.json({
      token,
      walletId: wallet.id,
      name: identity.name,
      email: identity.email,
      isNew: true,
      recoveryCode,
      note: "Store the recovery code now — it is shown only once and resets the wallet token if it is lost.",
    });
  }
  const wallet = await db
    .prepare("SELECT * FROM ap_wallets WHERE id = ? AND status = 'active'")
    .bind(existing.wallet_id)
    .first<WalletRow>();
  if (!wallet) throw new HttpError(401, "Linked wallet is inactive");
  await db
    .prepare("UPDATE ap_users SET email = ?, name = ?, updated_at = ? WHERE google_sub = ?")
    .bind(identity.email, identity.name, nowIso(), identity.sub)
    .run();
  const token = await rotateWalletToken(db, wallet.id);
  return c.json({
    token,
    walletId: wallet.id,
    name: identity.name,
    email: identity.email,
    isNew: false,
    recoveryCode: null,
    note: "A fresh wallet token was issued — sessions using the old token stop working.",
  });
});

/**
 * Attach a wallet created the old way (token, no Google identity) to the
 * signer's Google identity. Idempotent per sub.
 */
api.post("/auth/google/link", async (c) => {
  const clientId = googleClientId(c);
  const body = (await c.req.json().catch(() => ({}))) as { idToken?: unknown; walletToken?: unknown };
  const idToken = String(body.idToken ?? "");
  const walletToken = String(body.walletToken ?? "").trim();
  if (!idToken) throw new HttpError(400, "idToken is required");
  if (!walletToken.startsWith(WALLET_TOKEN_PREFIX)) throw new HttpError(401, "That is not a wallet token");
  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken, clientId);
  } catch (err) {
    throw new HttpError(401, err instanceof Error ? err.message : "Invalid ID token");
  }
  const db = c.env.DB;
  const wallet = await db
    .prepare("SELECT * FROM ap_wallets WHERE token_hash = ? AND status = 'active'")
    .bind(await sha256Hex(walletToken))
    .first<WalletRow>();
  if (!wallet) throw new HttpError(401, "Unknown or revoked wallet token");
  const t = nowIso();
  await db
    .prepare(
      `INSERT INTO ap_users (google_sub, email, name, wallet_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name,
         wallet_id = excluded.wallet_id, updated_at = excluded.updated_at`,
    )
    .bind(identity.sub, identity.email, identity.name, wallet.id, t, t)
    .run();
  return c.json({ ok: true, walletId: wallet.id });
});

/** One-page agent starter: wallet → key → bounty account → fund → spend. */
api.get("/start", async (c) => {
  const base = `${PUBLIC_SITE}${API_PREFIX}`;
  return c.json({
    steps: [
      { n: 1, title: "Create a wallet (human, once)", method: "POST", path: "/wallets", body: { name: "My agent wallet", email: "you@example.com" }, returns: "wallet token (apw_…) + recovery code — store both" },
      { n: 2, title: "Top up with a card", method: "POST", path: "/wallets/me/topup", auth: "apw_…", returns: "Stripe Checkout URL for a human to open" },
      { n: 3, title: "Mint a scoped agent key", method: "POST", path: "/wallets/me/agents", auth: "apw_…", body: { name: "worker-1", dailyLimitCents: 500 }, returns: "agent key (agp_…) — spend-only, never withdraws" },
      { n: 4, title: "Mint a bounty account + claim through agentpay", tool: "claim_bounty", body: { bountyId: "<id>", workerAccount: "<your #N>", workerPubKey: "<your key>" }, note: "Claiming through agentpay links wallet↔account for payouts, reputation fast-path, and bond discount" },
      { n: 5, title: "Dry-run a paid call (no charge)", tool: "pay_service", body: { serviceId: "<id>", tool: "<tool>", dryRun: true }, note: "Returns quote + would-be charge + trust evaluation without debiting" },
      { n: 6, title: "Spend for real", tool: "pay_service", body: { serviceId: "<id>", tool: "<tool>", params: {} } },
    ],
    mcp: `${PUBLIC_SITE}${MCP_PATH}`,
    docs: `${PUBLIC_SITE}/agentpay/docs/`,
    connect: `${PUBLIC_SITE}${API_PREFIX}/connect`,
    base,
  });
});

/** Machine-readable agent card: MCP endpoint, tools, registry, trust rails. */
api.get("/agent-card", async (c) => {
  const { MCP_TOOLS } = await import("./mcp");
  return c.json({
    name: "agentpay",
    version: "0.1.0",
    site: `${PUBLIC_SITE}/agentpay/`,
    docs: `${PUBLIC_SITE}/agentpay/docs/`,
    mcp: { endpoint: `${PUBLIC_SITE}${MCP_PATH}`, transport: "streamable-http", auth: "Bearer agp_… (header or per-tool key)" },
    connect: `${PUBLIC_SITE}${API_PREFIX}/connect`,
    tools: MCP_TOOLS,
    registry: `${PUBLIC_SITE}/x402market/`,
    trust: {
      attestations: {
        issue: "POST /agent/attestation {days?, sub?}",
        verify: "POST /attestations/verify {attestation, signature}",
        publicKey: "GET /attestations/key",
      },
      reputationFastPath: "pay_service {bountyAccount} → approval threshold x2 when score>=650",
      bondDiscount: "claim_bounty {attestation, attestationSignature} → 50% worker bond off when eligible",
      sandbox: "pay_service {dryRun:true} → quote + policy check, no charge",
    },
    starter: `${PUBLIC_SITE}${API_PREFIX}/start`,
  });
});

/** Copy-paste client configs to connect an agent in under a minute. */
api.get("/connect", async (c) => {
  const key = cleanStr(c.req.query("key"), 120);
  const auth = key || "agp_YOUR_KEY_HERE";
  const mcpUrl = `${PUBLIC_SITE}${MCP_PATH}`;
  return c.json({
    mcp: { url: mcpUrl, transport: "streamable-http", authHeader: `Authorization: Bearer ${key ? "agp_…(embedded)" : auth}` },
    claudeCode: {
      note: "Run in a terminal, or add to ~/.claude.json mcpServers",
      command: `claude mcp add --transport http agentpay ${mcpUrl} --header "Authorization: Bearer ${auth}"`,
    },
    cursor: {
      note: "Settings → MCP → Add custom MCP, or paste into ~/.cursor/mcp.json",
      json: { mcpServers: { agentpay: { url: mcpUrl, headers: { Authorization: `Bearer ${auth}` } } } },
    },
    opencode: {
      note: "Paste into opencode.json mcp section",
      json: { mcp: { agentpay: { type: "remote", url: mcpUrl, headers: { Authorization: `Bearer ${auth}` } } } },
    },
    smoke: {
      note: "No key needed for discovery",
      curl: `curl -s -X POST ${mcpUrl} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300`,
    },
    firstTool: "onboard",
    skill: `${PUBLIC_SITE}${API_PREFIX}/skill`,
    docs: `${PUBLIC_SITE}/agentpay/docs/`,
    starter: `${PUBLIC_SITE}${API_PREFIX}/start`,
  });
});

/** Trial faucet: one funded starter wallet per IP per day (operator-gated). */
api.post("/trial", async (c) => {
  const { claimTrial, trialResponse } = await import("./trial");
  const ip =
    c.req.header("CF-Connecting-IP")?.split(",")[0]?.trim() ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "anon";
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const claim = await claimTrial(c.env.DB, c.env, ip, body.name);
  return c.json(trialResponse(claim, siteOrigin(c.req.raw)), 201);
});

/** Published skill: one fetchable playbook for agent harnesses. */
api.get("/skill", async (c) => {
  const { AGENTPAY_SKILL_MD } = await import("./skill");
  return new Response(AGENTPAY_SKILL_MD, {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
});

api.get("/services", async (c) => {
  const q = c.req.query("q") ?? "";
  const limit = Number(c.req.query("limit")) || 25;
  const services = await listServices(c.env.DB, { q, limit });
  return c.json({
    services,
    registry: await registryAvailable(c.env.DB),
    note: "Listings come from the x402market registry. Pay a service with POST /agent/pay-service.",
  });
});

api.get("/services/:id", async (c) => {
  const service = await getService(c.env.DB, c.req.param("id"));
  if (!service) throw new HttpError(404, "Service not found");
  return c.json({ service });
});

api.get("/services/:id/quote", async (c) => {
  const tool = c.req.query("tool") ?? "";
  if (!tool) throw new HttpError(400, "tool query param is required");
  const quote = await quoteService(c.env.DB, c.req.param("id"), tool);
  return c.json({ quote });
});

// ---------- wallet (owner) ----------

api.post("/wallets", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; email?: unknown };
  const { wallet, token, recoveryCode } = await createWallet(c.env.DB, { name: body.name, email: body.email });
  return c.json(
    {
      wallet: publicWallet(wallet),
      token,
      recoveryCode,
      note: "Store the wallet token and recovery code now — both are shown only once. The recovery code resets the token if it is lost.",
    },
    201,
  );
});

api.post("/wallets/recover", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { walletId?: unknown; recoveryCode?: unknown };
  const result = await recoverWallet(c.env.DB, {
    walletId: cleanStr(body.walletId, 80),
    recoveryCode: cleanStr(body.recoveryCode, 80),
  });
  if (!result) throw new HttpError(401, "Unknown wallet id or recovery code");
  return c.json({
    wallet: publicWallet(result.wallet),
    token: result.token,
    note: "New wallet token issued. The previous token no longer works.",
  });
});

api.get("/wallets/me", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const [agents, ledger, receipts, approvals, plan] = await Promise.all([
    listAgents(c.env.DB, wallet.id),
    listLedger(c.env.DB, wallet.id, 25),
    listReceipts(c.env.DB, wallet.id, 10),
    listApprovals(c.env.DB, wallet.id, 12),
    getPlanState(c.env.DB, wallet.id, c.env),
  ]);
  const policies = await Promise.all(agents.map((a) => getAgentPolicy(c.env.DB, a.id)));
  return c.json({
    wallet: publicWallet(wallet),
    plan: publicPlan(plan),
    agents: agents.map((a, i) => publicAgent(a, policies[i])),
    ledger: ledger.map(publicLedger),
    receipts: receipts.map(publicReceipt),
    approvals: approvals.map(publicApproval),
    topup: { minCents: TOPUP_MIN_CENTS, maxCents: TOPUP_MAX_CENTS, presets: [...TOPUP_PRESETS] },
  });
});

api.post("/wallets/me/agents", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    dailyLimitCents?: unknown;
    approvalAboveCents?: unknown;
    allowedTools?: unknown;
  };
  const { agent, key } = await createAgent(c.env.DB, wallet.id, {
    name: body.name,
    dailyLimitCents: body.dailyLimitCents,
  });
  let policy: AgentPolicyRow | undefined;
  if (body.approvalAboveCents !== undefined || body.allowedTools !== undefined) {
    policy = await setAgentPolicy(c.env.DB, wallet.id, agent.id, {
      approvalAboveCents: body.approvalAboveCents,
      allowedTools: body.allowedTools,
    });
  }
  return c.json(
    {
      agent: publicAgent(agent, policy),
      key,
      note: "Store this agent key now — it is shown only once. Use it as Authorization: Bearer agp_…",
    },
    201,
  );
});

api.post("/wallets/me/agents/:id/revoke", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const ok = await revokeAgent(c.env.DB, wallet.id, c.req.param("id"));
  if (!ok) throw new HttpError(404, "Agent not found (or already revoked)");
  return c.json({ ok: true });
});

api.post("/wallets/me/agents/:id/rotate", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const result = await rotateAgentKey(c.env.DB, wallet.id, c.req.param("id"));
  if (!result) throw new HttpError(404, "Agent not found");
  return c.json(
    {
      agent: publicAgent(result.agent),
      key: result.key,
      note: "New key issued; the previous key is invalid immediately. Store it now — shown only once.",
    },
    201,
  );
});

api.patch("/wallets/me/agents/:id/policy", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { approvalAboveCents?: unknown; allowedTools?: unknown };
  const policy = await setAgentPolicy(c.env.DB, wallet.id, c.req.param("id"), {
    approvalAboveCents: body.approvalAboveCents,
    allowedTools: body.allowedTools,
  });
  return c.json({
    policy: publicPolicy(policy),
    note: "allowedTools entries look like serviceId:tool or serviceId:* (empty = all); generic spend needs \"spend\" or \"*\".",
  });
});

// ---------- approvals (owner) ----------

api.get("/wallets/me/approvals", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const limit = Number(c.req.query("limit")) || 25;
  return c.json({ approvals: (await listApprovals(c.env.DB, wallet.id, limit)).map(publicApproval) });
});

api.post("/wallets/me/approvals/:id/approve", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const approval = await decideApproval(c.env.DB, wallet.id, c.req.param("id"), true, cleanStr(body.reason, 200));
  c.executionCtx.waitUntil(notifyApprovalDecided(c.env, wallet.id, approval, true));
  return c.json({
    approval: publicApproval(approval),
    note: "Approved. The agent can now retry the purchase with this approvalId.",
  });
});

api.post("/wallets/me/approvals/:id/deny", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const approval = await decideApproval(c.env.DB, wallet.id, c.req.param("id"), false, cleanStr(body.reason, 200));
  c.executionCtx.waitUntil(notifyApprovalDecided(c.env, wallet.id, approval, false));
  return c.json({ approval: publicApproval(approval) });
});

api.post("/wallets/me/topup", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { amountCents?: unknown };
  const checkout = await createTopupCheckout(c.env, wallet, Number(body.amountCents), siteOrigin(c.req.raw));
  return c.json({ ...checkout, note: "Open this Stripe Checkout URL in a browser to pay." });
});

api.post("/wallets/me/topup/claim", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { sessionId?: unknown };
  const sessionId = cleanStr(body.sessionId, 120);
  if (!sessionId.startsWith("cs_")) throw new HttpError(400, "Missing Stripe Checkout session id (cs_…)");
  const result = await claimTopup(c.env, wallet, sessionId);
  return c.json(result);
});

// ---------- Pro plan (owner) ----------

api.post("/wallets/me/plan/checkout", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const plan = await getPlanState(c.env.DB, wallet.id, c.env);
  if (plan.active) {
    throw new HttpError(409, "This wallet is already on agentpay Pro — manage it in the billing portal.");
  }
  const checkout = await createSubscriptionCheckout(c.env, wallet, siteOrigin(c.req.raw));
  return c.json({
    ...checkout,
    note: "Open this Stripe Checkout URL in a browser to subscribe. Pro activates when the Stripe webhook confirms payment.",
  });
});

api.post("/wallets/me/plan/portal", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const session = await createBillingPortalSession(c.env, wallet, siteOrigin(c.req.raw));
  return c.json({ ...session, note: "Stripe-hosted portal: update payment method, cancel, or download invoices." });
});

/** Pro-only CSV export of receipts or ledger. */
api.get("/wallets/me/export.csv", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const plan = await getPlanState(c.env.DB, wallet.id, c.env);
  if (!plan.limits.exportCsv) {
    throw planLimitError("CSV export is a Pro feature — upgrade to export your receipts and ledger.", {
      plan: plan.id,
      priceCents: plan.priceCents,
    });
  }
  const kind = c.req.query("kind") === "ledger" ? "ledger" : "receipts";
  if (kind === "ledger") {
    const { results } = await c.env.DB
      .prepare(
        "SELECT created_at, kind, amount_cents, balance_after_cents, ref, meta_json, agent_id FROM ap_ledger WHERE wallet_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 5000",
      )
      .bind(wallet.id)
      .all<{ created_at: string; kind: string; amount_cents: number; balance_after_cents: number; ref: string; meta_json: string; agent_id: string | null }>();
    const csv = toCsv(
      ["created_at", "kind", "amount_cents", "balance_after_cents", "description", "service", "tool", "ref", "agent_id"],
      (results ?? []).map((r) => {
        const meta = parseJson<Record<string, string>>(r.meta_json, {});
        return [r.created_at, r.kind, r.amount_cents, r.balance_after_cents, meta.description ?? "", meta.service ?? "", meta.tool ?? "", r.ref, r.agent_id ?? ""];
      }),
    );
    return csvResponse(csv, `agentpay-ledger-${wallet.id}.csv`);
  }
  const { results } = await c.env.DB
    .prepare(
      "SELECT created_at, id, service, tool, description, amount_cents, currency, request_ref, agent_id FROM ap_receipts WHERE wallet_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 5000",
    )
    .bind(wallet.id)
    .all<{ created_at: string; id: string; service: string; tool: string; description: string; amount_cents: number; currency: string; request_ref: string; agent_id: string | null }>();
  const csv = toCsv(
    ["created_at", "receipt_id", "service", "tool", "description", "amount_cents", "currency", "request_ref", "agent_id"],
    (results ?? []).map((r) => [r.created_at, r.id, r.service, r.tool, r.description, r.amount_cents, r.currency, r.request_ref, r.agent_id ?? ""]),
  );
  return csvResponse(csv, `agentpay-receipts-${wallet.id}.csv`);
});

// ---------- alerts (webhook + email) ----------

function publicWebhook(hook: import("./notify").WebhookRow | null) {
  if (!hook) return null;
  return {
    url: hook.url,
    events: parseAlertEvents(hook.events_json),
    lowBalanceCents: hook.low_balance_cents,
    active: hook.active === 1,
    createdAt: hook.created_at,
    updatedAt: hook.updated_at,
    lastSuccessAt: hook.last_success_at,
    lastError: hook.last_error,
  };
}

api.get("/wallets/me/webhooks", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const [hook, deliveries] = await Promise.all([
    getWebhook(c.env.DB, wallet.id),
    listDeliveries(c.env.DB, wallet.id, 15),
  ]);
  return c.json({
    webhook: publicWebhook(hook),
    events: [...ALERT_EVENTS],
    emailConfigured: Boolean(c.env.RESEND_API_KEY),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      event: d.event,
      statusCode: d.status_code,
      error: d.error,
      deliveredAt: d.delivered_at,
      createdAt: d.created_at,
    })),
  });
});

api.put("/wallets/me/webhooks", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: unknown;
    events?: unknown;
    lowBalanceCents?: unknown;
  };
  if (!isValidWebhookUrl(body.url)) {
    throw new HttpError(400, "webhook url must be https:// (http://localhost is allowed for testing)");
  }
  const events = parseAlertEvents(body.events ?? ["approval_required", "low_balance"]);
  const low = Number(body.lowBalanceCents);
  const lowBalanceCents = Number.isFinite(low) && low >= 1 ? Math.min(low, 1_000_000) : lowBalanceDefault(c.env);
  const existed = await getWebhook(c.env.DB, wallet.id);
  const hook = await setWebhook(c.env.DB, wallet.id, { url: body.url as string, events, lowBalanceCents });
  return c.json({
    webhook: publicWebhook(hook),
    ...(existed ? {} : { secret: hook.secret }),
    note: existed
      ? "Webhook updated. Secret unchanged."
      : "Store this secret now — it signs deliveries (HMAC-SHA256 over `timestamp.body`) and is shown only once.",
  });
});

api.post("/wallets/me/webhooks/rotate", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const hook = await rotateWebhookSecret(c.env.DB, wallet.id);
  if (!hook) throw new HttpError(404, "No webhook registered");
  return c.json({
    webhook: publicWebhook(hook),
    secret: hook.secret,
    note: "New signing secret issued — the previous one stops verifying immediately.",
  });
});

api.delete("/wallets/me/webhooks", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const removed = await deleteWebhook(c.env.DB, wallet.id);
  return c.json({ removed });
});

api.post("/wallets/me/webhooks/test", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const result = await sendTestEvent(c.env, wallet.id);
  return c.json(result, result.ok ? 200 : 502);
});

api.post("/wallets/me/webhooks/redeliver", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  return c.json(await redeliverFailed(c.env, wallet.id));
});

// ---------- shareable spend reports (Pro) ----------

api.post("/wallets/me/reports", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const plan = await getPlanState(c.env.DB, wallet.id, c.env);
  if (!plan.limits.exportCsv) {
    throw planLimitError("Shareable spend reports are a Pro feature — upgrade to generate report links.", {
      plan: plan.id,
      priceCents: plan.priceCents,
    });
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: unknown;
    days?: unknown;
    expiresInDays?: unknown;
    includeReceipts?: unknown;
  };
  const link = await createReportLink(c.env.DB, wallet.id, body);
  return c.json(
    {
      report: publicReportLink(link),
      url: `${PUBLIC_SITE}${API_PREFIX}/reports/${link.token}`,
      note: "Anyone with this URL can view the report until it expires or is revoked.",
    },
    201,
  );
});

api.get("/wallets/me/reports", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const links = await listReportLinks(c.env.DB, wallet.id);
  return c.json({
    reports: links.map(publicReportLink),
    baseUrl: `${PUBLIC_SITE}${API_PREFIX}/reports/`,
  });
});

api.post("/wallets/me/reports/:token/revoke", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const revoked = await revokeReportLink(c.env.DB, wallet.id, c.req.param("token"));
  if (!revoked) throw new HttpError(404, "Report link not found");
  return c.json({ revoked: true });
});

/** Public report view: JSON for machines, HTML for humans. */
api.get("/reports/:token", async (c) => {
  const link = await getActiveReportLink(c.env.DB, c.req.param("token"));
  if (!link) throw new HttpError(404, "Report link not found, revoked, or expired");
  c.executionCtx.waitUntil(touchReportLink(c.env.DB, link.token));
  const report = await buildReport(c.env.DB, link.wallet_id, {
    days: link.days,
    includeReceipts: link.include_receipts === 1,
  });
  const wantsHtml = (c.req.header("accept") ?? "").includes("text/html");
  if (wantsHtml) return c.html(renderReportHtml(report, link.label));
  return c.json({ report, link: { label: link.label, days: link.days, expiresAt: link.expires_at } });
});

function publicReportLink(link: import("./reports").ReportLinkRow) {
  return {
    token: link.token,
    label: link.label,
    days: link.days,
    includeReceipts: link.include_receipts === 1,
    revoked: link.revoked === 1,
    expiresAt: link.expires_at,
    createdAt: link.created_at,
    views: link.views,
    lastViewedAt: link.last_viewed_at,
  };
}

// ---------- proof-of-spend attestations ----------

async function issueAttestation(c: ApiContext, walletId: string): Promise<Response> {
  const body = (await c.req.json().catch(() => ({}))) as { days?: unknown; sub?: unknown };
  const days = clampAttestationDays(body.days);
  const sub = cleanStr(body.sub, 120);
  const attestation = await buildAttestation(c.env.DB, walletId, days, sub ? { sub } : {});
  if (!attestation) throw new HttpError(400, "No settled payments in this window — nothing to attest yet");
  const signed = await signAttestation(c.env, attestation);
  if (!signed) assertSigningConfigured();
  return c.json(signedAttestationResponse(attestation, signed, `${PUBLIC_SITE}${API_PREFIX}`));
}

api.post("/wallets/me/attestations", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  return issueAttestation(c, wallet.id);
});

api.post("/agent/attestation", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  return issueAttestation(c, wallet.id);
});

/** Public key for offline verification of attestations. */
api.get("/attestations/key", async (c) => {
  const key = await attestationPublicKey(c.env);
  if (!key) throw new HttpError(503, "Attestation signing is not configured");
  return c.json({
    issuer: ATTESTATION_ISSUER,
    alg: key.alg,
    keyId: key.keyId,
    publicJwk: key.publicJwk,
    note: "Verify ECDSA P-256 / SHA-256 (raw P1363, base64url) over the canonical JSON (sorted keys) of `attestation`.",
  });
});

/** Verify an attestation against this issuer's key. */
api.post("/attestations/verify", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    attestation?: Attestation;
    signature?: unknown;
    keyId?: unknown;
  };
  if (!body.attestation || typeof body.signature !== "string") {
    throw new HttpError(400, "attestation and signature are required");
  }
  const key = await attestationPublicKey(c.env);
  if (!key) throw new HttpError(503, "Attestation signing is not configured");
  const valid = await verifyAttestation(key.publicJwk, body.attestation, body.signature);
  const expired = Boolean(body.attestation.expiresAt && body.attestation.expiresAt <= nowIso());
  return c.json({
    valid,
    keyId: key.keyId,
    keyIdMatches: typeof body.keyId === "string" ? body.keyId === key.keyId : null,
    issuer: ATTESTATION_ISSUER,
    expired,
    wallet: body.attestation.wallet ?? null,
    metrics: valid ? body.attestation.metrics ?? null : null,
  });
});

// ---------- agent (scoped key) ----------

api.get("/agent/me", async (c) => {
  const { agent, wallet } = await requireAgent(c.req.raw, c.env.DB);
  const plan = await getPlanState(c.env.DB, wallet.id, c.env);
  return c.json({ wallet: publicWallet(wallet), plan: publicPlan(plan), agent: publicAgent(agent) });
});

/** Upgrade link an agent can hand to the wallet owner (same flow as the dashboard). */
api.post("/agent/plan-link", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const plan = await getPlanState(c.env.DB, wallet.id, c.env);
  if (plan.active) {
    return c.json({ alreadyPro: true, plan: publicPlan(plan), note: "This wallet is already on agentpay Pro." });
  }
  const checkout = await createSubscriptionCheckout(c.env, wallet, siteOrigin(c.req.raw));
  return c.json({
    ...checkout,
    plan: plan.id,
    note: "Hand this URL to the human who owns the wallet. Pro activates when Stripe confirms the subscription.",
  });
});

// ---------- sub-agents (delegation) ----------

/** Mint a scoped child key: its own budget, expiry, daily limit, and allowlist. */
api.post("/agent/subagents", async (c) => {
  const { agent } = await requireAgent(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    budgetCents?: unknown;
    dailyLimitCents?: unknown;
    expiresInMinutes?: unknown;
    allowedTools?: unknown;
    approvalAboveCents?: unknown;
  };
  const { agent: child, key, subagent } = await createSubagent(c.env.DB, agent, {
    name: body.name,
    budgetCents: body.budgetCents,
    dailyLimitCents: body.dailyLimitCents,
    expiresInMinutes: body.expiresInMinutes,
    allowedTools: body.allowedTools,
    approvalAboveCents: body.approvalAboveCents,
  });
  return c.json(subagentCreated(child, subagent, key), 201);
});

/** Wallet-auth variant for the dashboard (the agent key is not available there). */
api.post("/wallets/me/agents/:id/subagents", async (c) => {
  const wallet = await requireWallet(c.req.raw, c.env.DB);
  const parent = await getAgentForWallet(c.env.DB, wallet.id, c.req.param("id"));
  if (!parent || parent.active !== 1) throw new HttpError(404, "Agent not found (or revoked)");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    budgetCents?: unknown;
    dailyLimitCents?: unknown;
    expiresInMinutes?: unknown;
    allowedTools?: unknown;
    approvalAboveCents?: unknown;
  };
  const { agent: child, key, subagent } = await createSubagent(c.env.DB, parent, {
    name: body.name,
    budgetCents: body.budgetCents,
    dailyLimitCents: body.dailyLimitCents,
    expiresInMinutes: body.expiresInMinutes,
    allowedTools: body.allowedTools,
    approvalAboveCents: body.approvalAboveCents,
  });
  return c.json(subagentCreated(child, subagent, key), 201);
});

api.get("/agent/subagents", async (c) => {
  const { agent } = await requireAgent(c.req.raw, c.env.DB);
  const children = await listSubagents(c.env.DB, agent.id);
  const policies = await Promise.all(children.map((a) => getAgentPolicy(c.env.DB, a.id)));
  return c.json({ subagents: children.map((a, i) => publicAgent(a, policies[i])) });
});

api.post("/agent/subagents/:id/revoke", async (c) => {
  const { agent } = await requireAgent(c.req.raw, c.env.DB);
  const child = await getSubagent(c.env.DB, c.req.param("id"));
  if (!child || child.parent_agent_id !== agent.id) {
    throw new HttpError(404, "Sub-agent not found for this parent");
  }
  await revokeAgent(c.env.DB, agent.wallet_id, child.agent_id);
  return c.json({ ok: true, note: "Sub-agent revoked immediately." });
});

api.post("/agent/spend", async (c) => {
  const { agent, wallet } = await requireAgent(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    amountCents?: unknown;
    description?: unknown;
    service?: unknown;
    tool?: unknown;
    ref?: unknown;
    approvalId?: unknown;
  };
  const amountCents = Number(body.amountCents);
  const description = cleanStr(body.description, 200);
  const serviceLabel = cleanStr(body.service, 80);
  const toolLabel = cleanStr(body.tool, 80);
  const ref = cleanStr(body.ref, 120);
  const gate = await gateSpend(c, {
    wallet,
    agent,
    amountCents,
    description,
    ref,
    approvalId: cleanStr(body.approvalId, 80),
    serviceLabel,
    toolLabel,
  });
  if (gate && "response" in gate) return gate.response;
  if (gate && "consume" in gate) {
    await consumeGate(c, {
      walletId: wallet.id,
      agentId: agent.id,
      approvalId: cleanStr(body.approvalId, 80),
      amountCents,
      service: serviceLabel,
      tool: toolLabel,
    });
  }
  let result;
  try {
    result = await spend(c.env.DB, {
      walletId: wallet.id,
      agent,
      amountCents,
      description,
      service: serviceLabel,
      tool: toolLabel,
      ref,
    });
  } catch (err) {
    if (err instanceof HttpError && err.payload?.code === "subagent_budget" && agent.parent_agent_id) {
      c.executionCtx.waitUntil(
        notifyBudgetExhausted(c.env, wallet.id, {
          agentName: agent.name,
          budgetCents: agent.sub_budget_cents ?? 0,
        }),
      );
    }
    throw err;
  }
  c.executionCtx.waitUntil(afterSpend(c, wallet, result));
  return c.json({
    receipt: publicReceipt(result.receipt),
    balanceCents: result.balanceCents,
    agentSpentTodayCents: result.agentSpentTodayCents,
  });
});

api.post("/agent/topup-link", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { amountCents?: unknown };
  const checkout = await createTopupCheckout(c.env, wallet, Number(body.amountCents), siteOrigin(c.req.raw));
  return c.json({
    ...checkout,
    note: "Hand this URL to the human who funds the wallet; they pay in a browser.",
  });
});

api.post("/agent/pay-service", async (c) => {
  const { agent, wallet } = await requireAgent(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    serviceId?: unknown;
    tool?: unknown;
    params?: unknown;
    amountCents?: unknown;
    description?: unknown;
    ref?: unknown;
    approvalId?: unknown;
    bountyAccount?: unknown;
    dryRun?: unknown;
  };
  const serviceId = cleanStr(body.serviceId, 80);
  const toolName = cleanStr(body.tool, 80);
  if (!serviceId || !toolName) throw new HttpError(400, "serviceId and tool are required");
  const service = await getService(c.env.DB, serviceId);
  if (!service) throw new HttpError(404, "Service not found");
  const tool = service.tools.find((t) => t.name === toolName);
  if (!tool) throw new HttpError(404, "Tool not found on this service");
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const description = cleanStr(body.description, 200) || `pay_service ${service.name}/${tool.name}`;
  const ref = cleanStr(body.ref, 120);

  // Free tools: call straight through, no debit.
  if (!tool.paid) {
    const res = await callServiceTool(service, tool, { params });
    return c.json({ settlement: "free", seller: await sellerResponse(res) });
  }

  // 1. Live 402 challenge from the seller.
  const quote = await quoteService(c.env.DB, serviceId, toolName);
  const requirements = parseBsvRequirements(quote.requirements);
  const { resolveSatsPerCent } = await import("./price");
  const quoteRate = await resolveSatsPerCent(
    c.env,
    c.env.DB,
    Number(String(c.env.X402_SATS_PER_CENT ?? "")) || 0 || 40_000,
  );
  const amountCents = chargeCentsFor(requirements.satoshis, c.env, body.amountCents, quoteRate.perCent);

  // 1b. Two-way trust (work -> spend): reputation fast-paths approval x2.
  // Read-only, fail closed. Mode defaults to log-only for 3 days.
  const trustMode = trustPayMode(c.env);
  const suppliedAccount =
    typeof body.bountyAccount === "number" && Number.isFinite(body.bountyAccount) ? Math.floor(body.bountyAccount) : null;
  // Binding: supplied account honored only if linked to this wallet.
  const bountyAccount = trustMode === "off" ? null : await resolveBountyAccount(c.env.DB, wallet.id, suppliedAccount);
  const reputation = await fetchReputation(c.env, bountyAccount);
  const trustDecision = decidePayTrust(reputation);
  const trustApplied = trustMode === "enforce" && trustDecision.fastPath;
  const basePolicy = await getAgentPolicy(c.env.DB, agent.id);
  const effectiveThreshold = trustApplied
    ? applyTrustMultiplier(basePolicy.approval_above_cents, trustDecision)
    : basePolicy.approval_above_cents;
  const trust = {
    mode: trustMode,
    fastPath: trustDecision.fastPath,
    applied: trustApplied,
    reason: trustDecision.reason,
    reputation: trustDecision.reputation,
    baseThreshold: basePolicy.approval_above_cents,
    effectiveThreshold,
    discountEligible: trustDecision.fastPath,
  };

  // 1c. Sandbox dry-run: quote + policy evaluation, zero side effects.
  // No debit, no approval row, no settlement — for devs validating pricing.
  const approvalId = cleanStr(body.approvalId, 80);
  if (body.dryRun === true) {
    return c.json({
      dryRun: true,
      quote,
      satoshis: requirements.satoshis,
      payTo: requirements.payTo,
      chargedCents: amountCents,
      listPriceSats: tool.priceSats,
      wouldRequireApproval:
        effectiveThreshold !== null && amountCents >= effectiveThreshold && !approvalId,
      trust,
      note: "Dry run — nothing was debited or settled. Omit dryRun to execute.",
    });
  }

  // 1d. Scope + approval gate (no funds move until this passes).
  const gate = await gateSpend(c, {
    wallet,
    agent,
    amountCents,
    description,
    ref,
    approvalId,
    serviceId,
    toolName,
    serviceLabel: service.name,
    toolLabel: tool.name,
    thresholdOverride: effectiveThreshold,
  });
  if (gate && "response" in gate) {
    // Enrich approval_required with trust context (still 402).
    const payload = (await gate.response.json().catch(() => null)) as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      return c.json({ ...payload, trust }, 402);
    }
    return gate.response;
  }

  // 2. BSV rail: sign first (503 before any charge if unfunded), debit, then settle.
  if (siteWalletConfigured(c.env)) {
    const prepared = await prepareBsvPayment(c.env, requirements);
    if (gate && "consume" in gate) {
      await consumeGate(c, {
        walletId: wallet.id,
        agentId: agent.id,
        approvalId,
        amountCents,
        service: service.name,
        tool: tool.name,
      });
    }
    const charged = await spend(c.env.DB, {
      walletId: wallet.id,
      agent,
      amountCents,
      description,
      service: service.name,
      tool: tool.name,
      ref,
      meta: {
        settlement: "bsv",
        payTo: requirements.payTo,
        satoshis: requirements.satoshis,
        satsPerCent: quoteRate.perCent,
        priceSource: quoteRate.source,
        txid: prepared.txid,
      },
    });

    let res: Response;
    // Bound trust attestation for seller discounts (Phase E): minted with
    // sub=payer so the seller can verify binding. Best-effort, never blocks.
    let trustAttestation: string | null = null;
    try {
      const { buildAttestation, signAttestation } = await import("./attestations");
      const att = await buildAttestation(c.env.DB, wallet.id, 30, { sub: prepared.payer });
      if (att) {
        const signed = await signAttestation(c.env, att);
        if (signed) {
          const env = { attestation: att, signature: signed.signature, keyId: signed.keyId };
          trustAttestation = btoa(JSON.stringify(env))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        }
      }
    } catch {
      trustAttestation = null;
    }
    try {
      res = await callServiceTool(service, tool, {
        params,
        paymentSignature: prepared.paymentSignature,
        trustAttestation,
      });
    } catch (e) {
      await refundSpend(c.env.DB, {
        walletId: wallet.id,
        agentId: agent.id,
        amountCents,
        ref: `refund:${charged.receipt.id}`,
        description: "x402 seller unreachable",
        receiptId: charged.receipt.id,
      });
      throw new HttpError(502, `Seller unreachable after signing payment: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }

    const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
    const seller = await sellerResponse(res);
    const settled = seller.status < 400 || Boolean(paymentResponse);
    if (!settled) {
      await refundSpend(c.env.DB, {
        walletId: wallet.id,
        agentId: agent.id,
        amountCents,
        ref: `refund:${charged.receipt.id}`,
        description: `x402 seller rejected (${seller.status})`,
        receiptId: charged.receipt.id,
      });
      throw new HttpError(
        seller.status === 402 ? 402 : 502,
        `Seller rejected x402 payment (${seller.status}): ${seller.body.slice(0, 200)}`,
      );
    }

    // Replay guard: a seller that returns an already-settled txid cannot charge twice.
    const claimed = await claimX402Txid(c.env.DB, {
      txid: prepared.txid,
      walletId: wallet.id,
      service: service.name,
      tool: tool.name,
      receiptId: charged.receipt.id,
    });
    if (!claimed) {
      await refundSpend(c.env.DB, {
        walletId: wallet.id,
        agentId: agent.id,
        amountCents,
        ref: `refund:${charged.receipt.id}`,
        description: "duplicate x402 txid (seller replay)",
        receiptId: charged.receipt.id,
      });
      throw new HttpError(502, "Seller returned an already-settled txid — the debit was refunded");
    }

    c.executionCtx.waitUntil(afterSpend(c, wallet, charged));
    c.executionCtx.waitUntil(
      treasuryStatus(c.env.DB, c.env)
        .then((t) => maybeAlertTreasury(c.env, c.env.DB, t))
        .catch(() => {}),
    );
    return c.json({
      receipt: publicReceipt(charged.receipt),
      balanceCents: charged.balanceCents,
      agentSpentTodayCents: charged.agentSpentTodayCents,
      settlement: "bsv",
      network: "bsv:mainnet",
      txid: prepared.txid,
      satoshis: requirements.satoshis,
      listPriceSats: tool.priceSats,
      discountSats: Math.max(0, tool.priceSats - requirements.satoshis),
      payTo: requirements.payTo,
      chargedCents: amountCents,
      paymentResponse: paymentResponse ? safeParseB64(paymentResponse) : null,
      seller,
      trust,
    });
  }

  // 3. No BSV rail configured: internal wallet settlement only.
  if (gate && "consume" in gate) {
    await consumeGate(c, {
      walletId: wallet.id,
      agentId: agent.id,
      approvalId,
      amountCents,
      service: service.name,
      tool: tool.name,
    });
  }
  const result = await spend(c.env.DB, {
    walletId: wallet.id,
    agent,
    amountCents,
    description,
    service: service.name,
    tool: tool.name,
    ref,
    meta: { settlement: "wallet", toolPriceSats: tool.priceSats, network: service.network },
  });
  c.executionCtx.waitUntil(afterSpend(c, wallet, result));
  return c.json({
    receipt: publicReceipt(result.receipt),
    balanceCents: result.balanceCents,
    agentSpentTodayCents: result.agentSpentTodayCents,
    quote,
    settlement: "wallet",
    note: "Site wallet WIF is not configured, so no on-chain payment was made. Configure SITE_WALLET_WIF to settle x402 challenges.",
    trust,
  });
});

api.get("/agent/transactions", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const limit = Number(c.req.query("limit")) || 25;
  const ledger = await listLedger(c.env.DB, wallet.id, limit);
  return c.json({ balanceCents: wallet.balance_cents, transactions: ledger.map(publicLedger) });
});

api.get("/agent/receipts/:id", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const receipt = await getReceipt(c.env.DB, wallet.id, c.req.param("id"));
  if (!receipt) throw new HttpError(404, "Receipt not found");
  return c.json({ receipt: publicReceipt(receipt) });
});

// ---------- BSVBounties bridge (earn side) ----------
//
// Agents browse and claim work through their agentpay key. Claims are linked
// to the wallet so bsv-bounties' settle event can credit the balance.

api.get("/bounties", async (c) => {
  const limit = Number(c.req.query("limit") ?? 25);
  const offset = Number(c.req.query("offset") ?? 0);
  const payload = await listBounties(c.env, {
    status: c.req.query("status") ?? "open",
    category: c.req.query("category"),
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 25,
    offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
  });
  return c.json(payload);
});

api.get("/bounties/:id", async (c) => {
  const payload = await getBounty(c.env, c.req.param("id"));
  return c.json(payload);
});

api.post("/bounties/:id/claim", async (c) => {
  const { agent, wallet } = await requireAgent(c.req.raw, c.env.DB);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    payoutAddress?: unknown;
    workerAccount?: unknown;
    workerPubKey?: unknown;
  };
  const payoutAddress =
    typeof body.payoutAddress === "string" ? body.payoutAddress.trim() : null;
  if (payoutAddress && !isValidBsvAddress(payoutAddress)) {
    throw new HttpError(400, "payoutAddress is not a valid BSV P2PKH address");
  }
  const workerAccount =
    typeof body.workerAccount === "number" && Number.isFinite(body.workerAccount)
      ? Math.floor(body.workerAccount)
      : null;
  const workerPubKey = cleanStr(body.workerPubKey, 120);
  const workerRef = workerRefFor(wallet.id);
  const claim = await claimBountyRemote(c.env, id, workerRef, {
    workerPubKey: workerPubKey || undefined,
    workerAccount: workerAccount ?? undefined,
  });
  const record = bountyRecord(claim);
  const link = await linkBounty(c.env.DB, {
    bountyId: id,
    walletId: wallet.id,
    agentId: agent.id,
    workerRef,
    workerAccount,
    workerPubkey: workerPubKey || null,
    title: cleanStr(record?.title, 120),
    amountSats: typeof record?.amountSats === "number" ? record.amountSats : null,
    payoutAddress,
  });
  return c.json({ claim, link, payout: bountyPayoutInfo(c.env) });
});

api.post("/bounties/:id/submit", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const id = c.req.param("id");
  const link = await getLink(c.env.DB, id);
  if (!link || link.wallet_id !== wallet.id) {
    throw new HttpError(403, "Claim this bounty through agentpay before submitting work");
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await submitWorkRemote(c.env, id, {
    workHash: typeof body.workHash === "string" ? body.workHash : undefined,
    workUri: typeof body.workUri === "string" ? body.workUri : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    milestoneIndex: typeof body.milestoneIndex === "number" ? body.milestoneIndex : undefined,
  });
  await touchLinkStatus(c.env.DB, id, "submitted");
  return c.json(result);
});

/** Post a bounty funded from the wallet balance, escrowed on-chain. */
api.post("/agent/bounties", async (c) => {
  const { agent, wallet } = await requireAgent(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await postFundedBounty(c.env.DB, c.env, {
    wallet,
    agent,
    title: typeof body.title === "string" ? body.title : "",
    description: typeof body.description === "string" ? body.description : "",
    category: typeof body.category === "string" ? body.category : undefined,
    amountSats: typeof body.amountSats === "number" ? body.amountSats : 0,
    deadline: typeof body.deadline === "number" ? body.deadline : undefined,
    payoutAddress: typeof body.payoutAddress === "string" ? body.payoutAddress : null,
  });
  c.executionCtx.waitUntil(
    treasuryStatus(c.env.DB, c.env)
      .then((t) => maybeAlertTreasury(c.env, c.env.DB, t))
      .catch(() => {}),
  );
  return c.json({ ...result, payout: bountyPayoutInfo(c.env) }, 201);
});

/** Agentpay-funded escrows for this wallet (status, txids, pending errors). */
api.get("/agent/bounties/escrows", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const rows = await listEscrowRows(c.env.DB, wallet.id);
  return c.json({ escrows: rows.map(publicEscrow) });
});

/** Poster decides an agentpay-funded bounty; the settle event pays out on-chain. */
api.post("/agent/bounties/:id/settle", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { outcome?: unknown };
  const outcome = body.outcome === "refunded" ? "refunded" : body.outcome === "paid" ? "paid" : null;
  if (!outcome) throw new HttpError(400, "outcome must be 'paid' or 'refunded'");
  const result = await settleFundedBounty(c.env.DB, c.env, {
    walletId: wallet.id,
    bountyId: c.req.param("id"),
    outcome,
  });
  return c.json(result);
});

/** Retry a payout/refund blocked by a missing address or a broadcast hiccup. */
api.post("/agent/bounties/:id/retry", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const result = await retryFundedBounty(c.env.DB, c.env, {
    walletId: wallet.id,
    bountyId: c.req.param("id"),
  });
  return c.json(result);
});

api.get("/agent/bounties", async (c) => {
  const { wallet } = await requireAgent(c.req.raw, c.env.DB);
  const links = await listLinks(c.env.DB, wallet.id);
  return c.json({ bounties: links });
});

/** Settle callback from bsv-bounties (server-to-server, shared secret). */
api.post("/internal/bounty-event", async (c) => {
  const secret = c.env.BOUNTIES_WEBHOOK_SECRET;
  const provided = c.req.header("x-agentpay-internal") ?? "";
  if (!secret || !provided || !timingSafeEqualStr(provided, secret)) {
    throw new HttpError(401, "unauthorized");
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const bountyId = cleanStr(body.bountyId, 200);
  if (!bountyId) throw new HttpError(400, "bountyId is required");
  const result = await handleBountyEvent(c.env.DB, c.env, {
    bountyId,
    outcome: cleanStr(body.outcome, 20) || "paid",
    amountSats: typeof body.amountSats === "number" ? body.amountSats : undefined,
    workerPubKey: typeof body.workerPubKey === "string" ? body.workerPubKey : undefined,
    workerAccount: typeof body.workerAccount === "number" ? body.workerAccount : undefined,
    settleTxid: typeof body.settleTxid === "string" ? body.settleTxid : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
    category: typeof body.category === "string" ? body.category : undefined,
    funding: typeof body.funding === "string" ? body.funding : null,
    posterRef: typeof body.posterRef === "string" ? body.posterRef : null,
  });
  return c.json(result);
});

// ---------- Stripe webhook ----------

api.post("/webhooks/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !c.env.STRIPE_SECRET_KEY) throw new HttpError(503, "Stripe is not configured");
  const signature = c.req.header("stripe-signature");
  if (!signature) throw new HttpError(400, "Missing stripe-signature");
  const payload = await c.req.text();
  const stripe = stripeClient(c.env);
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid signature";
    throw new HttpError(400, `Webhook signature failed: ${message}`);
  }
  c.executionCtx.waitUntil(handleStripeEvent(c.env, event));
  return c.json({ received: true });
});
