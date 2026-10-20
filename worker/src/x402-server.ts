/**
 * agentpay as an x402 v2 resource server + discovery catalog.
 *
 * Public paid endpoints (`/x402/chat`, `/x402/extract`) emit spec-conformant
 * 402 challenges so generic clients and indexers can parse them. Settlement
 * uses the local BSV facilitator. Existing `/agent/chat` and `/agent/extract`
 * stay wallet-gated and unchanged.
 */
import { P2PKH } from "@bsv/sdk";
import {
  FUSE_DISCOVERY_URL,
  FUSE_DOCS_URL,
  FUSE_EXTRACT_TIER_SATS,
  FUSE_MODELS,
  FUSE_PUBLIC_CHAT_URL,
  FUSE_PUBLIC_EXTRACT_URL,
  callFuseChatPaid,
  callFuseExtractPaid,
  parseFuseChatBody,
  parseFuseExtractBody,
  parseFuseExtractResult,
  quoteFuseChat,
  quoteFuseExtract,
  type FuseChatRequest,
  type FuseExtractRequest,
} from "./fuse";
import { newId, nowIso } from "./ids";
import { API_PREFIX, PUBLIC_SITE } from "./paths";
import { HttpError, type AppEnv } from "./types";
import {
  facilitatorSettle,
  facilitatorSupported,
  loadInvoice,
  recordInvoice,
  verifyBsvPaymentPayload,
} from "./x402-facilitator";
import { feeSatsFor, prepareBsvPayment, siteWalletAddress } from "./x402";
import {
  BSV_ASSET,
  BSV_NETWORK,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  X402_VERSION,
  bazaarHttpExtension,
  bsvExactRequirements,
  decodeX402Json,
  isRecord,
  paymentPayloadGaps,
  paymentRequiredHeaders,
  paymentResponseHeaders,
  readPaymentSignatureHeader,
  type DiscoveredResource,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettlementResponse,
} from "./x402-spec";

export const X402_CHAT_PATH = `${API_PREFIX}/x402/chat`;
export const X402_EXTRACT_PATH = `${API_PREFIX}/x402/extract`;
export const X402_CHAT_URL = `${PUBLIC_SITE}${X402_CHAT_PATH}`;
export const X402_EXTRACT_URL = `${PUBLIC_SITE}${X402_EXTRACT_PATH}`;
export const X402_WELL_KNOWN_PATH = `${API_PREFIX}/.well-known/x402`;
export const X402_ICON_URL = `${PUBLIC_SITE}/agentpay/icon.png`;

export const FUSE_CHAT_PRICE_SATS: Record<(typeof FUSE_MODELS)[number], number> = {
  "fuse-fast": 500,
  "fuse-smart": 2500,
};

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname === "entangleit.com" || url.hostname === "www.entangleit.com") return PUBLIC_SITE;
  return url.origin;
}

export function x402ChatUrl(request: Request): string {
  return `${publicOrigin(request)}${X402_CHAT_PATH}`;
}

export function x402ExtractUrl(request: Request): string {
  return `${publicOrigin(request)}${X402_EXTRACT_PATH}`;
}

export function lockingScriptHexForAddress(address: string): string {
  return new P2PKH().lock(address).toHex().toLowerCase();
}

function resourceChat(url: string): ResourceInfo {
  return {
    url,
    description: "Pay-per-call LLM (Fuse) over x402 v2 / BSV exact",
    mimeType: "application/json",
    serviceName: "agentpay",
    tags: ["llm", "chat", "bsv", "x402"],
    iconUrl: X402_ICON_URL,
  };
}

function resourceExtract(url: string): ResourceInfo {
  return {
    url,
    description: "Typed extract from text or receipts over x402 v2 / BSV exact",
    mimeType: "application/json",
    serviceName: "agentpay",
    tags: ["extract", "llm", "bsv", "x402"],
    iconUrl: X402_ICON_URL,
  };
}

