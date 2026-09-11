/**
 * Wallet alerts: signed webhook deliveries + optional email via Resend.
 *
 * Every event is fire-and-forget (`ctx.waitUntil`), persists a delivery row,
 * and never blocks the money path. The webhook secret signs
 * `HMAC-SHA256(secret, "<unix-seconds>.<body>")`; receivers should compare in
 * constant time and reject timestamps older than ~5 minutes.
 */
import { HttpError, type AppEnv, type ApprovalRow, type WalletRow } from "./types";
import { cleanStr, newId, nowIso, randomHex } from "./ids";

export const ALERT_EVENTS = ["approval_required", "approval_decided", "spend", "low_balance", "budget_exhausted"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export interface WebhookRow {
  wallet_id: string;
  url: string;
  secret: string;
  events_json: string;
  low_balance_cents: number;
  active: number;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_error: string | null;
}

export interface DeliveryRow {
  id: string;
  wallet_id: string;
  event: string;
  payload_json: string;
  status_code: number | null;
  error: string;
  delivered_at: string | null;
  created_at: string;
}

export const WEBHOOK_URL_MAX = 2048;
export const MAX_REPORT_LINKS = 20;

export function webhookSecret(): string {
  return `awh_${randomHex(24)}`;
}

export function isValidWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > WEBHOOK_URL_MAX) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function parseAlertEvents(value: unknown): AlertEvent[] {
  let list: unknown[] = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string") {
    const raw = value.trim();
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = raw.split(",");
      }
    } else {
      list = raw.split(",");
    }
  }
  const cleaned = list
    .map((v) => String(v).trim())
    .filter((v): v is AlertEvent => (ALERT_EVENTS as readonly string[]).includes(v));
  return [...new Set(cleaned)];
}

export function lowBalanceDefault(env: AppEnv): number {
  const n = Number.parseInt(env.LOW_BALANCE_CENTS ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 500;
}

export async function getWebhook(db: D1Database, walletId: string): Promise<WebhookRow | null> {
  return db.prepare("SELECT * FROM ap_wallet_webhooks WHERE wallet_id = ?").bind(walletId).first<WebhookRow>();
}

export async function setWebhook(
  db: D1Database,
  walletId: string,
  input: { url: string; events: AlertEvent[]; lowBalanceCents: number },
): Promise<WebhookRow> {
  const existing = await getWebhook(db, walletId);
  const secret = existing?.secret ?? webhookSecret();
  await db
    .prepare(
      `INSERT INTO ap_wallet_webhooks (wallet_id, url, secret, events_json, low_balance_cents, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(wallet_id) DO UPDATE SET
         url = excluded.url,
         events_json = excluded.events_json,
         low_balance_cents = excluded.low_balance_cents,
         active = 1,
         updated_at = excluded.updated_at`,
    )
    .bind(walletId, input.url, secret, JSON.stringify(input.events), input.lowBalanceCents, nowIso(), nowIso())
    .run();
  const row = await getWebhook(db, walletId);
  if (!row) throw new HttpError(500, "Webhook save failed");
  return row;
}

export async function rotateWebhookSecret(db: D1Database, walletId: string): Promise<WebhookRow | null> {
  const existing = await getWebhook(db, walletId);
  if (!existing) return null;
  const secret = webhookSecret();
  await db
    .prepare("UPDATE ap_wallet_webhooks SET secret = ?, updated_at = ? WHERE wallet_id = ?")
    .bind(secret, nowIso(), walletId)
    .run();
  return getWebhook(db, walletId);
}

export async function deleteWebhook(db: D1Database, walletId: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM ap_wallet_webhooks WHERE wallet_id = ?").bind(walletId).run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function listDeliveries(db: D1Database, walletId: string, limit = 25): Promise<DeliveryRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM ap_webhook_deliveries WHERE wallet_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .bind(walletId, Math.min(Math.max(1, limit), 100))
    .all<DeliveryRow>();
  return results ?? [];
}

export async function hmacSign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postToHook(
  hook: WebhookRow,
  event: string,
  data: Record<string, unknown>,
): Promise<{ payload: string; statusCode: number | null; error: string }> {
  const payload = JSON.stringify({ event, walletId: hook.wallet_id, at: nowIso(), data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacSign(hook.secret, timestamp, payload);
  let statusCode: number | null = null;
  let error = "";
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "agentpay-webhooks/1",
        "X-Agentpay-Event": event,
        "X-Agentpay-Timestamp": timestamp,
        "X-Agentpay-Signature": `sha256=${signature}`,
      },
      body: payload,
    });
    statusCode = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 300);
  }
  return { payload, statusCode, error };
}

