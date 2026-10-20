/**
 * Fuse pay-per-call LLM — agentpay as the BUYER.
 *
 * Same-zone `fetch("https://entangleit.com/fuse/...")` 405s at origin
 * (Cloudflare does not loop a Worker subrequest back to another Worker on
 * the same zone). Production calls go through the FUSE service binding;
 * FUSE_CHAT_URL is the fetch fallback when the binding is absent.
 *
 * The Request URL on the binding is always the public chat URL so Fuse
 * writes entangleit.com into x402 resource fields and receipts.
 */
import { HttpError, type AppEnv } from "./types";
import {
  decodePaymentRequiredHeader,
  parseBsvRequirements,
  type BsvRequirements,
} from "./x402";
import { paymentSignatureHeaders, readPaymentRequiredHeader } from "./x402-spec";

export const FUSE_SERVICE_ID = "fuse";
/** Public chat completions URL — always used in x402 resource/receipt fields. */
export const FUSE_PUBLIC_CHAT_URL = "https://entangleit.com/fuse/v1/chat/completions";
export const FUSE_PUBLIC_EXTRACT_URL = "https://entangleit.com/fuse/v1/extract";
export const FUSE_DEFAULT_URL = FUSE_PUBLIC_CHAT_URL;
export const FUSE_CHAT_PATH = "/fuse/v1/chat/completions";
export const FUSE_EXTRACT_PATH = "/fuse/v1/extract";
export const FUSE_MODELS_URL = "https://entangleit.com/fuse/v1/models";
export const FUSE_DOCS_URL = "https://entangleit.com/fuse/pay";
export const FUSE_DISCOVERY_URL = "https://entangleit.com/fuse/.well-known/x402";
export const FUSE_DEFAULT_MODEL = "fuse-fast";
export const FUSE_MODELS = ["fuse-fast", "fuse-smart"] as const;
export const FUSE_EXTRACT_MODEL = "fuse-extract";
export type FuseModel = (typeof FUSE_MODELS)[number];

export const FUSE_CHAT_TIMEOUT_MS = 60_000;
export const FUSE_EXTRACT_TIMEOUT_MS = 90_000;
const MAX_MESSAGES = 32;
const MAX_CONTENT_CHARS = 24_000;

/** Prepaid extract tiers. Fuse chooses the tier from request size before the 402. */
export const FUSE_EXTRACT_TIER_SATS = { S: 3_500, M: 15_000, L: 50_000 } as const;
export type FuseExtractSize = keyof typeof FUSE_EXTRACT_TIER_SATS;
export const FUSE_EXTRACT_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "time",
  "datetime",
  "duration",
  "list",
  "estimate",
  "forecast",
] as const;
export type FuseExtractFieldType = (typeof FUSE_EXTRACT_FIELD_TYPES)[number];
export const FUSE_EXTRACT_S_STATE_CHARS = 1_500;
export const FUSE_EXTRACT_S_MAX_FIELDS = 8;
export const FUSE_EXTRACT_M_STATE_CHARS = 6_000;
export const FUSE_EXTRACT_L_STATE_CHARS = 16_000;
export const FUSE_EXTRACT_MAX_FIELDS = 30;
const MAX_EXTRACT_IMAGES = 32;
const MAX_EXTRACT_FIELD_NAME = 80;

/** Fetch fallback when the FUSE service binding is absent. */
export function fuseChatUrl(env: AppEnv): string {
  const raw = String(env.FUSE_CHAT_URL ?? "").trim();
  return raw || FUSE_PUBLIC_CHAT_URL;
}

/** Fetch fallback for extract. Prefer FUSE_EXTRACT_URL; else sibling of FUSE_CHAT_URL. */
export function fuseExtractUrl(env: AppEnv): string {
  const raw = String(env.FUSE_EXTRACT_URL ?? "").trim();
  if (raw) return raw;
  const chat = String(env.FUSE_CHAT_URL ?? "").trim();
  if (chat.includes("/chat/completions")) {
    return chat.replace(/\/chat\/completions\/?$/, "/extract");
  }
  return FUSE_PUBLIC_EXTRACT_URL;
}

export function fuseBindingConfigured(env: AppEnv): boolean {
  return Boolean(env.FUSE);
}

/**
 * Pin x402 resource.url to the public hostname even if Fuse echoed a
 * workers.dev (or binding-internal) URL from the transport we used.
 */
