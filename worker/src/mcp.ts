/**
 * Remote agentpay MCP — Streamable HTTP at /api/agentpay/mcp.
 *
 * Tools call the Hono API in-process, so auth and ledger rules live in one
 * place. Agent keys ride either the MCP request's Authorization header or a
 * per-tool `key` parameter (for clients that cannot set headers).
 */
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { api } from "./api";
import { bearerToken } from "./auth";
import { API_PREFIX, APP_PREFIX, MCP_PATH, PUBLIC_SITE, isMcpPath } from "./paths";
import type { AppEnv } from "./types";
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from "./stripe";

export const MCP_NAME = "agentpay";
export const MCP_VERSION = "0.1.0";

export const MCP_TOOLS = [
  "health",
  "get_balance",
  "create_topup_link",
  "create_upgrade_link",
  "mint_subagent",
  "list_subagents",
  "revoke_subagent",
  "get_attestation",
  "list_services",
  "service_quote",
  "spend",
  "pay_service",
  "get_receipt",
  "list_transactions",
  "list_bounties",
  "get_bounty",
  "claim_bounty",
  "submit_work",
  "my_bounties",
  "post_bounty",
  "settle_bounty",
  "my_escrows",
] as const;

export const MCP_INSTRUCTIONS = [
  "agentpay is a prepaid USD wallet for AI agents on Cloudflare.",
  "Human dashboard: https://entangleit.com/agentpay/ (create a wallet, top up with a card via Stripe, mint agent keys).",
  "Agents authenticate with a scoped key (agp_…). Pass it as the Authorization: Bearer header on this MCP connection, or as the `key` parameter on a tool call.",
  "Public tools: list_services and service_quote read the x402market registry (paid x402/BSV APIs) and live 402 challenges.",
  "Wallet tools: get_balance, list_transactions, get_receipt.",
  "Spending: spend debits the wallet and writes a receipt. pay_service quotes the seller, settles the BSV x402 challenge from the site wallet, and returns the seller's result — all in one call.",
  "pay_service takes params (tool arguments) and optional amountCents. amountCents defaults to a 1-cent minimum unless the operator configured X402_SATS_PER_CENT.",
  "Per-agent policy: allowedTools restricts pay_service to entries like serviceId:tool or serviceId:* (empty = all); generic spend needs the \"spend\" entry. approvalAboveCents makes spends at/above that amount return 402 approval_required with approvalId + approvalUrl — a human approves in the dashboard, then retry with approvalId.",
  "Plans: wallets start on Free (3 agent keys, daily limits up to $50/agent). Pro ($29/mo) raises that to 25 keys, $1,000/agent daily limits, and CSV export. A plan_limit error includes upgradeUrl; create_upgrade_link returns a Stripe Checkout URL to hand to the human who owns the wallet.",
  "Delegation: a top-level agent can mint_subagent for each worker with its own lifetime budget, expiry, daily limit, and allowlist — then list_subagents and revoke_subagent. Budget-exhausted or expired child keys fail closed with code subagent_budget or subagent_expired.",
  "Reputation: get_attestation returns an agentpay-signed summary of the wallet's settled activity. Sellers verify it at /attestations/verify (or with the public key at /attestations/key) to price trust — for example, a discount for wallets with a proven payment history.",
  "Earning: list_bounties and get_bounty browse paid work on the BSVBounties marketplace. claim_bounty links a bounty to this wallet (pass payoutAddress to receive sats on-chain instead of a balance credit); submit_work submits it; my_bounties lists your claims. When a linked bounty settles, the reward is credited to your wallet balance (idempotent) so you can spend it on x402 services — earn and spend from one key.",
  "Posting: post_bounty funds a new listing from your wallet balance and escrows the sats on-chain from the treasury to a per-bounty key; my_escrows tracks funding, payout, and refund txids. As poster you decide with settle_bounty (outcome paid or refunded): paid spends the escrow to the worker (net of the platform fee) and refunded returns it to the treasury and credits your balance back.",
  "When the balance is low, call create_topup_link (or pay_service will fail with 402) and hand the Stripe Checkout URL to a human — agents cannot pay by card themselves.",
].join("\n");

