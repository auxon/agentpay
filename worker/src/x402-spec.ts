/**
 * x402 v2 protocol types and wire helpers.
 *
 * Canonical spec: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
 * HTTP transport: specs/transports-v2/http.md
 * Bazaar extension: specs/extensions/bazaar.md
 * BSV CAIP-2: https://namespaces.chainagnostic.org/bsv/caip2  (`bsv:mainnet`)
 *
 * v2 headers are PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE.
 * v1 aliases X-PAYMENT and X-PAYMENT-RESPONSE are still read and written so
 * older clients and sellers interoperate. Live seller payloads keep their
 * extra top-level fields (txHex, encoding) for backward compatibility.
 */
export const X402_VERSION = 2;
export const X402_SCHEME = "exact";

/** Registered CAIP-2 identifiers for the `bsv` namespace (ChainAgnostic/namespaces#190). */
export const BSV_NETWORK = "bsv:mainnet";
export const BSV_NETWORKS = ["bsv:mainnet", "bsv:testnet", "bsv:ttn", "bsv:tstn"] as const;
export type BsvNetwork = (typeof BSV_NETWORKS)[number];

/**
 * Bitcoin-family genesis CAIP-2. Shared by BTC, BCH, and BSV — MUST NOT be
 * treated as BSV (paying the right amount on the wrong chain is unrecoverable).
 */
export const BIP122_GENESIS = "bip122:000000000019d6689c085ae165831e93";

export const BSV_ASSET = "BSV";
export const BSV_ASSET_LEGACY = "native:BSV";
export const P2PKH_RAWTX = "p2pkh-rawtx";
export const BSV_PAYMENT_FLOW = "upfront";
export const BSV_ASSET_TRANSFER_METHOD = "p2pkh-rawtx";
export const DEFAULT_MAX_TIMEOUT_SECONDS = 900;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
export const X_PAYMENT_HEADER = "X-PAYMENT";
export const X_PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";

export const FACILITATOR_WALLET_ID = "x402-facilitator";

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extra?: Record<string, unknown>;
}

export interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: PaymentPayload | Record<string, unknown>;
  paymentRequirements: PaymentRequirements | Record<string, unknown>;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface DiscoveredResource {
  resource: string;
  type: "http" | "mcp";
  x402Version: number;
  accepts: PaymentRequirements[];
  lastUpdated: string;
  extensions?: Record<string, unknown>;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  method?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function encodeX402Json(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeX402Json(header: string): unknown {
  const trimmed = header.trim();
  const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function headerGet(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase());
}

/** PAYMENT-SIGNATURE, falling back to the v1 X-PAYMENT alias. */
export function readPaymentSignatureHeader(headers: Headers): string | null {
  return headerGet(headers, PAYMENT_SIGNATURE_HEADER) ?? headerGet(headers, X_PAYMENT_HEADER);
}

/** PAYMENT-RESPONSE, falling back to the v1 X-PAYMENT-RESPONSE alias. */
export function readPaymentResponseHeader(headers: Headers): string | null {
  return headerGet(headers, PAYMENT_RESPONSE_HEADER) ?? headerGet(headers, X_PAYMENT_RESPONSE_HEADER);
}

export function readPaymentRequiredHeader(headers: Headers): string | null {
  return headerGet(headers, PAYMENT_REQUIRED_HEADER);
}

/** Headers a payer attaches on the retry. Writes both v2 and v1 names. */
export function paymentSignatureHeaders(encoded: string): Record<string, string> {
  return {
    [PAYMENT_SIGNATURE_HEADER]: encoded,
    [X_PAYMENT_HEADER]: encoded,
  };
}

/** Headers a resource server attaches on success or failed settlement. */
export function paymentResponseHeaders(settlement: SettlementResponse): Record<string, string> {
  const encoded = encodeX402Json(settlement);
  return {
    [PAYMENT_RESPONSE_HEADER]: encoded,
    [X_PAYMENT_RESPONSE_HEADER]: encoded,
  };
}

export function paymentRequiredHeaders(required: PaymentRequired): Record<string, string> {
  return { [PAYMENT_REQUIRED_HEADER]: encodeX402Json(required) };
}

export function isBsvNetwork(network: unknown): network is BsvNetwork {
  return typeof network === "string" && (BSV_NETWORKS as readonly string[]).includes(network);
}

export function isAmbiguousBip122(network: unknown): boolean {
  if (typeof network !== "string") return false;
  const n = network.toLowerCase();
  return n === BIP122_GENESIS || n.startsWith("bip122:000000000019d6689c085ae165831e93");
}

export function isBsvAsset(asset: unknown): boolean {
  if (asset === undefined || asset === null || asset === "") return true;
  if (asset === BSV_ASSET || asset === BSV_ASSET_LEGACY) return true;
  if (typeof asset === "string" && /^bsv:[a-z0-9]+\/slip44:236$/i.test(asset)) return true;
  return false;
}

export function knownPaymentFlow(flow: unknown): boolean {
  return flow === undefined || flow === null || flow === "" || flow === "authorization" || flow === "upfront";
}

/**
 * Spec §5.1 PaymentRequired example (EVM / Base Sepolia USDC). Used as a
 * conformance fixture — agentpay does not settle this rail.
 */
export const SPEC_PAYMENT_REQUIRED_EXAMPLE: PaymentRequired = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Access to premium market data",
    mimeType: "application/json",
    serviceName: "Example Market Data",
    tags: ["market-data", "finance"],
    iconUrl: "https://api.example.com/icon.png",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
  extensions: {},
};

/** Spec §5.2 PaymentPayload example (EVM exact). */
export const SPEC_PAYMENT_PAYLOAD_EXAMPLE: PaymentPayload = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Access to premium market data",
    mimeType: "application/json",
  },
  accepted: SPEC_PAYMENT_REQUIRED_EXAMPLE.accepts[0],
  payload: {
    signature:
      "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    authorization: {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      value: "10000",
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce: "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
    },
  },
  extensions: {},
};

