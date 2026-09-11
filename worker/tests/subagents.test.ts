import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createAgent, createSubagent, creditTopup, listAgents, listSubagents, refundSpend, revokeAgent, spend } from "../src/ledger";
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