export function listPriceSats(kind: "chat" | "extract", env: AppEnv, modelOrSize?: string): number {
  const fee = feeSatsFor(env);
  if (kind === "chat") {
    const model = modelOrSize === "fuse-smart" ? "fuse-smart" : "fuse-fast";
    return FUSE_CHAT_PRICE_SATS[model] + fee;
  }
  const size = modelOrSize === "M" || modelOrSize === "L" ? modelOrSize : "S";
  return FUSE_EXTRACT_TIER_SATS[size] + fee;
}

export function buildBsvPaymentRequired(opts: {
  resource: ResourceInfo;
  payTo: string;
  amountSats: number;
  invoiceId: string;
  extra?: Record<string, unknown>;
  bazaar: ReturnType<typeof bazaarHttpExtension>;
  error?: string;
}): PaymentRequired {
  const locking = lockingScriptHexForAddress(opts.payTo);
  const expiresAt = new Date(Date.now() + DEFAULT_MAX_TIMEOUT_SECONDS * 1000).toISOString();
  const accepts: PaymentRequirements[] = [
    bsvExactRequirements({
      amountSats: opts.amountSats,
      payTo: opts.payTo,
      lockingScriptHex: locking,
      extra: {
        invoiceId: opts.invoiceId,
        expiresAt,
        ...(opts.extra ?? {}),
      },
    }),
  ];
  return {
    x402Version: X402_VERSION,
    error: opts.error ?? "PAYMENT-SIGNATURE header is required",
    resource: opts.resource,
    accepts,
    extensions: { bazaar: opts.bazaar },
  };
}

export function paymentRequiredResponse(required: PaymentRequired, status = 402): Response {
  const headers = {
    "content-type": "application/json",
    ...paymentRequiredHeaders(required),
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
  };
  return new Response(JSON.stringify(required), { status, headers });
}

export function settlementHeaders(settlement: SettlementResponse): Record<string, string> {
  return {
    ...paymentResponseHeaders(settlement),
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
  };
}

export function wellKnownCatalog(request: Request, env: AppEnv): Record<string, unknown> {
  const origin = publicOrigin(request);
  const payTo = siteWalletAddress(env);
  const fee = feeSatsFor(env);
  return {
    version: 1,
    x402Version: X402_VERSION,
    network: BSV_NETWORK,
    asset: BSV_ASSET,
    payTo,
    resources: [
      `${origin}${X402_CHAT_PATH}`,
      `${origin}${X402_EXTRACT_PATH}`,
      FUSE_PUBLIC_CHAT_URL,
      FUSE_PUBLIC_EXTRACT_URL,
    ],
    facilitator: {
      verify: `${origin}${API_PREFIX}/x402/verify`,
      settle: `${origin}${API_PREFIX}/x402/settle`,
      supported: `${origin}${API_PREFIX}/x402/supported`,
    },
    fuse: { discovery: FUSE_DISCOVERY_URL, docs: FUSE_DOCS_URL },
    prices: {
      chat: {
        "fuse-fast": FUSE_CHAT_PRICE_SATS["fuse-fast"] + fee,
        "fuse-smart": FUSE_CHAT_PRICE_SATS["fuse-smart"] + fee,
      },
      extract: {
        S: FUSE_EXTRACT_TIER_SATS.S + fee,
        M: FUSE_EXTRACT_TIER_SATS.M + fee,
        L: FUSE_EXTRACT_TIER_SATS.L + fee,
      },
    },
    instructions:
      "Probe POST /x402/chat or /x402/extract for a live 402. Register Fuse at its own /.well-known/x402. See docs/X402-DISCOVERY.md.",
  };
}