/** Spec §5.3 SettlementResponse success example. */
export const SPEC_SETTLEMENT_RESPONSE_EXAMPLE: SettlementResponse = {
  success: true,
  transaction: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  network: "eip155:84532",
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
};

/** Spec §7.1 verify request wrapper around the payload example. */
export const SPEC_VERIFY_REQUEST_EXAMPLE: FacilitatorRequest = {
  x402Version: 2,
  paymentPayload: SPEC_PAYMENT_PAYLOAD_EXAMPLE,
  paymentRequirements: SPEC_PAYMENT_REQUIRED_EXAMPLE.accepts[0],
};

const PAYMENT_REQUIRED_FIELDS = ["x402Version", "resource", "accepts"] as const;
const PAYMENT_REQUIREMENTS_FIELDS = [
  "scheme",
  "network",
  "amount",
  "asset",
  "payTo",
  "maxTimeoutSeconds",
] as const;
const PAYMENT_PAYLOAD_FIELDS = ["x402Version", "accepted", "payload"] as const;
const SETTLEMENT_FIELDS = ["success", "transaction", "network"] as const;

export function paymentRequiredGaps(raw: unknown): string[] {
  if (!isRecord(raw)) return ["not an object"];
  const gaps: string[] = [];
  for (const field of PAYMENT_REQUIRED_FIELDS) {
    if (!(field in raw)) gaps.push(`missing ${field}`);
  }
  if (raw.x402Version !== X402_VERSION) gaps.push(`x402Version is not ${X402_VERSION}`);
  if (!isRecord(raw.resource) || typeof raw.resource.url !== "string") {
    gaps.push("resource.url is required");
  }
  if (!Array.isArray(raw.accepts) || raw.accepts.length === 0) {
    gaps.push("accepts must be a non-empty array");
  } else {
    for (const [i, entry] of raw.accepts.entries()) {
      gaps.push(...paymentRequirementsGaps(entry).map((g) => `accepts[${i}].${g}`));
    }
  }
  return gaps;
}

export function paymentRequirementsGaps(raw: unknown): string[] {
  if (!isRecord(raw)) return ["not an object"];
  const gaps: string[] = [];
  for (const field of PAYMENT_REQUIREMENTS_FIELDS) {
    if (!(field in raw)) gaps.push(`missing ${field}`);
  }
  if (typeof raw.scheme === "string" && !raw.scheme) gaps.push("scheme is empty");
  if (typeof raw.network === "string" && !raw.network.includes(":")) {
    gaps.push("network is not CAIP-2 (namespace:reference)");
  }
  if (raw.amount !== undefined && typeof raw.amount !== "string") {
    gaps.push("amount must be a string (atomic units)");
  }
  if (typeof raw.maxTimeoutSeconds === "number" && raw.maxTimeoutSeconds <= 0) {
    gaps.push("maxTimeoutSeconds must be positive");
  }
  return gaps;
}

