/**
 * Fuse pay-per-call LLM — agentpay as the BUYER.
 *
 * POST https://entangleit.com/fuse/v1/chat/completions returns a standard
 * x402 v2 402 (`accepts[]`, BSV `exact` / `bsv:mainnet` / asset `BSV`).
 * We settle it with the same site-wallet rail as pay_service. No Fuse API key.
 */
import { HttpError, type AppEnv } from "./types";
import {
  decodePaymentRequiredHeader,
  parseBsvRequirements,
  type BsvRequirements,
} from "./x402";

export const FUSE_SERVICE_ID = "fuse";
export const FUSE_DEFAULT_URL = "https://entangleit.com/fuse/v1/chat/completions";
export const FUSE_MODELS_URL = "https://entangleit.com/fuse/v1/models";
export const FUSE_DOCS_URL = "https://entangleit.com/fuse/pay";
export const FUSE_DISCOVERY_URL = "https://entangleit.com/fuse/.well-known/x402";
export const FUSE_DEFAULT_MODEL = "fuse-fast";
export const FUSE_MODELS = ["fuse-fast", "fuse-smart"] as const;
export type FuseModel = (typeof FUSE_MODELS)[number];

export const FUSE_CHAT_TIMEOUT_MS = 60_000;
const MAX_MESSAGES = 32;
const MAX_CONTENT_CHARS = 24_000;

export function fuseChatUrl(env: AppEnv): string {
  const raw = String(env.FUSE_CHAT_URL ?? "").trim();
  return raw || FUSE_DEFAULT_URL;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FuseChatRequest {
  model: FuseModel;
  messages: ChatMessage[];
  max_tokens?: number;
}

function isRole(value: unknown): value is ChatMessage["role"] {
  return value === "system" || value === "user" || value === "assistant";
}

export function parseChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, "messages must be a non-empty array");
  }
  if (raw.length > MAX_MESSAGES) {
    throw new HttpError(400, `messages is capped at ${MAX_MESSAGES}`);
  }
  let total = 0;
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "each message must be { role, content }");
    }
    const row = item as { role?: unknown; content?: unknown };
    if (!isRole(row.role)) {
      throw new HttpError(400, "message.role must be system, user, or assistant");
    }
    const content = typeof row.content === "string" ? row.content : "";
    if (!content) throw new HttpError(400, "message.content must be a non-empty string");
    total += content.length;
    if (total > MAX_CONTENT_CHARS) {
      throw new HttpError(400, `messages content is capped at ${MAX_CONTENT_CHARS} characters`);
    }
    messages.push({ role: row.role, content });
  }
  return messages;
}

export function parseFuseModel(raw: unknown): FuseModel {
  const model = typeof raw === "string" && raw.trim() ? raw.trim() : FUSE_DEFAULT_MODEL;
  if ((FUSE_MODELS as readonly string[]).includes(model)) return model as FuseModel;
  throw new HttpError(400, `Unknown model "${model}" — use ${FUSE_MODELS.join(" or ")}`);
}

export function parseFuseChatBody(body: {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  maxTokens?: unknown;
}): FuseChatRequest {
  const model = parseFuseModel(body.model);
  const messages = parseChatMessages(body.messages);
  const maxRaw = body.max_tokens ?? body.maxTokens;
  let max_tokens: number | undefined;
  if (maxRaw !== undefined && maxRaw !== null && maxRaw !== "") {
    const n = Number(maxRaw);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "max_tokens must be a positive integer");
    max_tokens = n;
  }
  return max_tokens !== undefined ? { model, messages, max_tokens } : { model, messages };
}

export function fuseUserAgent(): string {
  return "agentpay-payer/1.0 (+https://entangleit.com/agentpay)";
}

async function fuseFetch(
  url: string,
  body: FuseChatRequest,
  opts: { paymentSignature?: string | null; timeoutMs?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": fuseUserAgent(),
  };
  if (opts.paymentSignature) headers["PAYMENT-SIGNATURE"] = opts.paymentSignature;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? FUSE_CHAT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: "follow",
    });
  } catch (e) {
    throw new HttpError(502, `Fuse unreachable: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function challengeFrom402(res: Response, bodyText: string): unknown {
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (header) {
    try {
      return decodePaymentRequiredHeader(header);
    } catch {
      throw new HttpError(502, "PAYMENT-REQUIRED is not decodable");
    }
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new HttpError(502, "402 without PAYMENT-REQUIRED header");
  }
}

export interface FuseQuote {
  url: string;
  model: FuseModel;
  requirements: BsvRequirements;
  raw: unknown;
}

/** Unsigned POST — expect 402 + standard x402 v2 accepts[]. */
export async function quoteFuseChat(url: string, body: FuseChatRequest): Promise<FuseQuote> {
  const res = await fuseFetch(url, body);
  const text = await res.text().catch(() => "");
  if (res.status !== 402) {
    throw new HttpError(502, `Fuse did not challenge (got ${res.status}, want 402)`);
  }
  const raw = challengeFrom402(res, text);
  return { url, model: body.model, requirements: parseBsvRequirements(raw), raw };
}

export async function callFuseChat(
  url: string,
  body: FuseChatRequest,
  paymentSignature: string,
): Promise<Response> {
  return fuseFetch(url, body, { paymentSignature });
}
