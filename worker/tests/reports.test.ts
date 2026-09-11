import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createAgent, createWallet, creditTopup, refundSpend, spend } from "../src/ledger";
import {
  buildReport,
  createReportLink,
  getActiveReportLink,
  listReportLinks,
  renderReportHtml,
  revokeReportLink,
} from "../src/reports";

async function makeSpender() {
  const db = makeTestDb();
  const { wallet } = await createWallet(db, { name: "Agency wallet" });
  const { agent } = await createAgent(db, wallet.id, { name: "research-bot" });
  await creditTopup(db, { walletId: wallet.id, amountCents: 10_000, ref: "cs_report_1" });
  await spend(db, {
    walletId: wallet.id,
    agent,
    amountCents: 300,
    description: "Resize image",
    service: "BSV Wallets",
    tool: "resize",
  });
  await spend(db, {
    walletId: wallet.id,
    agent,
    amountCents: 200,
    description: "Timestamp a digest",
    service: "BSV Wallets",
    tool: "timestamp",
  });
  await spend(db, {
    walletId: wallet.id,
    agent,
    amountCents: 100,
    description: "Fetch page",
    service: "x402 Fetch",
    tool: "fetch",
  });
  await refundSpend(db, { walletId: wallet.id, agentId: agent.id, amountCents: 100, ref: "refund:test" });
  return { db, wallet, agent };
}

describe("report links", () => {
  it("creates a token link with defaults and lists it", async () => {
    const { db, wallet } = await makeSpender();
    const link = await createReportLink(db, wallet.id, { label: "Acme Q3" });
    expect(link.token.startsWith("rpt_")).toBe(true);
    expect(link.days).toBe(30);
    expect(link.include_receipts).toBe(1);
    expect(link.expires_at).toBeTruthy();
    const active = await getActiveReportLink(db, link.token);
    expect(active?.label).toBe("Acme Q3");
    expect(await listReportLinks(db, wallet.id)).toHaveLength(1);
  });

  it("revoked and expired links stop resolving", async () => {
    const { db, wallet } = await makeSpender();
    const link = await createReportLink(db, wallet.id, { label: "one" });
    await revokeReportLink(db, wallet.id, link.token);
    expect(await getActiveReportLink(db, link.token)).toBeNull();

    const second = await createReportLink(db, wallet.id, { label: "two" });
    await db
      .prepare("UPDATE ap_report_links SET expires_at = ? WHERE token = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), second.token)
      .run();
    expect(await getActiveReportLink(db, second.token)).toBeNull();
  });

  it("aggregates spend, services, days, and refunds", async () => {
    const { db, wallet } = await makeSpender();
    const report = await buildReport(db, wallet.id, { days: 30, includeReceipts: true });
    expect(report.totals.spentCents).toBe(600);
    expect(report.totals.topupCents).toBe(10_000);
    expect(report.totals.refundCents).toBe(100);
    expect(report.totals.netSpentCents).toBe(500);
    expect(report.totals.receiptCount).toBe(3);

    const wallets = report.byService.find((s) => s.service === "BSV Wallets");
    expect(wallets?.receipts).toBe(2);
    expect(wallets?.spentCents).toBe(500);
    expect(report.byDay.length).toBeGreaterThan(0);
    expect(report.receipts).toHaveLength(3);
    expect(report.receipts[0].service).toBeTruthy();
  });

  it("omits receipts when the link excludes them", async () => {
    const { db, wallet } = await makeSpender();
    const report = await buildReport(db, wallet.id, { days: 30, includeReceipts: false });
    expect(report.receipts).toHaveLength(0);
    expect(report.totals.spentCents).toBe(600);
  });

  it("renders a standalone HTML page with totals", async () => {
    const { db, wallet } = await makeSpender();
    const report = await buildReport(db, wallet.id, { days: 30, includeReceipts: true });
    const html = renderReportHtml(report, "Acme Q3");
    expect(html).toContain("Agent spend report");
    expect(html).toContain("Acme Q3");
    expect(html).toContain("$5.00"); // net spend
    expect(html).toContain("BSV Wallets");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
});
