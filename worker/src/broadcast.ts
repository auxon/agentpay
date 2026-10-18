/**
 * Multi-endpoint BSV broadcast + status for treasury payments.
 *
 * GorillaPool ARC alone can take tens of minutes to show a tx (or orphan a
 * child of a parent it has not indexed). We submit EF/BEEF to GorillaPool and
 * TAAL, raw hex to WhatsOnChain, then read ARC tx status. Double-spend and
 * orphan are hard failures; a total miss still returns the signed tx so the
 * seller can broadcast.
 */
import { Transaction } from "@bsv/sdk";
import { HttpError, type AppEnv } from "./types";

export const ARC_GORILLA = "https://arc.gorillapool.io/v1";
export const ARC_TAAL = "https://arc.taal.com/v1";
export const WOC_BROADCAST = "https://api.whatsonchain.com/v1/bsv/main/tx/raw";

const FAIL_STATUS = /DOUBLE_SPEND|ORPHAN|REJECTED/;

export type BroadcastSleep = (ms: number) => Promise<void>;

export interface BroadcastOpts {
  fetch?: typeof fetch;
  sleep?: BroadcastSleep;
  pollAttempts?: number;
  pollMs?: number;
}

export interface BroadcastResult {
  txid: string;
  accepted: boolean;
  via: string[];
  status: string | null;
}

function bytesToHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function txHexEF(tx: Transaction): string | null {
  try {
    return tx.toHexEF();
  } catch {
    return null;
  }
}

export function txHexBEEF(tx: Transaction): string | null {
  try {
    return tx.toHexBEEF();
  } catch {
    try {
      return bytesToHex(tx.toBEEF(true));
    } catch {
      return null;
    }
  }
}

export function arcEndpoints(env: AppEnv): string[] {
  const listed = [
    env.ARC_URL,
    env.ARC_FALLBACK_URL,
    ARC_GORILLA,
    ARC_TAAL,
  ]
    .map((u) => String(u ?? "").trim().replace(/\/$/, ""))
    .filter(Boolean);
  return [...new Set(listed)];
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function txStatusOf(json: Record<string, unknown>, text = ""): string {
  const raw = json.txStatus ?? json.tx_status ?? json.status ?? json.title ?? json.detail ?? "";
  return `${String(raw)} ${text}`.trim();
}

export function isBroadcastFailureStatus(status: string): boolean {
  return FAIL_STATUS.test(status.toUpperCase());
}

async function postJson(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, text, json: parseJson(text) };
}

async function submitArc(
  doFetch: typeof fetch,
  base: string,
  rawTx: string,
  apiKey?: string,
): Promise<{ via: string; ok: boolean; fail: boolean; status: string; text: string }> {
  const headers: Record<string, string> = { "xdeployment-id": "agentpay-x402-v1" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }
  try {
    const { status, text, json } = await postJson(doFetch, `${base}/tx`, headers, { rawTx });
    const txStatus = txStatusOf(json, text);
    const fail = status === 409 || isBroadcastFailureStatus(txStatus);
    const ok = status >= 200 && status < 300 && !fail;
    return { via: base, ok, fail, status: txStatus, text };
  } catch (err) {
    return { via: base, ok: false, fail: false, status: "", text: String((err as Error)?.message ?? err) };
  }
}

async function submitWoc(
  doFetch: typeof fetch,
  rawHex: string,
): Promise<{ via: string; ok: boolean; fail: boolean; status: string; text: string }> {
  try {
    const { status, text, json } = await postJson(doFetch, WOC_BROADCAST, {}, { txhex: rawHex });
    const txStatus = txStatusOf(json, text);
    const fail = isBroadcastFailureStatus(txStatus) || /double.?spend|orphan/i.test(text);
    const ok = (status >= 200 && status < 300 && !fail) || (status === 200 && Boolean(text));
    return { via: "whatsonchain", ok, fail, status: txStatus || text.slice(0, 80), text };
  } catch (err) {
    return { via: "whatsonchain", ok: false, fail: false, status: "", text: String((err as Error)?.message ?? err) };
  }
}

async function readArcStatus(
  doFetch: typeof fetch,
  base: string,
  txid: string,
  apiKey?: string,
): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }
    const res = await doFetch(`${base}/tx/${txid}`, { headers });
    if (!res.ok) return null;
    const text = await res.text().catch(() => "");
    const json = parseJson(text);
    return txStatusOf(json, "");
  } catch {
    return null;
  }
}

const defaultSleep: BroadcastSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Broadcast to GorillaPool + TAAL (EF/BEEF) and WhatsOnChain (raw). Throws on
 * double-spend / orphan / rejected. Returns accepted:false when every endpoint
 * misses (tests, indexer down) — caller still has a signed payment.
 */
export async function broadcastPaymentTx(
  env: AppEnv,
  tx: Transaction,
  opts: BroadcastOpts = {},
): Promise<BroadcastResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const txid = tx.id("hex");
  const raw = tx.toHex();
  const beef = txHexBEEF(tx);
  const ef = txHexEF(tx);
  const rawTx = beef ?? ef ?? raw;
  const apiKey = env.ARC_API_KEY?.trim();
  const arcs = arcEndpoints(env);

  const results = await Promise.all([
    ...arcs.map((base) => submitArc(doFetch, base, rawTx, apiKey)),
    submitWoc(doFetch, raw),
  ]);

  const failed = results.find((r) => r.fail);
  if (failed) {
    throw new HttpError(
      502,
      `Payment tx ${txid} rejected (${failed.status || "double-spend/orphan"} via ${failed.via})`,
    );
  }

  const via = results.filter((r) => r.ok).map((r) => r.via);
  if (via.length === 0) {
    return { txid, accepted: false, via: [], status: null };
  }

  const pollAttempts = opts.pollAttempts ?? 3;
  const pollMs = opts.pollMs ?? 250;
  let lastStatus: string | null = results.find((r) => r.ok)?.status ?? null;
  for (let i = 0; i < pollAttempts; i++) {
    if (i > 0) await sleep(pollMs);
    for (const base of arcs) {
      const status = await readArcStatus(doFetch, base, txid, apiKey);
      if (!status) continue;
      lastStatus = status;
      if (isBroadcastFailureStatus(status)) {
        throw new HttpError(502, `Payment tx ${txid} ${status} via ${base}`);
      }
    }
  }
  return { txid, accepted: true, via, status: lastStatus };
}