async function markHookResult(env: AppEnv, hook: WebhookRow, error: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE ap_wallet_webhooks SET last_success_at = CASE WHEN ? = '' THEN ? ELSE last_success_at END, last_error = ?, updated_at = ? WHERE wallet_id = ?",
  )
    .bind(error, nowIso(), error, nowIso(), hook.wallet_id)
    .run();
}

async function deliver(
  env: AppEnv,
  hook: WebhookRow,
  event: AlertEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const { payload, statusCode, error } = await postToHook(hook, event, data);
  const id = newId("apd");
  await env.DB.prepare(
    "INSERT INTO ap_webhook_deliveries (id, wallet_id, event, payload_json, status_code, error, delivered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, hook.wallet_id, event, payload, statusCode, error, error ? null : nowIso(), nowIso())
    .run();
  await markHookResult(env, hook, error);
}

/** Fire-and-forget: checks subscription, signs, delivers, logs. Never throws. */
export async function dispatchEvent(
  env: AppEnv,
  walletId: string,
  event: AlertEvent,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const hook = await getWebhook(env.DB, walletId);
    if (!hook || hook.active !== 1) return;
    const events = JSON.parse(hook.events_json) as string[];
    if (!events.includes(event) && !events.includes("*")) return;
    await deliver(env, hook, event, data);
  } catch (err) {
    console.error("[agentpay-notify]", event, err);
  }
}

/** Redeliver every failed delivery for a wallet (bounded). Returns counts. */
export async function redeliverFailed(
  env: AppEnv,
  walletId: string,
  limit = 25,
): Promise<{ attempted: number; delivered: number; remaining: number }> {
  const hook = await getWebhook(env.DB, walletId);
  if (!hook) return { attempted: 0, delivered: 0, remaining: 0 };
  const { results } = await env.DB.prepare(
    "SELECT * FROM ap_webhook_deliveries WHERE wallet_id = ? AND delivered_at IS NULL ORDER BY created_at ASC LIMIT ?",
  )
    .bind(walletId, Math.min(Math.max(1, limit), 100))
    .all<DeliveryRow>();
  let delivered = 0;
  for (const row of results ?? []) {
    const payload = JSON.parse(row.payload_json) as { event: AlertEvent; data?: Record<string, unknown> };
    const attempt = await postToHook(hook, payload.event, payload.data ?? {});
    await env.DB.prepare(
      "UPDATE ap_webhook_deliveries SET status_code = ?, error = ?, delivered_at = ? WHERE id = ?",
    )
      .bind(attempt.statusCode, attempt.error, attempt.error ? null : nowIso(), row.id)
      .run();
    if (!attempt.error) delivered += 1;
    await markHookResult(env, hook, attempt.error);
  }
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM ap_webhook_deliveries WHERE wallet_id = ? AND delivered_at IS NULL",
  )
    .bind(walletId)
    .first<{ n: number }>();
  return { attempted: (results ?? []).length, delivered, remaining: Number(remaining?.n ?? 0) };
}

// ---------- email (optional; webhooks are the primary channel) ----------

