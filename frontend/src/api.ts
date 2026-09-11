export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const res = await fetch(`/api/agentpay${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : text.slice(0, 200) || `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

export interface WalletInfo {
  id: string;
  name: string;
  email: string;
  balanceCents: number;
  lifetimeTopupCents: number;
  status: string;
  stripeCustomer: boolean;
  createdAt: string;
}

export interface SubagentInfo {
  parentAgentId: string;
  budgetCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  expiresAt: string | null;
  expired: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  keyPrefix: string;
  dailyLimitCents: number | null;
  spentTodayCents: number;
  spentDay: string;
  active: boolean;
  approvalAboveCents: number | null;
  allowedTools: string[];
  createdAt: string;
  lastUsedAt: string | null;
  subagent: SubagentInfo | null;
}

export interface ApprovalInfo {
  id: string;
  agentId: string | null;
  amountCents: number;
  description: string;
  service: string;
  tool: string;
  ref: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  reason: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
}

export interface LedgerEntry {
  id: string;
  kind: "topup" | "debit" | "refund" | "adjust";
  amountCents: number;
  balanceAfterCents: number;
  currency: string;
  ref: string;
  /** Set for ledger entries that carry a semantic type, e.g. bounty_payout. */
  type: string;
  description: string;
  service: string;
  tool: string;
  agentId: string | null;
  createdAt: string;
}

export interface ReceiptInfo {
  id: string;
  ledgerId: string;
  service: string;
  tool: string;
  description: string;
  amountCents: number;
  currency: string;
  requestRef: string;
  createdAt: string;
}

export interface PlanLimits {
  maxAgents: number;
  maxDailyLimitCents: number;
  exportCsv: boolean;
}

export interface PlanInfo {
  id: "free" | "pro";
  name: string;
  subscribedPlan: "free" | "pro";
  active: boolean;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceCents: number;
  limits: PlanLimits;
  upgradeUrl: string;
}

export interface WalletResponse {
  wallet: WalletInfo;
  plan: PlanInfo;
  agents: AgentInfo[];
  ledger: LedgerEntry[];
  receipts: ReceiptInfo[];
  approvals: ApprovalInfo[];
  topup: { minCents: number; maxCents: number; presets: number[] };
}

export interface TreasuryInfo {
  configured: boolean;
  address: string | null;
  sats: number | null;
  thresholdSats: number;
  low: boolean;
  stale: boolean;
  updatedAt: string | null;
}

export interface HealthResponse {
  ok: boolean;
  x402: {
    siteWalletConfigured: boolean;
    siteWalletAddress: string | null;
    maxPaymentSats: number;
    treasury: TreasuryInfo | null;
  };
}

export interface RegistryTool {
  name: string;
  method: string;
  path: string;
  priceSats: number;
  paid: boolean;
  description: string;
}

export interface Service {
  id: string;
  name: string;
  tagline: string;
  description: string;
  baseUrl: string;
  network: string;
  payTo: string;
  featured: boolean;
  tools: RegistryTool[];
  toolCount: number;
  paidCount: number;
  freeCount: number;
  minPriceSats: number | null;
}

export interface ServicesResponse {
  services: Service[];
  registry: boolean;
  note: string;
}

export interface WebhookInfo {
  url: string;
  events: string[];
  lowBalanceCents: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface DeliveryInfo {
  id: string;
  event: string;
  statusCode: number | null;
  error: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface WebhookResponse {
  webhook: WebhookInfo | null;
  events: string[];
  emailConfigured: boolean;
  deliveries: DeliveryInfo[];
}

export interface ReportLinkInfo {
  token: string;
  label: string;
  days: number;
  includeReceipts: boolean;
  revoked: boolean;
  expiresAt: string | null;
  createdAt: string;
  views: number;
  lastViewedAt: string | null;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