export function discoveryResources(request: Request, env: AppEnv, now = nowIso()): DiscoveredResource[] {
  const origin = publicOrigin(request);
  const payTo = siteWalletAddress(env) ?? "unconfigured";
  const locking = payTo === "unconfigured" ? "00" : lockingScriptHexForAddress(payTo);
  const fee = feeSatsFor(env);
  const chatAccept = bsvExactRequirements({
    amountSats: FUSE_CHAT_PRICE_SATS["fuse-fast"] + fee,
    payTo,
    lockingScriptHex: locking,
    extra: { model: "fuse-fast" },
  });
  const extractAccept = bsvExactRequirements({
    amountSats: FUSE_EXTRACT_TIER_SATS.S + fee,
    payTo,
    lockingScriptHex: locking,
    extra: { size: "S" },
  });
  const fuseChatAccept = bsvExactRequirements({
    amountSats: FUSE_CHAT_PRICE_SATS["fuse-fast"],
    payTo,
    lockingScriptHex: locking,
    extra: { model: "fuse-fast", listedVia: "agentpay" },
  });
  const fuseExtractAccept = bsvExactRequirements({
    amountSats: FUSE_EXTRACT_TIER_SATS.S,
    payTo,
    lockingScriptHex: locking,
    extra: { size: "S", listedVia: "agentpay" },
  });
  return [
    {
      resource: `${origin}${X402_CHAT_PATH}`,
      type: "http",
      x402Version: X402_VERSION,
      accepts: [chatAccept],
      lastUpdated: now,
      method: "POST",
      description: "Pay-per-call LLM via agentpay (settles Fuse on BSV)",
      mimeType: "application/json",
      serviceName: "agentpay",
      tags: ["llm", "chat", "bsv"],
      extensions: { bazaar: bazaarHttpExtension({ method: "POST", body: { model: "fuse-fast", messages: [] } }) },
    },
    {
      resource: `${origin}${X402_EXTRACT_PATH}`,
      type: "http",
      x402Version: X402_VERSION,
      accepts: [extractAccept],
      lastUpdated: now,
      method: "POST",
      description: "Typed extract via agentpay (settles Fuse on BSV)",
      mimeType: "application/json",
      serviceName: "agentpay",
      tags: ["extract", "bsv"],
      extensions: { bazaar: bazaarHttpExtension({ method: "POST", body: { state: "", fields: {} } }) },
    },
    {
      resource: FUSE_PUBLIC_CHAT_URL,
      type: "http",
      x402Version: X402_VERSION,
      accepts: [fuseChatAccept],
      lastUpdated: now,
      method: "POST",
      description: "Fuse chat completions (canonical resource; payTo is Fuse's, listed here for discovery)",
      mimeType: "application/json",
      serviceName: "Fuse",
      tags: ["llm", "fuse", "bsv"],
    },
    {
      resource: FUSE_PUBLIC_EXTRACT_URL,
      type: "http",
      x402Version: X402_VERSION,
      accepts: [fuseExtractAccept],
      lastUpdated: now,
      method: "POST",
      description: "Fuse extract (canonical resource)",
      mimeType: "application/json",
      serviceName: "Fuse",
      tags: ["extract", "fuse", "bsv"],
    },
  ];
}

export function filterDiscovery(
  items: DiscoveredResource[],
  query: { type?: string; payTo?: string; scheme?: string; network?: string; limit?: number; offset?: number },
): { items: DiscoveredResource[]; pagination: { limit: number; offset: number; total: number } } {
  let out = items;
  if (query.type) out = out.filter((i) => i.type === query.type);
  if (query.scheme) out = out.filter((i) => i.accepts.some((a) => a.scheme === query.scheme));
  if (query.network) out = out.filter((i) => i.accepts.some((a) => a.network === query.network));
  if (query.payTo) out = out.filter((i) => i.accepts.some((a) => a.payTo === query.payTo));
  const total = out.length;
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const offset = Math.max(0, query.offset ?? 0);
  return { items: out.slice(offset, offset + limit), pagination: { limit, offset, total } };
}

export function paymentPayloadFromRequest(request: Request): Record<string, unknown> | null {
  const header = readPaymentSignatureHeader(request.headers);
  if (!header) return null;
  try {
    const raw = decodeX402Json(header);
    if (!isRecord(raw)) throw new Error("not an object");
    return raw;
  } catch {
    throw new HttpError(400, "malformed_payment", { invalidReason: "invalid_payload" });
  }
}