export function publicizeFuseChallenge(raw: unknown, url: string = FUSE_PUBLIC_CHAT_URL): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (obj.resource && typeof obj.resource === "object" && !Array.isArray(obj.resource)) {
    obj.resource = { ...(obj.resource as Record<string, unknown>), url };
  }
  return obj;
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

export type FuseFetchOpts = {
  paymentSignature?: string | null;
  timeoutMs?: number;
  /** Public URL written into x402 resource fields and used on the service binding. */
  publicUrl?: string;
  /** Fetch fallback when the FUSE binding is absent. */
  fetchUrl?: string;
};

export async function fuseFetch(env: AppEnv, body: unknown, opts: FuseFetchOpts = {}): Promise<Response> {
  const publicUrl = opts.publicUrl ?? FUSE_PUBLIC_CHAT_URL;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": fuseUserAgent(),
  });
  if (opts.paymentSignature) {
    for (const [key, value] of Object.entries(paymentSignatureHeaders(opts.paymentSignature))) {
      headers.set(key, value);
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? FUSE_CHAT_TIMEOUT_MS);
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: ctl.signal,
    redirect: "follow",
  };
  try {
    if (env.FUSE) {
      return await env.FUSE.fetch(new Request(publicUrl, init));
    }
    return await fetch(opts.fetchUrl ?? fuseChatUrl(env), init);
  } catch (e) {
    throw new HttpError(502, `Fuse unreachable: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function challengeFrom402(res: Response, bodyText: string): unknown {
  const header = readPaymentRequiredHeader(res.headers);
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
  model: string;
  requirements: BsvRequirements;
  raw: unknown;
  size?: FuseExtractSize | string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fuseHttpError(status: number, bodyText: string, fallback: string): HttpError {
  try {
    const json = JSON.parse(bodyText) as unknown;
    if (isRecord(json)) {
      const nested = isRecord(json.error) ? json.error : null;
      const msg =
        (typeof json.error === "string" ? json.error : null) ??
        (typeof nested?.message === "string" ? nested.message : null) ??
        (typeof json.message === "string" ? json.message : null) ??
        fallback;
      return new HttpError(status, msg.slice(0, 240), json);
    }
  } catch {
    /* not JSON */
  }
  return new HttpError(status, (bodyText || fallback).slice(0, 240));
}

/** Unsigned POST — expect 402 + standard x402 v2 accepts[]. */
export async function quoteFuseChat(env: AppEnv, body: FuseChatRequest): Promise<FuseQuote> {
  const res = await fuseFetch(env, body);
  const text = await res.text().catch(() => "");
  if (res.status !== 402) {
    throw new HttpError(502, `Fuse did not challenge (got ${res.status}, want 402)`);
  }
  const raw = publicizeFuseChallenge(challengeFrom402(res, text));
  return {
    url: FUSE_PUBLIC_CHAT_URL,
    model: body.model,
    requirements: parseBsvRequirements(raw),
    raw,
  };
}

export async function callFuseChat(
  env: AppEnv,
  body: FuseChatRequest,
  paymentSignature: string,
): Promise<Response> {
  return fuseFetch(env, body, { paymentSignature });
}

export const FUSE_RETRY_CODES = ["payment_unconfirmed", "empty_completion"] as const;
export const FUSE_FATAL_CODES = ["payment_double_spend", "payment_orphaned", "payment_rejected"] as const;
export const FUSE_PAID_ATTEMPTS = 4;

const KNOWN_FUSE_CODES = [...FUSE_RETRY_CODES, ...FUSE_FATAL_CODES];

export type FusePaidOpts = {
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
  publicUrl?: string;
  fetchUrl?: string;
};

const defaultPaidSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let paidSleepOverride: FusePaidOpts["sleep"] | null = null;

/** Test hook so retry tests do not wait on real backoff. */
export function setFusePaidSleepForTests(fn: FusePaidOpts["sleep"] | null): void {
  paidSleepOverride = fn;
}

/** Pull Fuse's machine error code out of a JSON (or text) body. */
export function parseFuseErrorCode(status: number, bodyText: string): string | null {
  const known = KNOWN_FUSE_CODES as readonly string[];
  const matchKnown = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (known.includes(trimmed)) return trimmed;
    const hit = known.find((code) => trimmed.includes(code));
    return hit ?? null;
  };
  try {
    const json = JSON.parse(bodyText) as unknown;
    if (isRecord(json)) {
      const nested = isRecord(json.error) ? json.error : null;
      const candidates: unknown[] = [
        json.code,
        json.error,
        json.error_code,
        json.reason,
        json.message,
        nested?.code,
        nested?.message,
        nested?.error,
      ];
      for (const c of candidates) {
        const hit = matchKnown(c);
        if (hit) return hit;
      }
    }
  } catch {
    /* not JSON */
  }
  const fromText = matchKnown(bodyText);
  if (fromText) return fromText;
  if (status === 502 && /empty[_ ]completion/i.test(bodyText)) return "empty_completion";
  return null;
}

function rebuildResponse(res: Response, bodyText: string): Response {
  return new Response(bodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function retryDelayMs(attempt: number): number {
  return Math.min(1_500, 300 * 2 ** attempt);
}

/**
 * Paid Fuse call. Resends the SAME PAYMENT-SIGNATURE on `payment_unconfirmed`
 * and `empty_completion`. `payment_double_spend` / `payment_orphaned` /
 * `payment_rejected` fail immediately.
 */
export async function callFusePaid(
  env: AppEnv,
  body: unknown,
  paymentSignature: string,
  opts: FusePaidOpts = {},
): Promise<Response> {
  const sleep = opts.sleep ?? paidSleepOverride ?? defaultPaidSleep;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? FUSE_PAID_ATTEMPTS);
  let lastCode: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fuseFetch(env, body, {
      paymentSignature,
      timeoutMs: opts.timeoutMs,
      publicUrl: opts.publicUrl,
      fetchUrl: opts.fetchUrl,
    });
    const text = await res.text().catch(() => "");
    const rebuilt = rebuildResponse(res, text);
    if (res.ok) return rebuilt;
    const code = parseFuseErrorCode(res.status, text);
    lastCode = code;
    if (code && (FUSE_FATAL_CODES as readonly string[]).includes(code)) {
      throw new HttpError(res.status === 402 ? 402 : 502, `Fuse payment failed (${code})`, { code });
    }
    const retryable = Boolean(code && (FUSE_RETRY_CODES as readonly string[]).includes(code));
    if (!retryable) return rebuilt;
    if (attempt + 1 >= maxAttempts) break;
    await sleep(retryDelayMs(attempt));
  }
  const status = lastCode === "empty_completion" ? 502 : 402;
  throw new HttpError(
    status,
    `Fuse payment failed (${lastCode ?? "retry_exhausted"}) after ${maxAttempts} attempts`,
    lastCode ? { code: lastCode } : undefined,
  );
}

export async function callFuseChatPaid(
  env: AppEnv,
  body: FuseChatRequest,
  paymentSignature: string,
  opts: FusePaidOpts = {},
): Promise<Response> {
  return callFusePaid(env, body, paymentSignature, opts);
}

export interface FuseExtractField {
  name: string;
  type: FuseExtractFieldType;
  description?: string;
  items?: FuseExtractField;
}

export interface FuseExtractRequest {
  state: string;
  fields: FuseExtractField[];
  reference_date?: string;
  images?: string[];
}

function isFieldType(value: unknown): value is FuseExtractFieldType {
  return typeof value === "string" && (FUSE_EXTRACT_FIELD_TYPES as readonly string[]).includes(value);
}

function parseExtractField(raw: unknown, name: string, path: string, depth: number): FuseExtractField {
  if (depth > 4) throw new HttpError(400, `${path} is nested too deeply`);
  if (typeof raw === "string") {
    if (!isFieldType(raw)) {
      throw new HttpError(400, `${path} type must be one of ${FUSE_EXTRACT_FIELD_TYPES.join("|")}`);
    }
    return { name, type: raw };
  }
  if (!isRecord(raw)) throw new HttpError(400, `${path} must be a typed field spec`);
  const resolvedName = (typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : name).trim();
  if (!resolvedName || resolvedName.length > MAX_EXTRACT_FIELD_NAME) {
    throw new HttpError(400, `${path} needs a field name (max ${MAX_EXTRACT_FIELD_NAME})`);
  }
  if (!isFieldType(raw.type)) {
    throw new HttpError(400, `${path}: type must be one of ${FUSE_EXTRACT_FIELD_TYPES.join("|")}`);
  }
  const field: FuseExtractField = { name: resolvedName, type: raw.type };
  if (raw.description !== undefined && raw.description !== null && raw.description !== "") {
    if (typeof raw.description !== "string") throw new HttpError(400, `${path}.description must be a string`);
    field.description = raw.description.trim().slice(0, 400);
  }
  if (raw.type === "list") {
    if (raw.items === undefined || raw.items === null) {
      throw new HttpError(400, `${path}: list fields require items (e.g. "text")`);
    }
    const itemsRaw = Array.isArray(raw.items) ? raw.items[0] : raw.items;
    field.items = parseExtractField(itemsRaw, "item", `${path}.items`, depth + 1);
  } else if (raw.items !== undefined && raw.items !== null) {
    throw new HttpError(400, `${path}.items is only valid when type is list`);
  }
  return field;
}

function parseExtractFields(raw: unknown): FuseExtractField[] {
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new HttpError(400, "fields must be a non-empty object or array");
    if (raw.length > FUSE_EXTRACT_MAX_FIELDS) {
      throw new HttpError(413, `At most ${FUSE_EXTRACT_MAX_FIELDS} fields are accepted (got ${raw.length}).`);
    }
    const seen = new Set<string>();
    const fields: FuseExtractField[] = [];
    for (let i = 0; i < raw.length; i++) {
      const field = parseExtractField(raw[i], "", `fields[${i}]`, 0);
      if (seen.has(field.name)) throw new HttpError(400, `fields.${field.name} is duplicated`);
      seen.add(field.name);
      fields.push(field);
    }
    return fields;
  }
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw new HttpError(400, "`fields` must be an object mapping names to typed specs.");
  }
  const names = Object.keys(raw);
  if (names.length > FUSE_EXTRACT_MAX_FIELDS) {
    throw new HttpError(413, `At most ${FUSE_EXTRACT_MAX_FIELDS} fields are accepted (got ${names.length}).`);
  }
  return names.map((name) => parseExtractField(raw[name], name, `fields.${name}`, 0));
}

function parseExtractImage(raw: unknown, path: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpError(400, `${path} must be a non-empty base64 PNG, JPEG, or WebP (or data URI)`);
  }
  const img = raw.trim();
  if (/^https?:\/\//i.test(img)) {
    throw new HttpError(400, "Remote image URLs are not accepted; send base64 PNG, JPEG, or WebP.");
  }
  return img;
}

export function parseFuseExtractBody(body: {
  state?: unknown;
  fields?: unknown;
  reference_date?: unknown;
  referenceDate?: unknown;
  images?: unknown;
}): FuseExtractRequest {
  if (body.state !== undefined && body.state !== null && typeof body.state !== "string") {
    throw new HttpError(400, "state must be a string");
  }
  const state = typeof body.state === "string" ? body.state : "";
  if (state.length > FUSE_EXTRACT_L_STATE_CHARS) {
    throw new HttpError(
      413,
      `State is limited to ${FUSE_EXTRACT_L_STATE_CHARS.toLocaleString()} characters (got ${state.length.toLocaleString()}).`,
    );
  }
  const fields = parseExtractFields(body.fields);

  const images: string[] = [];
  if (body.images !== undefined && body.images !== null) {
    if (!Array.isArray(body.images)) throw new HttpError(400, "images must be an array of strings");
    if (body.images.length > MAX_EXTRACT_IMAGES) {
      throw new HttpError(413, `images is capped at ${MAX_EXTRACT_IMAGES}`);
    }
    for (let i = 0; i < body.images.length; i++) {
      images.push(parseExtractImage(body.images[i], `images[${i}]`));
    }
  }

  if (!state.trim() && images.length === 0) {
    throw new HttpError(400, "`state` must be non-empty unless images are sent.");
  }

  const out: FuseExtractRequest = { state, fields };
  if (images.length) out.images = images;

  const refRaw = body.reference_date ?? body.referenceDate;
  if (refRaw !== undefined && refRaw !== null && refRaw !== "") {
    if (typeof refRaw !== "string" || !refRaw.trim()) {
      throw new HttpError(400, "reference_date must be a string");
    }
    const ref = refRaw.trim();
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.+-Z]+)?$/.test(ref)) {
      throw new HttpError(400, "reference_date must be YYYY-MM-DD or an ISO datetime");
    }
    out.reference_date = ref;
  }

  return out;
}

function fieldSpecWire(field: FuseExtractField): Record<string, unknown> {
  const spec: Record<string, unknown> = { type: field.type };
  if (field.description) spec.description = field.description;
  if (field.items) {
    spec.items = field.items.description || field.items.items ? fieldSpecWire(field.items) : field.items.type;
  }
  return spec;
}

/** Wire body Fuse extract expects (fields as a name → spec object). */
export function fuseExtractPayload(req: FuseExtractRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of req.fields) fields[field.name] = fieldSpecWire(field);
  const payload: Record<string, unknown> = { state: req.state, fields };
  if (req.reference_date) payload.reference_date = req.reference_date;
  if (req.images?.length) payload.images = req.images;
  return payload;
}

/** S when the request fits the prepaid S envelope; otherwise Fuse prices M or L. */
export function isExtractSmallTier(req: FuseExtractRequest): boolean {
  if (req.images?.length) return false;
  return req.state.length <= FUSE_EXTRACT_S_STATE_CHARS && req.fields.length <= FUSE_EXTRACT_S_MAX_FIELDS;
}

export function sizeFromExtractSats(sats: number): FuseExtractSize {
  if (sats <= FUSE_EXTRACT_TIER_SATS.S) return "S";
  if (sats <= FUSE_EXTRACT_TIER_SATS.M) return "M";
  return "L";
}

function extraFromChallenge(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.accepts)) {
    const first = raw.accepts.find((entry) => isRecord(entry) && isRecord(entry.extra));
    return first && isRecord(first) && isRecord(first.extra) ? first.extra : null;
  }
  return isRecord(raw.extra) ? raw.extra : null;
}

export function extractSizeFromChallenge(raw: unknown, satoshis: number): FuseExtractSize | string {
  const extra = extraFromChallenge(raw);
  const labeled = extra?.size ?? extra?.tier;
  if (typeof labeled === "string" && labeled.trim()) {
    const t = labeled.trim().toUpperCase();
    if (t === "S" || t === "M" || t === "L") return t;
    return labeled.trim();
  }
  return sizeFromExtractSats(satoshis);
}

export async function quoteFuseExtract(env: AppEnv, body: FuseExtractRequest): Promise<FuseQuote> {
  const res = await fuseFetch(env, fuseExtractPayload(body), {
    publicUrl: FUSE_PUBLIC_EXTRACT_URL,
    fetchUrl: fuseExtractUrl(env),
    timeoutMs: FUSE_EXTRACT_TIMEOUT_MS,
  });
  const text = await res.text().catch(() => "");
  if (res.status === 400) throw fuseHttpError(400, text, "invalid extract request");
  if (res.status === 413) throw fuseHttpError(413, text, "extract request is too large");
  if (res.status === 404) {
    throw new HttpError(502, "Fuse extract is not available yet");
  }
  if (res.status !== 402) {
    throw new HttpError(502, `Fuse did not challenge (got ${res.status}, want 402)`);
  }
  const raw = publicizeFuseChallenge(challengeFrom402(res, text), FUSE_PUBLIC_EXTRACT_URL);
  const requirements = parseBsvRequirements(raw);
  return {
    url: FUSE_PUBLIC_EXTRACT_URL,
    model: FUSE_EXTRACT_MODEL,
    requirements,
    raw,
    size: extractSizeFromChallenge(raw, requirements.satoshis),
  };
}

export async function callFuseExtractPaid(
  env: AppEnv,
  body: FuseExtractRequest,
  paymentSignature: string,
  opts: FusePaidOpts = {},
): Promise<Response> {
  return callFusePaid(env, fuseExtractPayload(body), paymentSignature, {
    ...opts,
    publicUrl: FUSE_PUBLIC_EXTRACT_URL,
    fetchUrl: fuseExtractUrl(env),
    timeoutMs: opts.timeoutMs ?? FUSE_EXTRACT_TIMEOUT_MS,
  });
}

export interface FuseExtractAnswer {
  value: unknown;
  p_null: number;
  confidence?: number;
  span?: unknown;
  spans?: unknown;
  [key: string]: unknown;
}

export interface FuseExtractResult {
  model: string;
  size: FuseExtractSize | string | null;
  answers: Record<string, FuseExtractAnswer | unknown>;
  usage: { input_tokens?: number; passes?: number; [key: string]: unknown } | null;
  receipt: unknown;
  txid: string | null;
  raw: unknown;
}

export function parseFuseExtractResult(json: unknown): FuseExtractResult {
  if (!isRecord(json)) {
    return { model: FUSE_EXTRACT_MODEL, size: null, answers: {}, usage: null, receipt: null, txid: null, raw: json };
  }
  const answers = isRecord(json.answers) ? json.answers : {};
  const usage = isRecord(json.usage) ? json.usage : null;
  const size = typeof json.size === "string" && json.size ? json.size : null;
  const txid = typeof json.txid === "string" && /^[0-9a-f]{64}$/i.test(json.txid) ? json.txid : null;
  return {
    model: typeof json.model === "string" && json.model ? json.model : FUSE_EXTRACT_MODEL,
    size,
    answers,
    usage,
    receipt: json.receipt ?? null,
    txid,
    raw: json,
  };
}