export async function sendAlertEmail(env: AppEnv, to: string, subject: string, html: string): Promise<boolean> {
  const key = env.RESEND_API_KEY;
  if (!key || !to) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.ALERT_FROM ?? "agentpay <alerts@entangleit.com>",
        to: [to],
        subject,
        html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Send a one-off test event, bypassing the subscription filter. */
export async function sendTestEvent(env: AppEnv, walletId: string): Promise<{ ok: boolean; statusCode: number | null; error: string }> {
  const hook = await getWebhook(env.DB, walletId);
  if (!hook) return { ok: false, statusCode: null, error: "No webhook registered" };
  const payload = JSON.stringify({ event: "test", walletId, at: nowIso(), data: { note: "agentpay webhook test" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacSign(hook.secret, timestamp, payload);
  let statusCode: number | null = null;
  let error = "";
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "agentpay-webhooks/1",
        "X-Agentpay-Event": "test",
        "X-Agentpay-Timestamp": timestamp,
        "X-Agentpay-Signature": `sha256=${signature}`,
      },
      body: payload,
    });
    statusCode = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 300);
  }
  const id = newId("apd");
  await env.DB.prepare(
    "INSERT INTO ap_webhook_deliveries (id, wallet_id, event, payload_json, status_code, error, delivered_at, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?, ?)",
  )
    .bind(id, walletId, payload, statusCode, error, error ? null : nowIso(), nowIso())
    .run();
  return { ok: !error, statusCode, error };
}

export async function notifyApprovalRequired(env: AppEnv, wallet: WalletRow, approval: ApprovalRow): Promise<void> {
  const approveUrl = `https://entangleit.com/agentpay/?approval=${approval.id}`;
  await dispatchEvent(env, wallet.id, "approval_required", {
    approvalId: approval.id,
    amountCents: approval.amount_cents,
    description: approval.description,
    service: approval.service,
    tool: approval.tool,
    expiresAt: approval.expires_at,
    approveUrl,
  });
  if (wallet.email) {
    await sendAlertEmail(
      env,
      wallet.email,
      `agentpay: approval needed for $${(approval.amount_cents / 100).toFixed(2)}`,
      `<p>An agent is waiting for approval.</p>
       <p><strong>${esc(approval.description)}</strong> — $${(approval.amount_cents / 100).toFixed(2)}</p>
       <p>${esc(approval.service)}${approval.tool ? ` / ${esc(approval.tool)}` : ""}</p>
       <p><a href="${approveUrl}">Review in the dashboard</a> (expires ${esc(approval.expires_at)})</p>`,
    );
  }
}

export async function notifyApprovalDecided(
  env: AppEnv,
  walletId: string,
  approval: ApprovalRow,
  approved: boolean,
): Promise<void> {
  await dispatchEvent(env, walletId, "approval_decided", {
    approvalId: approval.id,
    approved,
    amountCents: approval.amount_cents,
    description: approval.description,
  });
}

export async function notifySpend(
  env: AppEnv,
  walletId: string,
  spend: { amountCents: number; description: string; service?: string; tool?: string; balanceCents: number },
): Promise<void> {
  await dispatchEvent(env, walletId, "spend", spend);
}

export async function notifyLowBalance(
  env: AppEnv,
  wallet: WalletRow,
  balanceCents: number,
  thresholdCents: number,
): Promise<void> {
  await dispatchEvent(env, wallet.id, "low_balance", { balanceCents, thresholdCents });
  if (wallet.email) {
    await sendAlertEmail(
      env,
      wallet.email,
      "agentpay: wallet balance is low",
      `<p>Balance is <strong>$${(balanceCents / 100).toFixed(2)}</strong> (threshold $${(thresholdCents / 100).toFixed(2)}).</p>
       <p><a href="https://entangleit.com/agentpay/">Top up in the dashboard</a> to keep agents spending.</p>`,
    );
  }
}

export async function notifyBudgetExhausted(
  env: AppEnv,
  walletId: string,
  input: { agentName: string; budgetCents: number },
): Promise<void> {
  await dispatchEvent(env, walletId, "budget_exhausted", input);
}

export function cleanWebhookLabel(value: unknown): string {
  return cleanStr(value, 80);
}
