/**
 * Shareable spend reports (Pro): a random token exposes an aggregate view of a
 * wallet's ledger and receipts for a bounded window. Links are revocable and
 * expire; the report is computed live at read time.
 */
import { HttpError } from "./types";
import { cleanStr, nowIso, randomHex } from "./ids";
import { MAX_REPORT_LINKS } from "./notify";

export interface ReportLinkRow {
  token: string;
  wallet_id: string;
  label: string;
  days: number;
  include_receipts: number;
  revoked: number;
  expires_at: string | null;
  created_at: string;
  last_viewed_at: string | null;
  views: number;
}

export interface SpendReport {
  generatedAt: string;
  wallet: { id: string; name: string; createdAt: string };
  period: { days: number; since: string };
  totals: {
    spentCents: number;
    topupCents: number;
    refundCents: number;
    netSpentCents: number;
    receiptCount: number;
  };
  byService: { service: string; receipts: number; spentCents: number }[];
  byDay: { day: string; spentCents: number }[];
  receipts: {
    id: string;
    createdAt: string;
    service: string;
    tool: string;
    description: string;
    amountCents: number;
  }[];
}

export const REPORT_DAYS_DEFAULT = 30;
export const REPORT_DAYS_MAX = 365;
export const REPORT_EXPIRY_DAYS_DEFAULT = 30;

export async function createReportLink(
  db: D1Database,
  walletId: string,
  input: { label?: unknown; days?: unknown; expiresInDays?: unknown; includeReceipts?: unknown },
): Promise<ReportLinkRow> {
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM ap_report_links WHERE wallet_id = ? AND revoked = 0")
    .bind(walletId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_REPORT_LINKS) {
    throw new HttpError(400, `Too many active report links (max ${MAX_REPORT_LINKS}) — revoke one first`);
  }
  const days = clampDays(input.days);
  const expiresInDays = Number(input.expiresInDays);
  const expiresAt =
    Number.isFinite(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 365
      ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
      : new Date(Date.now() + REPORT_EXPIRY_DAYS_DEFAULT * 86_400_000).toISOString();
  const token = `rpt_${randomHex(16)}`;
  await db
    .prepare(
      "INSERT INTO ap_report_links (token, wallet_id, label, days, include_receipts, revoked, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(token, walletId, cleanStr(input.label, 80), days, input.includeReceipts === false ? 0 : 1, expiresAt, nowIso())
    .run();
  const row = await getReportLink(db, token);
  if (!row) throw new HttpError(500, "Report link insert failed");
  return row;
}

function clampDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return REPORT_DAYS_DEFAULT;
  return Math.min(REPORT_DAYS_MAX, Math.max(1, Math.round(n)));
}

export async function getReportLink(db: D1Database, token: string): Promise<ReportLinkRow | null> {
  return db.prepare("SELECT * FROM ap_report_links WHERE token = ?").bind(token).first<ReportLinkRow>();
}

/** Valid, unrevoked, unexpired link. */
export async function getActiveReportLink(db: D1Database, token: string): Promise<ReportLinkRow | null> {
  const row = await getReportLink(db, token);
  if (!row || row.revoked === 1) return null;
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;
  return row;
}

export async function listReportLinks(db: D1Database, walletId: string): Promise<ReportLinkRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM ap_report_links WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(walletId)
    .all<ReportLinkRow>();
  return results ?? [];
}