export function paymentPayloadGaps(raw: unknown): string[] {
  if (!isRecord(raw)) return ["not an object"];
  const gaps: string[] = [];
  for (const field of PAYMENT_PAYLOAD_FIELDS) {
    if (!(field in raw)) gaps.push(`missing ${field}`);
  }
  if (raw.x402Version !== X402_VERSION) gaps.push(`x402Version is not ${X402_VERSION}`);
  if ("accepted" in raw) gaps.push(...paymentRequirementsGaps(raw.accepted).map((g) => `accepted.${g}`));
  if (!isRecord(raw.payload)) gaps.push("payload must be an object");
  return gaps;
}

export function settlementResponseGaps(raw: unknown): string[] {
  if (!isRecord(raw)) return ["not an object"];
  const gaps: string[] = [];
  for (const field of SETTLEMENT_FIELDS) {
    if (!(field in raw)) gaps.push(`missing ${field}`);
  }
  if (typeof raw.success !== "boolean") gaps.push("success must be boolean");
  if (typeof raw.transaction !== "string") gaps.push("transaction must be a string");
  if (raw.errorReason === "settlement_pending" && !raw.transaction) {
    gaps.push("settlement_pending requires a non-empty transaction");
  }
  return gaps;
}

export function bazaarHttpExtension(opts: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "HEAD" | "DELETE";
  bodyType?: "json" | "form-data" | "text";
  body?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  outputExample?: Record<string, unknown>;
}): { info: Record<string, unknown>; schema: Record<string, unknown> } {
  const bodyMethod = opts.method === "POST" || opts.method === "PUT" || opts.method === "PATCH";
  const input: Record<string, unknown> = { type: "http", method: opts.method };
  if (bodyMethod) {
    input.bodyType = opts.bodyType ?? "json";
    input.body = opts.body ?? {};
  }
  if (opts.queryParams) input.queryParams = opts.queryParams;
  return {
    info: {
      input,
      output: { type: "json", example: opts.outputExample ?? {} },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string" },
            bodyType: { type: "string", enum: ["json", "form-data", "text"] },
            body: { type: "object" },
            queryParams: { type: "object" },
            headers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: bodyMethod ? ["type", "method", "bodyType", "body"] : ["type", "method"],
        },
        output: {
          type: "object",
          properties: { type: { type: "string" }, example: { type: "object" } },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
}

export function bsvExactRequirements(opts: {
  amountSats: number;
  payTo: string;
  lockingScriptHex: string;
  extra?: Record<string, unknown>;
  maxTimeoutSeconds?: number;
}): PaymentRequirements {
  const amount = String(opts.amountSats);
  return {
    scheme: X402_SCHEME,
    network: BSV_NETWORK,
    amount,
    asset: BSV_ASSET,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: {
      chain: "bsv",
      unit: "satoshi",
      lockingScriptHex: opts.lockingScriptHex,
      perCallSats: opts.amountSats,
      payloadFormat: { kind: P2PKH_RAWTX },
      paymentFlow: BSV_PAYMENT_FLOW,
      assetTransferMethod: BSV_ASSET_TRANSFER_METHOD,
      ...(opts.extra ?? {}),
    },
  };
}

export function extractTxHex(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const inner = isRecord(payload.payload) ? payload.payload : null;
  const candidates = [inner?.rawtx, inner?.txHex, payload.rawtx, payload.txHex];
  for (const c of candidates) {
    if (typeof c === "string" && /^[0-9a-f]+$/i.test(c) && c.length >= 20) return c;
  }
  return null;
}

export function extractLockingScriptHex(
  requirements: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): string | null {
  const extra = isRecord(requirements?.extra) ? requirements.extra : null;
  const inner = isRecord(payload?.payload) ? payload.payload : payload;
  const candidates = [inner?.lockingScriptHex, extra?.lockingScriptHex];
  for (const c of candidates) {
    if (typeof c === "string" && /^[0-9a-f]+$/i.test(c)) return c.toLowerCase();
  }
  return null;
}