async function challengeFor(
  env: AppEnv,
  request: Request,
  kind: "chat" | "extract",
  amountSats: number,
  extra: Record<string, unknown>,
): Promise<PaymentRequired> {
  const payTo = siteWalletAddress(env);
  if (!payTo) throw new HttpError(503, "BSV rail is not configured (site wallet WIF missing)");
  const invoiceId = newId("inv");
  const resource = kind === "chat" ? resourceChat(x402ChatUrl(request)) : resourceExtract(x402ExtractUrl(request));
  const bazaar =
    kind === "chat"
      ? bazaarHttpExtension({
          method: "POST",
          body: { model: "fuse-fast", messages: [{ role: "user", content: "hello" }] },
          outputExample: { id: "chatcmpl_…", choices: [], receiptUrl: "", txid: "" },
        })
      : bazaarHttpExtension({
          method: "POST",
          body: { state: "Total $12.50", fields: { total: { type: "number" } } },
          outputExample: { answers: { total: { value: 12.5, p_null: 0 } }, txid: "" },
        });
  const required = buildBsvPaymentRequired({
    resource,
    payTo,
    amountSats,
    invoiceId,
    extra,
    bazaar,
  });
  if (env.DB) {
    await recordInvoice(env.DB, invoiceId, {
      kind,
      resourceUrl: resource.url,
      amountSats,
      payTo,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + DEFAULT_MAX_TIMEOUT_SECONDS * 1000).toISOString(),
    });
  }
  return required;
}

export async function unpaidChatChallenge(env: AppEnv, request: Request, model = "fuse-fast"): Promise<Response> {
  const required = await challengeFor(env, request, "chat", listPriceSats("chat", env, model), { model });
  return paymentRequiredResponse(required);
}

export async function unpaidExtractChallenge(env: AppEnv, request: Request, size = "S"): Promise<Response> {
  const required = await challengeFor(env, request, "extract", listPriceSats("extract", env, size), { size });
  return paymentRequiredResponse(required);
}

async function settleClientPayment(
  env: AppEnv,
  payload: Record<string, unknown>,
  requirements: PaymentRequirements,
): Promise<SettlementResponse> {
  return facilitatorSettle(env, {
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirements,
  });
}

/**
 * Verify the buyer payment, fulfill via Fuse (treasury pays Fuse), then settle
 * the buyer tx. Produce-then-broadcast: Fuse failure does not broadcast.
 */