export async function revokeReportLink(db: D1Database, walletId: string, token: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE ap_report_links SET revoked = 1 WHERE token = ? AND wallet_id = ?")
    .bind(token, walletId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function touchReportLink(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("UPDATE ap_report_links SET views = views + 1, last_viewed_at = ? WHERE token = ?")
    .bind(nowIso(), token)
    .run();
}

/** Both ISO (`…T…Z`, written by the app) and SQLite (`… …`, table defaults). */
export function sinceBounds(days: number): { iso: string; sql: string } {
  const iso = new Date(Date.now() - days * 86_400_000).toISOString();
  return { iso, sql: iso.replace("T", " ").replace("Z", "").slice(0, 19) };
}

export async function buildReport(
  db: D1Database,
  walletId: string,
  opts: { days: number; includeReceipts: boolean },
): Promise<SpendReport> {
  const since = sinceBounds(opts.days);
  const wallet = await db
    .prepare("SELECT id, name, created_at FROM ap_wallets WHERE id = ?")
    .bind(walletId)
    .first<{ id: string; name: string; created_at: string }>();

  const totals = await db
    .prepare(
      `SELECT kind, SUM(amount_cents) AS cents, COUNT(*) AS n
       FROM ap_ledger
       WHERE wallet_id = ? AND (created_at >= ? OR created_at >= ?)
       GROUP BY kind`,
    )
    .bind(walletId, since.iso, since.sql)
    .all<{ kind: string; cents: number; n: number }>();

  const byKind = new Map((totals.results ?? []).map((r) => [r.kind, r]));
  // Debits are stored negative; report them as positive spend.
  const spentCents = Math.abs(byKind.get("debit")?.cents ?? 0);
  const topupCents = Math.abs(byKind.get("topup")?.cents ?? 0);
  const refundCents = Math.abs(byKind.get("refund")?.cents ?? 0);

  const serviceRows = await db
    .prepare(
      `SELECT service, COUNT(*) AS receipts, SUM(amount_cents) AS cents
       FROM ap_receipts
       WHERE wallet_id = ? AND (created_at >= ? OR created_at >= ?)
       GROUP BY service ORDER BY cents DESC LIMIT 25`,
    )
    .bind(walletId, since.iso, since.sql)
    .all<{ service: string; receipts: number; cents: number }>();

  const dayRows = await db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, SUM(-amount_cents) AS cents
       FROM ap_ledger
       WHERE wallet_id = ? AND kind = 'debit' AND (created_at >= ? OR created_at >= ?)
       GROUP BY day ORDER BY day ASC LIMIT 400`,
    )
    .bind(walletId, since.iso, since.sql)
    .all<{ day: string; cents: number }>();

  let receipts: SpendReport["receipts"] = [];
  if (opts.includeReceipts) {
    const rows = await db
      .prepare(
        `SELECT id, created_at, service, tool, description, amount_cents
         FROM ap_receipts
         WHERE wallet_id = ? AND (created_at >= ? OR created_at >= ?)
         ORDER BY created_at DESC LIMIT 100`,
      )
      .bind(walletId, since.iso, since.sql)
      .all<{
        id: string;
        created_at: string;
        service: string;
        tool: string;
        description: string;
        amount_cents: number;
      }>();
    receipts = (rows.results ?? []).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      service: r.service,
      tool: r.tool,
      description: r.description,
      amountCents: r.amount_cents,
    }));
  }

  return {
    generatedAt: nowIso(),
    wallet: { id: wallet?.id ?? walletId, name: wallet?.name ?? "", createdAt: wallet?.created_at ?? "" },
    period: { days: opts.days, since: since.iso },
    totals: {
      spentCents,
      topupCents,
      refundCents,
      netSpentCents: spentCents - refundCents,
      receiptCount: byKind.get("debit")?.n ?? receipts.length,
    },
    byService: (serviceRows.results ?? []).map((r) => ({
      service: r.service || "(unlabeled)",
      receipts: r.receipts,
      spentCents: Math.abs(r.cents),
    })),
    byDay: (dayRows.results ?? []).map((r) => ({ day: r.day, spentCents: Math.abs(r.cents) })),
    receipts,
  };
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Minimal standalone HTML view so clients can open the link without JS. */
export function renderReportHtml(report: SpendReport, label: string): string {
  const rows = report.receipts
    .map(
      (r) => `<tr>
        <td>${esc(r.createdAt.slice(0, 16).replace("T", " "))}</td>
        <td>${esc(r.service || "—")}${r.tool ? ` / ${esc(r.tool)}` : ""}</td>
        <td>${esc(r.description)}</td>
        <td style="text-align:right">${usd(r.amountCents)}</td>
      </tr>`,
    )
    .join("");
  const services = report.byService
    .map(
      (s) => `<tr><td>${esc(s.service)}</td><td style="text-align:right">${s.receipts}</td><td style="text-align:right">${usd(s.spentCents)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent spend report — ${esc(label || report.wallet.name || report.wallet.id)}</title>
<style>
  body { margin:0; background:#0b0e14; color:#e8edf5; font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:860px; margin:0 auto; padding:32px 20px 60px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .muted { color:#8b97ab; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:22px 0; }
  .card { background:#121722; border:1px solid #232c3d; border-radius:10px; padding:14px 16px; }
  .card .k { color:#8b97ab; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:22px; font-weight:700; margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:14px; margin-top:8px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #232c3d; }
  th { color:#8b97ab; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .foot { margin-top:28px; color:#697487; font-size:12px; }
</style></head>
<body><div class="wrap">
  <h1>Agent spend report${label ? ` — ${esc(label)}` : ""}</h1>
  <div class="muted">Wallet ${esc(report.wallet.name || report.wallet.id)} · last ${report.period.days} days · generated ${esc(report.generatedAt.slice(0, 16).replace("T", " "))} UTC</div>
  <div class="cards">
    <div class="card"><div class="k">Spent</div><div class="v">${usd(report.totals.spentCents)}</div></div>
    <div class="card"><div class="k">Receipts</div><div class="v">${report.totals.receiptCount}</div></div>
    <div class="card"><div class="k">Top-ups</div><div class="v">${usd(report.totals.topupCents)}</div></div>
    <div class="card"><div class="k">Refunds</div><div class="v">${usd(report.totals.refundCents)}</div></div>
  </div>
  ${services ? `<h2 style="font-size:16px">By service</h2><table><thead><tr><th>Service</th><th style="text-align:right">Calls</th><th style="text-align:right">Spent</th></tr></thead><tbody>${services}</tbody></table>` : ""}
  ${rows ? `<h2 style="font-size:16px">Receipts</h2><table><thead><tr><th>When (UTC)</th><th>Service</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
  <div class="foot">Generated by agentpay · prepaid wallets for AI agents · entangleit.com/agentpay</div>
</div></body></html>`;
}