type ToolResult = {
  isError?: boolean;
  content: { type: "text"; text: string }[];
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(status: number, json: unknown, text?: string): ToolResult {
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const error =
    body && "error" in body ? String(body.error) : text?.slice(0, 300) || `HTTP ${status}`;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ status, ...(body ?? {}), error }) }] };
}

async function apiCall(
  env: AppEnv,
  ctx: ExecutionContext,
  origin: string,
  method: string,
  path: string,
  opts: { key?: string | null; body?: unknown } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const headers = new Headers({ accept: "application/json" });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.key) headers.set("authorization", `Bearer ${opts.key}`);
  const req = new Request(`${origin}${API_PREFIX}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await api.fetch(req, env, ctx);
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  let json: unknown = null;
  if (ct.includes("json") && text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json, text };
}

const keyField = z
  .string()
  .optional()
  .describe("Agent key (agp_…). Optional when the MCP connection sends Authorization: Bearer.");

export function createAgentPayMcpServer(
  env: AppEnv,
  ctx: ExecutionContext,
  origin: string,
  connectionKey: string | null,
): McpServer {
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION }, { instructions: MCP_INSTRUCTIONS });

  const call = (method: string, path: string, opts?: { key?: string | null; body?: unknown }) =>
    apiCall(env, ctx, origin, method, path, { key: opts?.key || connectionKey, body: opts?.body });

  server.registerTool(
    "health",
    { title: "Health", description: "Check that the agentpay API and MCP are up." },
    async () => {
      const { status, json } = await call("GET", "/health");
      if (status >= 400) return fail(status, json);
      return ok({
        ...((json as object) ?? {}),
        dashboard: `${PUBLIC_SITE}${APP_PREFIX}/`,
        mcp: `${PUBLIC_SITE}${MCP_PATH}`,
      });
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get balance",
      description: "Wallet balance, agent identity, and daily limit status for the current agent key.",
      inputSchema: z.object({ key: keyField }),
    },
    async ({ key }) => {
      const { status, json } = await call("GET", "/agent/me", { key });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "create_topup_link",
    {
      title: "Create top-up link",
      description: `Create a Stripe Checkout URL that a human opens to fund the wallet. Amount between ${TOPUP_MIN_CENTS} and ${TOPUP_MAX_CENTS} cents USD.`,
      inputSchema: z.object({
        amountCents: z.number().int().describe("Top-up amount in USD cents, e.g. 2000 = $20"),
        key: keyField,
      }),
    },
    async ({ amountCents, key }) => {
      const { status, json } = await call("POST", "/agent/topup-link", { key, body: { amountCents } });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "create_upgrade_link",
    {
      title: "Create upgrade link",
      description:
        "Create a Stripe Checkout URL to upgrade the wallet to agentpay Pro (more agent keys, higher daily limits, CSV export). Hand the URL to the human who owns the wallet.",
      inputSchema: z.object({ key: keyField }),
    },
    async ({ key }) => {
      const { status, json } = await call("POST", "/agent/plan-link", { key });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List paid services",
      description:
        "Browse the x402market registry of pay-per-call services for agents. Public — no key needed. Returns tools, network, payTo, and per-tool price in sats.",
      inputSchema: z.object({
        q: z.string().optional().describe("Search text"),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ q, limit }) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString();
      const { status, json } = await call("GET", `/services${qs ? `?${qs}` : ""}`);
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "service_quote",
    {
      title: "Quote a service",
      description:
        "Call a registry tool unsigned and return the live 402 payment requirements (price/payTo). Public — no key needed. Pass bountyAccount optionally to include a trust hint (discount eligibility) without changing the price.",
      inputSchema: z.object({
        serviceId: z.string().describe("Registry service id (from list_services)"),
        tool: z.string().describe("Tool name on that service"),
        bountyAccount: z.number().int().positive().optional().describe("BSVBounties account # for trust hint"),
      }),
    },
    async ({ serviceId, tool, bountyAccount }) => {
      const { status, json } = await call(
        "GET",
        `/services/${encodeURIComponent(serviceId)}/quote?tool=${encodeURIComponent(tool)}`,
      );
      if (status >= 400) return fail(status, json);
      // Trust hint is advisory only; quote price is unchanged (public semantics preserved).
      const out = json as Record<string, unknown>;
      if (typeof bountyAccount === "number") {
        out.trust_hint = {
          bountyAccount,
          note: "Pass bountyAccount to pay_service for reputation fast-path (approval x2) and seller discount eligibility.",
        };
      }
      return ok(out);
    },
  );

  server.registerTool(
    "spend",
    {
      title: "Spend from wallet",
      description:
        "Debit the wallet and mint a receipt. Fails with 402 when balance or the agent daily limit is insufficient — respond by calling create_topup_link.",
      inputSchema: z.object({
        amountCents: z.number().int().min(1).describe("Amount in USD cents"),
        description: z.string().min(1).max(200),
        service: z.string().optional().describe("Optional service label"),
        tool: z.string().optional().describe("Optional tool label"),
        ref: z.string().optional().describe("Idempotency-ish external reference"),
        approvalId: z.string().optional().describe("Approval id from a prior approval_required response"),
        key: keyField,
      }),
    },
    async ({ amountCents, description, service, tool, ref, approvalId, key }) => {
      const { status, json } = await call("POST", "/agent/spend", {
        key,
        body: { amountCents, description, service, tool, ref, approvalId },
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "pay_service",
    {
      title: "Pay a service",
      description:
        "One call for paid registry tools: quotes the seller's x402 challenge, pays it from the site wallet on BSV mainnet, debits the agent wallet, and returns the seller's result plus txid. If the seller rejects the payment, the debit is refunded. Pass bountyAccount for reputation fast-path (approval x2 when score>=650).",
      inputSchema: z.object({
        serviceId: z.string().describe("Registry service id (from list_services)"),
        tool: z.string().describe("Tool name on that service"),
        params: z.record(z.string(), z.unknown()).optional().describe("Tool arguments (body for POST, query for GET)"),
        amountCents: z.number().int().min(1).optional().describe("Override the USD cents charged (min 1 cent default)"),
        description: z.string().max(200).optional(),
        ref: z.string().optional(),
        approvalId: z.string().optional().describe("Approval id from a prior approval_required response"),
        bountyAccount: z.number().int().positive().optional().describe("BSVBounties account # for trust fast-path"),
        dryRun: z.boolean().optional().describe("Sandbox: quote + policy check only, no debit or settlement"),
        key: keyField,
      }),
    },
    async ({ serviceId, tool, params, amountCents, description, ref, approvalId, bountyAccount, dryRun, key }) => {
      const { status, json } = await call("POST", "/agent/pay-service", {
        key,
        body: { serviceId, tool, params, amountCents, description, ref, approvalId, bountyAccount, dryRun },
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "mint_subagent",
    {
      title: "Mint a sub-agent",
      description:
        "Delegate a scoped child key for a worker: its own lifetime budget (cents), expiry (minutes), daily limit, and tool allowlist. Only top-level agents can delegate. The child can spend only within its budget/expiry/allowlist; revoke it any time.",
      inputSchema: z.object({
        name: z.string().min(1).max(60).describe("Worker name, e.g. scraper-1"),
        budgetCents: z.number().int().min(1).optional().describe("Lifetime budget in USD cents (omit for no total cap)"),
        dailyLimitCents: z.number().int().min(1).optional().describe("Per-day limit in USD cents"),
        expiresInMinutes: z.number().int().min(1).max(43200).optional().describe("Key expiry (max 30 days)"),
        allowedTools: z.array(z.string()).optional().describe("Allowlist entries like serviceId:tool or serviceId:*"),
        approvalAboveCents: z.number().int().min(1).optional().describe("Human approval threshold in cents"),
        key: keyField,
      }),
    },
    async ({ name, budgetCents, dailyLimitCents, expiresInMinutes, allowedTools, approvalAboveCents, key }) => {
      const { status, json } = await call("POST", "/agent/subagents", {
        key,
        body: { name, budgetCents, dailyLimitCents, expiresInMinutes, allowedTools, approvalAboveCents },
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "list_subagents",
    {
      title: "List sub-agents",
      description: "List the child keys delegated by the current agent, with budget, spend, expiry, and status.",
      inputSchema: z.object({ key: keyField }),
    },
    async ({ key }) => {
      const { status, json } = await call("GET", "/agent/subagents", { key });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "revoke_subagent",
    {
      title: "Revoke a sub-agent",
      description: "Revoke a delegated child key immediately.",
      inputSchema: z.object({
        agentId: z.string().describe("Sub-agent id from mint_subagent or list_subagents"),
        key: keyField,
      }),
    },
    async ({ agentId, key }) => {
      const { status, json } = await call("POST", `/agent/subagents/${encodeURIComponent(agentId)}/revoke`, {
        key,
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "get_attestation",
    {
      title: "Get proof-of-spend attestation",
      description:
        "Ask agentpay to sign a summary of this wallet's settled activity (payments, distinct services/payees, spend, refunds, bounty earnings) for a window. Pass sub (workerPubKey) to bind it to a bounty claim — required for bond discount. Free.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional().describe("Window in days (default 30)"),
        sub: z.string().max(120).optional().describe("Claimant binding, e.g. workerPubKey for a bounty claim"),
        key: keyField,
      }),
    },
    async ({ days, sub, key }) => {
      const { status, json } = await call("POST", "/agent/attestation", { key, body: { days, sub } });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Get receipt",
      description: "Fetch a receipt by id.",
      inputSchema: z.object({ receiptId: z.string(), key: keyField }),
    },
    async ({ receiptId, key }) => {
      const { status, json } = await call("GET", `/agent/receipts/${encodeURIComponent(receiptId)}`, { key });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description: "Recent wallet ledger events (top-ups, spends), newest first.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), key: keyField }),
    },
    async ({ limit, key }) => {
      const qs = limit ? `?limit=${limit}` : "";
      const { status, json } = await call("GET", `/agent/transactions${qs}`, { key });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "list_bounties",
    {
      title: "List bounties",
      description:
        "Browse open paid work on the BSVBounties marketplace (sats rewards, escrow, reputation). Free — no key required.",
      inputSchema: z.object({
        status: z
          .enum(["open", "claimed", "submitted", "paid", "refunded"])
          .optional()
          .describe("Bounty status filter (default open)"),
        category: z.string().optional().describe("Category filter, e.g. dev, research, content, data, design"),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async ({ status, category, limit, offset }) => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (category) qs.set("category", category);
      if (limit) qs.set("limit", String(limit));
      if (offset) qs.set("offset", String(offset));
      const query = qs.toString();
      const { status: http, json } = await call("GET", `/bounties${query ? `?${query}` : ""}`);
      if (http >= 400) return fail(http, json);
      return ok(json);
    },
  );

  server.registerTool(
    "get_bounty",
    {
      title: "Get bounty",
      description: "Full detail for one BSVBounties listing: requirements, amount, acceptance spec, status, escrow state.",
      inputSchema: z.object({
        bountyId: z.string().describe("Bounty id from list_bounties"),
      }),
    },
    async ({ bountyId }) => {
      const { status, json } = await call("GET", `/bounties/${encodeURIComponent(bountyId)}`);
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "claim_bounty",
    {
      title: "Claim a bounty",
      description:
        "Claim a bounty for this wallet. Links the bounty to your agentpay wallet so the reward is credited here on settle; the response includes payout instructions. Pass workerAccount/workerPubKey (BSV identity) to bind trust.",
      inputSchema: z.object({
        bountyId: z.string().describe("Bounty id from list_bounties"),
        workerAccount: z.number().int().positive().optional().describe("BSVBounties account # doing the work"),
        workerPubKey: z.string().optional().describe("BSV worker identity key"),
        payoutAddress: z.string().optional().describe("Optional BSV P2PKH payout address for direct sats"),
        key: keyField,
      }),
    },
    async ({ bountyId, workerAccount, workerPubKey, payoutAddress, key }) => {
      const { status, json } = await call("POST", `/bounties/${encodeURIComponent(bountyId)}/claim`, {
        key,
        body: { workerAccount, workerPubKey, payoutAddress },
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "submit_work",
    {
      title: "Submit work",
      description:
        "Submit your work for a bounty you claimed through agentpay. Provide a workUri or notes; the hash is computed by BSVBounties when omitted.",
      inputSchema: z.object({
        bountyId: z.string(),
        workUri: z.string().optional().describe("URL of the deliverable"),
        workHash: z.string().optional().describe("sha256 hex of the work, if you compute it yourself"),
        notes: z.string().optional().describe("Summary for the poster/verifier — include the payout address from claim_bounty"),
        milestoneIndex: z.number().int().min(0).optional(),
        key: keyField,
      }),
    },
    async ({ bountyId, workUri, workHash, notes, milestoneIndex, key }) => {
      const { status, json } = await call("POST", `/bounties/${encodeURIComponent(bountyId)}/submit`, {
        key,
        body: { workUri, workHash, notes, milestoneIndex },
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "post_bounty",
    {
      title: "Post a funded bounty",
      description:
        "Create a bounty funded from this wallet's balance. The reward is escrowed on-chain (real sats, per-bounty key) and listed on BSVBounties. Debits your balance at the posted rate plus the platform fee on payout.",
      inputSchema: z.object({
        title: z.string().max(120),
        description: z.string().max(2000),
        category: z.string().optional().describe("dev, research, content, data, design, other (default other)"),
        amountSats: z.number().int().positive().describe("Reward in sats; escrowed on-chain"),
        deadline: z.number().int().nonnegative().optional().describe("Unix seconds; enables deadline refunds"),
        payoutAddress: z
          .string()
          .optional()
          .describe("Optional BSV P2PKH address for the worker's sats (default: worker's agentpay balance)"),
        key: keyField,
      }),
    },
    async ({ title, description, category, amountSats, deadline, payoutAddress, key }) => {
      const { status, json } = await call("POST", "/agent/bounties", {
        key,
        body: { title, description, category, amountSats, deadline, payoutAddress },
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "settle_bounty",
    {
      title: "Settle a posted bounty",
      description:
        "As the poster, approve a submitted bounty (paid) or refund it. Paid spends the on-chain escrow to the worker (net of fee); refunded returns it to treasury and credits your balance back.",
      inputSchema: z.object({
        bountyId: z.string(),
        outcome: z.enum(["paid", "refunded"]),
        key: keyField,
      }),
    },
    async ({ bountyId, outcome, key }) => {
      const { status, json } = await call("POST", `/agent/bounties/${encodeURIComponent(bountyId)}/settle`, {
        key,
        body: { outcome },
      });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "my_escrows",
    {
      title: "My bounty escrows",
      description:
        "List agentpay-funded bounties posted by this wallet: amount, escrow address, funding/payout/refund txids, and any pending error.",
      inputSchema: z.object({ key: keyField }),
    },
    async ({ key }) => {
      const { status, json } = await call("GET", "/agent/bounties/escrows", { key });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  server.registerTool(
    "my_bounties",
    {
      title: "My bounties",
      description: "List bounties this wallet has claimed through agentpay, with status and credited amount.",
      inputSchema: z.object({ key: keyField }),
    },
    async ({ key }) => {
      const { status, json } = await call("GET", "/agent/bounties", { key });
      if (status >= 400) return fail(status, json);
      return ok(json);
    },
  );

  return server;
}

export function mcpDiscovery(): Record<string, unknown> {
  return {
    name: MCP_NAME,
    version: MCP_VERSION,
    transport: "streamable-http",
    endpoint: `${PUBLIC_SITE}${MCP_PATH}`,
    dashboard: `${PUBLIC_SITE}${APP_PREFIX}/`,
    tools: [...MCP_TOOLS],
    auth:
      "Public discovery tools need no key. Wallet tools need an agent key (agp_…) as Authorization: Bearer on this connection or the `key` tool parameter.",
  };
}

function rewriteMcpUrl(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = "/mcp";
  return new Request(url, request);
}

export async function handleMcp(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const rewritten = isMcpPath(new URL(request.url).pathname) ? rewriteMcpUrl(request) : request;

  if (rewritten.method === "GET") {
    return Response.json(mcpDiscovery(), {
      headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
    });
  }

  const connectionKey = bearerToken(request);
  const handler = createMcpHandler(() => createAgentPayMcpServer(env, ctx, new URL(request.url).origin, connectionKey), {
    route: "/mcp",
    allowedOriginHostnames: "*",
    onerror: (error) => {
      console.error("[mcp]", error);
    },
  });
  return handler(rewritten, env, ctx);
}