export async function fulfillPaidChat(
  env: AppEnv,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const gaps = paymentPayloadGaps(payload);
  if (gaps.includes("missing accepted") || gaps.includes("missing payload") || gaps.includes("not an object")) {
    throw new HttpError(400, "malformed_payment", { invalidReason: "invalid_payload", gaps });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const chat: FuseChatRequest = parseFuseChatBody(body);
  const amountSats = listPriceSats("chat", env, chat.model);
  const payTo = siteWalletAddress(env);
  if (!payTo) throw new HttpError(503, "BSV rail is not configured (site wallet WIF missing)");
  const required = buildBsvPaymentRequired({
    resource: resourceChat(x402ChatUrl(request)),
    payTo,
    amountSats,
    invoiceId: typeof payload.accepted === "object" && isRecord(payload.accepted) && isRecord(payload.accepted.extra)
      ? String(payload.accepted.extra.invoiceId ?? "ad-hoc")
      : "ad-hoc",
    extra: { model: chat.model },
    bazaar: bazaarHttpExtension({ method: "POST", body: { model: chat.model, messages: [] } }),
  });
  const verified = verifyBsvPaymentPayload(payload, required.accepts[0] as unknown as Record<string, unknown>);
  if (!verified.isValid) {
    const settlement: SettlementResponse = {
      success: false,
      errorReason: verified.invalidReason ?? "invalid_payload",
      transaction: "",
      network: BSV_NETWORK,
      payer: verified.payer,
    };
    return new Response(JSON.stringify({ error: verified.invalidReason, ...settlement }), {
      status: 402,
      headers: { "content-type": "application/json", ...settlementHeaders(settlement) },
    });
  }

  const quote = await quoteFuseChat(env, chat);
  const prepared = await prepareBsvPayment(env, quote.requirements);
  const fuseRes = await callFuseChatPaid(env, chat, prepared.paymentSignature);
  const text = await fuseRes.text().catch(() => "");
  if (!fuseRes.ok) {
    throw new HttpError(fuseRes.status === 402 ? 402 : 502, `Fuse rejected after buyer verify (${fuseRes.status})`);
  }

  const settlement = await settleClientPayment(env, payload, required.accepts[0]);
  if (!settlement.success && settlement.errorReason !== "settlement_pending") {
    return new Response(JSON.stringify({ error: settlement.errorReason, ...settlement }), {
      status: 402,
      headers: { "content-type": "application/json", ...settlementHeaders(settlement) },
    });
  }

  const invoiceId =
    isRecord(payload.accepted) && isRecord(payload.accepted.extra) ? String(payload.accepted.extra.invoiceId ?? "") : "";
  if (invoiceId && env.DB) {
    const prev = (await loadInvoice(env.DB, invoiceId)) ?? {};
    await recordInvoice(env.DB, invoiceId, { ...prev, settledTxid: settlement.transaction, fuseTxid: prepared.txid });
  }

  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return new Response(
    JSON.stringify({
      ...(isRecord(json) ? json : { result: json }),
      settlement,
      fuseTxid: prepared.txid,
      receiptUrl: `${PUBLIC_SITE}${API_PREFIX}/x402/chat`,
    }),
    { status: 200, headers: { "content-type": "application/json", ...settlementHeaders(settlement) } },
  );
}

export async function fulfillPaidExtract(
  env: AppEnv,
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const extract: FuseExtractRequest = parseFuseExtractBody(body);
  const quote = await quoteFuseExtract(env, extract);
  const size = quote.size ?? "S";
  const amountSats = listPriceSats("extract", env, String(size));
  const payTo = siteWalletAddress(env);
  if (!payTo) throw new HttpError(503, "BSV rail is not configured (site wallet WIF missing)");
  const required = buildBsvPaymentRequired({
    resource: resourceExtract(x402ExtractUrl(request)),
    payTo,
    amountSats,
    invoiceId:
      isRecord(payload.accepted) && isRecord(payload.accepted.extra) ? String(payload.accepted.extra.invoiceId ?? "ad-hoc") : "ad-hoc",
    extra: { size },
    bazaar: bazaarHttpExtension({ method: "POST", body: { state: "", fields: {} } }),
  });
  const verified = verifyBsvPaymentPayload(payload, required.accepts[0] as unknown as Record<string, unknown>);
  if (!verified.isValid) {
    const settlement: SettlementResponse = {
      success: false,
      errorReason: verified.invalidReason ?? "invalid_payload",
      transaction: "",
      network: BSV_NETWORK,
      payer: verified.payer,
    };
    return new Response(JSON.stringify({ error: verified.invalidReason, ...settlement }), {
      status: 402,
      headers: { "content-type": "application/json", ...settlementHeaders(settlement) },
    });
  }
  const prepared = await prepareBsvPayment(env, quote.requirements);
  const fuseRes = await callFuseExtractPaid(env, extract, prepared.paymentSignature);
  const text = await fuseRes.text().catch(() => "");
  if (!fuseRes.ok) {
    throw new HttpError(fuseRes.status === 402 ? 402 : 502, `Fuse extract rejected after buyer verify (${fuseRes.status})`);
  }
  const settlement = await settleClientPayment(env, payload, required.accepts[0]);
  let answers: unknown = null;
  try {
    answers = parseFuseExtractResult(JSON.parse(text));
  } catch {
    try {
      answers = JSON.parse(text);
    } catch {
      answers = { raw: text.slice(0, 400) };
    }
  }
  return new Response(
    JSON.stringify({ answers, settlement, fuseTxid: prepared.txid, size }),
    { status: 200, headers: { "content-type": "application/json", ...settlementHeaders(settlement) } },
  );
}

export { facilitatorSupported };
