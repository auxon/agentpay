import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createAgent, createSubagent, createWallet, creditTopup, getBalanceCents, listAgents, listSubagents, refundSpend, revokeAgent, spend } from "../src/ledger";
import { requireAgent } from "../src/auth";
import type { AgentRow, HttpError } from "../src/types";

async function makeWalletWithParent() {
  const db = makeTestDb();
  const { createWallet } = await import("../src/ledger");
  const { wallet } = await createWallet(db, { name: "Delegator" });
  const { agent, key } = await createAgent(db, wallet.id, { name: "orchestrator" });
  await creditTopup(db, { walletId: wallet.id, amountCents: 5000, ref: "cs_sub_test" });
  return { db, wallet, parent: agent, parentKey: key };
}

function requestWith(token: string): Request {
  return new Request("https://entangleit.com/api/agentpay/agent/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function catchHttp(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected the promise to reject");
}

describe("sub-agent budgets", () => {
  it("mints a child key with a budget and expiry", async () => {
    const { db, wallet, parent } = await makeWalletWithParent();
    const { agent, key, subagent } = await createSubagent(db, parent, {
      name: "scraper-1",
      budgetCents: 500,
      dailyLimitCents: 200,
      expiresInMinutes: 60,
    });
    expect(key.startsWith("agp_")).toBe(true);
    expect(agent.parent_agent_id).toBe(parent.id);
    expect(subagent.budget_cents).toBe(500);
    expect(subagent.spent_cents).toBe(0);
    expect(subagent.expires_at).toBeTruthy();
    expect(agent.daily_limit_cents).toBe(200);
    const children = await listSubagents(db, parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(agent.id);
    void wallet;
  });

  it("lets the child spend within its budget and blocks overspend", async () => {
    const { db, wallet, parent } = await makeWalletWithParent();
    const { agent, key } = await createSubagent(db, parent, { name: "worker", budgetCents: 500 });
    const auth = await requireAgent(requestWith(key), db);
    expect(auth.agent.id).toBe(agent.id);

    await spend(db, { walletId: wallet.id, agent, amountCents: 300, description: "within budget" });
    const mid = await listSubagents(db, parent.id);
    expect(mid[0].sub_spent_cents).toBe(300);

    const err = await catchHttp(
      spend(db, { walletId: wallet.id, agent, amountCents: 201, description: "over budget" }),
    );
    expect(err.status).toBe(402);
    expect(err.payload?.code).toBe("subagent_budget");

    // A spend exactly equal to the remainder still works.
    await spend(db, { walletId: wallet.id, agent, amountCents: 200, description: "exact remainder" });
    const done = await listSubagents(db, parent.id);
    expect(done[0].sub_spent_cents).toBe(500);

    // Once exhausted, auth itself fails closed without hitting the wallet.
    const authErr = await catchHttp(requireAgent(requestWith(key), db));
    expect(authErr.status).toBe(402);
    expect(authErr.payload?.code).toBe("subagent_budget");
  });

  it("fails closed when the key expires", async () => {
    const { db, parent } = await makeWalletWithParent();
    const { agent, key } = await createSubagent(db, parent, { name: "short-lived", expiresInMinutes: 1 });
    await db
      .prepare("UPDATE ap_subagent_budgets SET expires_at = ? WHERE agent_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), agent.id)
      .run();
    const err = await catchHttp(requireAgent(requestWith(key), db));
    expect(err.status).toBe(401);
    expect(err.payload?.code).toBe("subagent_expired");
  });

  it("restores budget on refund", async () => {
    const { db, wallet, parent } = await makeWalletWithParent();
    const { agent } = await createSubagent(db, parent, { name: "refundable", budgetCents: 500 });
    await spend(db, { walletId: wallet.id, agent, amountCents: 400, description: "charged" });
    await refundSpend(db, { walletId: wallet.id, agentId: agent.id, amountCents: 400, ref: "refund:test" });
    const rows = await listSubagents(db, parent.id);
    expect(rows[0].sub_spent_cents).toBe(0);
  });

  it("refuses nesting: sub-agents cannot mint sub-agents", async () => {
    const { db, parent } = await makeWalletWithParent();
    const { agent } = await createSubagent(db, parent, { name: "leaf" });
    const err = await catchHttp(createSubagent(db, agent as AgentRow, { name: "nested" }));
    expect(err.status).toBe(403);
  });

  it("counts sub-agents toward the plan agent cap", async () => {
    const { db, parent } = await makeWalletWithParent(); // parent = 1 of 3 on Free
    await createSubagent(db, parent, { name: "worker-1" });
    await createSubagent(db, parent, { name: "worker-2" });
    const err = await catchHttp(createSubagent(db, parent, { name: "worker-3" }));
    expect(err.status).toBe(402);
    expect(err.payload?.code).toBe("plan_limit");
    expect(await listAgents(db, parent.wallet_id)).toHaveLength(3);
  });

  it("revoking the parent revokes its children", async () => {
    const { db, parent } = await makeWalletWithParent();
    const { agent: child } = await createSubagent(db, parent, { name: "worker" });
    await revokeAgent(db, parent.wallet_id, parent.id);
    const children = await listSubagents(db, parent.id);
    expect(children[0].active).toBe(0);
    const childKeyRow = await db.prepare("SELECT active FROM ap_agents WHERE id = ?").bind(child.id).first<{ active: number }>();
    expect(childKeyRow?.active).toBe(0);
  });

  it("enforces the child's tool allowlist", async () => {
    const { db, parent } = await makeWalletWithParent();
    const { agent, key } = await createSubagent(db, parent, {
      name: "scoped",
      allowedTools: ["svc_a:*"],
    });
    const { getAgentPolicy, agentToolAllowed } = await import("../src/ledger");
    const policy = await getAgentPolicy(db, agent.id);
    const allowed = JSON.parse(policy.allowed_tools_json) as string[];
    expect(agentToolAllowed(allowed, "svc_a", "ocr")).toBe(true);
    expect(agentToolAllowed(allowed, "svc_b", "ocr")).toBe(false);
    const auth = await requireAgent(requestWith(key), db);
    expect(auth.agent.id).toBe(agent.id);
  });
});

describe("cascading budgets (parent daily limit includes sub-agent spend)", () => {
  async function makeWalletWithLimitedParent(parentLimitCents: number | null) {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Cascader" });
    const { agent: parent } = await createAgent(db, wallet.id, {
      name: "orchestrator",
      dailyLimitCents: parentLimitCents,
    });
    await creditTopup(db, { walletId: wallet.id, amountCents: 5000, ref: `cs_cascade_${Date.now()}_${Math.random()}` });
    return { db, wallet, parent };
  }

  async function parentCounter(db: ReturnType<typeof makeTestDb>, parentId: string) {
    const row = await db
      .prepare("SELECT spent_today_cents FROM ap_agents WHERE id = ?")
      .bind(parentId)
      .first<{ spent_today_cents: number }>();
    return row?.spent_today_cents ?? 0;
  }

  it("counts child spend against the parent counter even when the parent is unlimited", async () => {
    const { db, wallet, parent } = await makeWalletWithParent();
    const { agent: child } = await createSubagent(db, parent, { name: "worker", budgetCents: 1000 });
    await spend(db, { walletId: wallet.id, agent: child, amountCents: 300, description: "delegated work" });
    expect(await parentCounter(db, parent.id)).toBe(300);
    const kids = await listSubagents(db, parent.id);
    expect(kids[0].sub_spent_cents).toBe(300);
  });

  it("blocks child spend when the parent cap would be exceeded", async () => {
    const { db, wallet, parent } = await makeWalletWithLimitedParent(300);
    const { agent: child } = await createSubagent(db, parent, { name: "worker", budgetCents: 1000 });
    await spend(db, { walletId: wallet.id, agent: child, amountCents: 200, description: "first chunk" });
    expect(await parentCounter(db, parent.id)).toBe(200);

    const err = await catchHttp(
      spend(db, { walletId: wallet.id, agent: child, amountCents: 150, description: "over parent cap" }),
    );
    expect(err.status).toBe(402);
    expect(err.payload?.code).toBe("parent_daily_limit");

    // Failed spend touches nothing: wallet, child counter, parent counter, budget.
    expect(await getBalanceCents(db, wallet.id)).toBe(4800);
    expect(await parentCounter(db, parent.id)).toBe(200);
    const kids = await listSubagents(db, parent.id);
    expect(kids[0].sub_spent_cents).toBe(200);
    const childRow = await db
      .prepare("SELECT spent_today_cents FROM ap_agents WHERE id = ?")
      .bind(child.id)
      .first<{ spent_today_cents: number }>();
    expect(childRow?.spent_today_cents).toBe(200);
  });

  it("shares one cap between parent direct spend and delegated spend", async () => {
    const { db, wallet, parent } = await makeWalletWithLimitedParent(300);
    const { agent: child } = await createSubagent(db, parent, { name: "worker", budgetCents: 1000 });
    // Parent spends directly first. Re-fetch so the row carries today's counter.
    const { listAgents } = await import("../src/ledger");
    const freshParent = (await listAgents(db, wallet.id)).find((a) => a.id === parent.id)!;
    await spend(db, { walletId: wallet.id, agent: freshParent, amountCents: 200, description: "parent direct" });
    expect(await parentCounter(db, parent.id)).toBe(200);

    const err = await catchHttp(
      spend(db, { walletId: wallet.id, agent: child, amountCents: 150, description: "child over shared cap" }),
    );
    expect(err.status).toBe(402);
    expect(err.payload?.code).toBe("parent_daily_limit");
    expect(await getBalanceCents(db, wallet.id)).toBe(4800);
  });

  it("restores the parent counter on refund", async () => {
    const { db, wallet, parent } = await makeWalletWithLimitedParent(1000);
    const { agent: child } = await createSubagent(db, parent, { name: "worker", budgetCents: 500 });
    await spend(db, { walletId: wallet.id, agent: child, amountCents: 400, description: "charged" });
    expect(await parentCounter(db, parent.id)).toBe(400);
    await refundSpend(db, { walletId: wallet.id, agentId: child.id, amountCents: 400, ref: "refund:cascade" });
    expect(await parentCounter(db, parent.id)).toBe(0);
    const kids = await listSubagents(db, parent.id);
    expect(kids[0].sub_spent_cents).toBe(0);
  });

  it("cascades even when the caller passes a bare agent row without parent_agent_id", async () => {
    const { db, wallet, parent } = await makeWalletWithParent();
    const { agent: child } = await createSubagent(db, parent, { name: "worker", budgetCents: 1000 });
    const bare = await db
      .prepare("SELECT * FROM ap_agents WHERE id = ?")
      .bind(child.id)
      .first<AgentRow>();
    expect(bare?.parent_agent_id).toBeUndefined();
    await spend(db, { walletId: wallet.id, agent: bare!, amountCents: 250, description: "bare row spend" });
    expect(await parentCounter(db, parent.id)).toBe(250);
  });
});
