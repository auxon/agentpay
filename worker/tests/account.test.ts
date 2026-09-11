import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import {
  agentSpendAllowed,
  agentToolAllowed,
  claimX402Txid,
  consumeApproval,
  createAgent,
  createApproval,
  createWallet,
  decideApproval,
  getAgentPolicy,
  listApprovals,
  parseAllowedTools,
  recoverWallet,
  rotateAgentKey,
  setAgentPolicy,
} from "../src/ledger";
import { requireAgent, requireWallet } from "../src/auth";
import { HttpError } from "../src/types";

function requestWith(token: string): Request {
  return new Request("https://entangleit.com/api/agentpay/agent/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("wallet recovery", () => {
  it("mints a recovery code at creation and stores only its hash", async () => {
    const db = makeTestDb();
    const { wallet, recoveryCode } = await createWallet(db, { name: "Owner" });
    expect(recoveryCode.startsWith("apr_")).toBe(true);
    const row = await db
      .prepare("SELECT code_hash FROM ap_recovery WHERE wallet_id = ?")
      .bind(wallet.id)
      .first<{ code_hash: string }>();
    expect(row?.code_hash).toBeTruthy();
    expect(row?.code_hash).not.toContain(recoveryCode);
  });

  it("resets the wallet token and invalidates the old one", async () => {
    const db = makeTestDb();
    const { wallet, token, recoveryCode } = await createWallet(db, { name: "Owner" });
    await expect(requireWallet(requestWith(token), db)).resolves.toMatchObject({ id: wallet.id });

    const recovered = await recoverWallet(db, { walletId: wallet.id, recoveryCode });
    expect(recovered?.token.startsWith("apw_")).toBe(true);
    expect(recovered?.token).not.toBe(token);
    await expect(requireWallet(requestWith(recovered!.token), db)).resolves.toMatchObject({ id: wallet.id });
    await expect(requireWallet(requestWith(token), db)).rejects.toBeInstanceOf(HttpError);
  });

  it("rejects wrong codes, unknown wallets, and malformed codes", async () => {
    const db = makeTestDb();
    const { wallet, recoveryCode } = await createWallet(db, { name: "Owner" });
    const wrong = `${recoveryCode.slice(0, -1)}${recoveryCode.endsWith("a") ? "b" : "a"}`;
    expect(await recoverWallet(db, { walletId: wallet.id, recoveryCode: wrong })).toBeNull();
    expect(await recoverWallet(db, { walletId: "apw_nope", recoveryCode })).toBeNull();
    expect(await recoverWallet(db, { walletId: wallet.id, recoveryCode: "not-a-code" })).toBeNull();
  });
});

describe("x402 replay guard", () => {
  it("claims a settled txid exactly once", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const txid = "aa".repeat(32);
    expect(await claimX402Txid(db, { txid, walletId: wallet.id, service: "s", tool: "t" })).toBe(true);
    expect(await claimX402Txid(db, { txid, walletId: wallet.id, service: "s", tool: "t" })).toBe(false);
  });
});

describe("agent policies", () => {
  it("parses allowed tools from JSON, comma strings, and arrays", () => {
    expect(parseAllowedTools('["s1:ocr","s2:*"]')).toEqual(["s1:ocr", "s2:*"]);
    expect(parseAllowedTools("s1:ocr, s2:*")).toEqual(["s1:ocr", "s2:*"]);
    expect(parseAllowedTools(["a", "b"])).toEqual(["a", "b"]);
    expect(parseAllowedTools("")).toEqual([]);
    expect(parseAllowedTools(null)).toEqual([]);
  });

  it("enforces tool and spend allowlists", () => {
    expect(agentToolAllowed([], "s", "t")).toBe(true);
    expect(agentToolAllowed(["*"], "s", "t")).toBe(true);
    expect(agentToolAllowed(["s:t"], "s", "t")).toBe(true);
    expect(agentToolAllowed(["s:*"], "s", "other")).toBe(true);
    expect(agentToolAllowed(["s:t"], "s", "other")).toBe(false);
    expect(agentSpendAllowed([])).toBe(true);
    expect(agentSpendAllowed(["s:t"])).toBe(false);
    expect(agentSpendAllowed(["spend"])).toBe(true);
  });

  it("merges policy updates and validates the threshold", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent } = await createAgent(db, wallet.id, { name: "Worker" });

    const first = await setAgentPolicy(db, wallet.id, agent.id, { approvalAboveCents: 500, allowedTools: ["svc:tool"] });
    expect(first.approval_above_cents).toBe(500);
    expect(parseAllowedTools(first.allowed_tools_json)).toEqual(["svc:tool"]);

    const merged = await setAgentPolicy(db, wallet.id, agent.id, { allowedTools: ["x:*"] });
    expect(merged.approval_above_cents).toBe(500);
    expect(parseAllowedTools(merged.allowed_tools_json)).toEqual(["x:*"]);

    const cleared = await setAgentPolicy(db, wallet.id, agent.id, { approvalAboveCents: null });
    expect(cleared.approval_above_cents).toBeNull();
    expect((await getAgentPolicy(db, agent.id)).agent_id).toBe(agent.id);

    await expect(setAgentPolicy(db, wallet.id, agent.id, { approvalAboveCents: 0 })).rejects.toThrow(/approvalAboveCents/);
  });
});

