/**
 * x402market discovery — reads the shared `xm_services` registry (owned by the
 * x402market worker) and proxies live 402 challenges so agents can see price
 * and payTo without a wallet.
 */
import { HttpError } from "./types";
import { cleanStr } from "./ids";

export interface RegistryTool {
  name: string;
  method: string;
  path: string;
  priceSats: number;
  paid: boolean;
  description: string;
  body: string;
}

export interface RegistryService {
  id: string;
  name: string;
  tagline: string;
  description: string;
  manifestUrl: string;
  baseUrl: string;
  network: string;
  payTo: string;
  status: string;
  featured: boolean;
  tools: RegistryTool[];
  toolCount: number;
  paidCount: number;
  freeCount: number;
  minPriceSats: number | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
}

interface XmServiceRow {
  id: string;
  name: string;
  tagline: string;
  description: string;
  manifest_url: string;
  base_url: string;
  network: string;
  pay_to: string;
  status: string;
  featured: number;
  tools_json: string;
  tool_count: number;
  paid_count: number;
  free_count: number;
  min_price_sats: number | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
}

export async function registryAvailable(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'xm_services'")
      .first<{ name: string }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

export function rowToService(row: XmServiceRow): RegistryService {
  let tools: RegistryTool[] = [];
  try {
    tools = JSON.parse(row.tools_json || "[]") as RegistryTool[];
  } catch {
    tools = [];
  }
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    manifestUrl: row.manifest_url,
    baseUrl: row.base_url,
    network: row.network,
    payTo: row.pay_to,
    status: row.status,
    featured: row.featured === 1,
    tools,
    toolCount: row.tool_count,
    paidCount: row.paid_count,
    freeCount: row.free_count,
    minPriceSats: row.min_price_sats,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
  };
}

export async function listServices(
  db: D1Database,
  opts: { q?: string; limit?: number } = {},
): Promise<RegistryService[]> {
  if (!(await registryAvailable(db))) return [];
  const q = cleanStr(opts.q, 80);
  const limit = Math.min(Math.max(1, opts.limit ?? 25), 50);
  let sql = "SELECT * FROM xm_services WHERE status = 'verified'";
  const args: unknown[] = [];
  if (q) {
    sql += " AND (name LIKE ? OR tagline LIKE ? OR description LIKE ?)";
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY featured DESC, tool_count DESC, created_at DESC LIMIT ?";
  args.push(limit);
  const { results } = await db
    .prepare(sql)
    .bind(...args)
    .all<XmServiceRow>();
  return (results ?? []).map(rowToService);
}

export async function getService(db: D1Database, id: string): Promise<RegistryService | null> {
  if (!(await registryAvailable(db))) {
    throw new HttpError(503, "x402market registry is not initialized on this database");
  }
  const row = await db
    .prepare("SELECT * FROM xm_services WHERE id = ? AND status = 'verified'")
    .bind(id)
    .first<XmServiceRow>();
  return row ? rowToService(row) : null;
}

function b64decodeJson(b64: string): unknown {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export interface ServiceQuote {
  service: string;
  serviceId: string;
  tool: string;
  requirements: unknown;
  header: string;
}

export interface ServiceCallOptions {
  params?: Record<string, unknown>;
  paymentSignature?: string | null;
  timeoutMs?: number;
}

/**
 * Call a seller tool. `:name` placeholders are filled from `params`; leftovers
 * become query params on GET or the JSON body on POST. `paymentSignature`
 * carries the signed x402 tx when paying.
 */
export async function callServiceTool(
  service: RegistryService,
  tool: RegistryTool,
  opts: ServiceCallOptions = {},
): Promise<Response> {
  let url = tool.path;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.paymentSignature) headers["PAYMENT-SIGNATURE"] = opts.paymentSignature;
  const params = { ...(opts.params ?? {}) };

  for (const key of Object.keys(params)) {
    const placeholder = `:${key}`;
    if (url.includes(placeholder)) {
      url = url.replace(placeholder, encodeURIComponent(String(params[key])));
      delete params[key];
    }
  }

  let body: string | undefined;
  if (tool.method === "GET") {
    if (Object.keys(params).length > 0) {
      const parsed = new URL(url);
      for (const [k, v] of Object.entries(params)) parsed.searchParams.set(k, String(v));
      url = parsed.toString();
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(params);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  try {
    return await fetch(url, {
      method: tool.method,
      headers: {
        "User-Agent": "agentpay-payer/1.0 (+https://entangleit.com/agentpay)",
        ...headers,
      },
      body,
      signal: ctl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Call a seller tool unsigned; expect 402 + PAYMENT-REQUIRED, and decode it. */
export async function quoteService(
  db: D1Database,
  serviceId: string,
  toolName: string,
): Promise<ServiceQuote> {
  const service = await getService(db, serviceId);
  if (!service) throw new HttpError(404, "Service not found");
  const tool = service.tools.find((t) => t.name === toolName);
  if (!tool) throw new HttpError(404, "Tool not found on this service");
  if (!tool.paid) throw new HttpError(400, "That tool is free — call it directly");
  let res: Response;
  try {
    res = await callServiceTool(service, tool);
  } catch (e) {
    throw new HttpError(502, `Seller unreachable: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
  if (res.status !== 402) {
    throw new HttpError(502, `Seller did not challenge (got ${res.status}, want 402)`);
  }
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new HttpError(502, "402 without PAYMENT-REQUIRED header");
  let requirements: unknown;
  try {
    requirements = b64decodeJson(header);
  } catch {
    throw new HttpError(502, "PAYMENT-REQUIRED is not decodable");
  }
  return { service: service.name, serviceId: service.id, tool: tool.name, requirements, header };
}