describe("purchase approvals", () => {
  async function setup() {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent } = await createAgent(db, wallet.id, { name: "Worker" });
    return { db, wallet, agent };
  }

  it("runs pending → approved → consumed exactly once", async () => {
    const { db, wallet, agent } = await setup();
    const approval = await createApproval(db, {
      walletId: wallet.id,
      agentId: agent.id,
      amountCents: 2500,
      description: "buy data",
      service: "svc",
      tool: "t",
      ref: "r1",
    });
    expect(approval.status).toBe("pending");
    expect((await listApprovals(db, wallet.id))[0]?.id).toBe(approval.id);

    const approved = await decideApproval(db, wallet.id, approval.id, true, "looks fine");
    expect(approved.status).toBe("approved");

    const consumed = await consumeApproval(db, {
      walletId: wallet.id,
      agentId: agent.id,
      approvalId: approval.id,
      amountCents: 2500,
      service: "svc",
      tool: "t",
    });
    expect(consumed?.status).toBe("consumed");
    expect(
      await consumeApproval(db, {
        walletId: wallet.id,
        agentId: agent.id,
        approvalId: approval.id,
        amountCents: 2500,
        service: "svc",
        tool: "t",
      }),
    ).toBeNull();
  });

  it("rejects mismatches, wrong agents, and double decisions", async () => {
    const { db, wallet, agent } = await setup();
    const approval = await createApproval(db, {
      walletId: wallet.id,
      agentId: agent.id,
      amountCents: 100,
      description: "x",
      service: "",
      tool: "",
      ref: "",
    });
    // consuming while still pending does nothing
    expect(
      await consumeApproval(db, { walletId: wallet.id, agentId: agent.id, approvalId: approval.id, amountCents: 100 }),
    ).toBeNull();
    await decideApproval(db, wallet.id, approval.id, true);
    await expect(decideApproval(db, wallet.id, approval.id, true)).rejects.toThrow(/already/);
    // amount mismatch
    expect(
      await consumeApproval(db, { walletId: wallet.id, agentId: agent.id, approvalId: approval.id, amountCents: 101 }),
    ).toBeNull();
    // wrong agent
    expect(
      await consumeApproval(db, { walletId: wallet.id, agentId: "aga_other", approvalId: approval.id, amountCents: 100 }),
    ).toBeNull();
    // correct consume still works
    expect(
      (await consumeApproval(db, { walletId: wallet.id, agentId: agent.id, approvalId: approval.id, amountCents: 100 }))
        ?.status,
    ).toBe("consumed");
  });

  it("denies and expires approvals", async () => {
    const { db, wallet, agent } = await setup();
    const denied = await createApproval(db, {
      walletId: wallet.id,
      agentId: agent.id,
      amountCents: 50,
      description: "no",
      service: "",
      tool: "",
      ref: "",
    });
    expect((await decideApproval(db, wallet.id, denied.id, false, "too much")).status).toBe("denied");
    expect(
      await consumeApproval(db, { walletId: wallet.id, agentId: agent.id, approvalId: denied.id, amountCents: 50 }),
    ).toBeNull();

    const stale = await createApproval(db, {
      walletId: wallet.id,
      agentId: agent.id,
      amountCents: 60,
      description: "late",
      service: "",
      tool: "",
      ref: "",
    });
    await db
      .prepare("UPDATE ap_approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(stale.id)
      .run();
    expect((await listApprovals(db, wallet.id)).find((a) => a.id === stale.id)?.status).toBe("expired");
  });
});

describe("agent key rotation", () => {  it("issues a new key and invalidates the old one", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent, key } = await createAgent(db, wallet.id, { name: "Worker" });

    const rotated = await rotateAgentKey(db, wallet.id, agent.id);
    expect(rotated?.key.startsWith("agp_")).toBe(true);
    expect(rotated?.key).not.toBe(key);
    await expect(requireAgent(requestWith(rotated!.key), db)).resolves.toMatchObject({ agent: { id: agent.id } });
    await expect(requireAgent(requestWith(key), db)).rejects.toBeInstanceOf(HttpError);
  });

  it("reactivates a revoked agent with a fresh key", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent, key } = await createAgent(db, wallet.id, { name: "Worker" });
    await db.prepare("UPDATE ap_agents SET active = 0 WHERE id = ?").bind(agent.id).run();
    await expect(requireAgent(requestWith(key), db)).rejects.toBeInstanceOf(HttpError);
    const rotated = await rotateAgentKey(db, wallet.id, agent.id);
    await expect(requireAgent(requestWith(rotated!.key), db)).resolves.toMatchObject({ agent: { id: agent.id } });
  });

  it("returns null for an agent on another wallet", async () => {
    const db = makeTestDb();
    const a = await createWallet(db, { name: "A" });
    const b = await createWallet(db, { name: "B" });
    const { agent } = await createAgent(db, a.wallet.id, { name: "Worker" });
    expect(await rotateAgentKey(db, b.wallet.id, agent.id)).toBeNull();
  });
});
