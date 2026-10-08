import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createAgent, createWallet, revokeAgent } from "../src/ledger";
import { requireAgent, requireWallet, bearerToken } from "../src/auth";
import { HttpError } from "../src/types";

function requestWith(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://entangleit.com/api/agentpay/agent/me", { headers });
}

describe("bearerToken", () => {
  it("parses case-insensitive Bearer headers", () => {
    expect(bearerToken(requestWith("apw_abc"))).toBe("apw_abc");
    expect(bearerToken(new Request("https://x.test/", { headers: { authorization: "bearer xyz" } }))).toBe("xyz");
    expect(bearerToken(new Request("https://x.test/"))).toBeNull();
  });
});

describe("requireWallet", () => {
  it("accepts the minted wallet token", async () => {
    const db = makeTestDb();
    const { wallet, token } = await createWallet(db, { name: "Owner" });
    const found = await requireWallet(requestWith(token), db);
    expect(found.id).toBe(wallet.id);
  });

  it("rejects missing, wrong-type, and unknown tokens", async () => {
    const db = makeTestDb();
    const { token } = await createWallet(db, { name: "Owner" });
    await expect(requireWallet(requestWith(), db)).rejects.toBeInstanceOf(HttpError);
    await expect(requireWallet(requestWith("agp_deadbeef"), db)).rejects.toThrow(/not a wallet token/i);
    await expect(requireWallet(requestWith("apw_" + "0".repeat(64)), db)).rejects.toThrow(/Unknown or revoked/);
    expect(token.startsWith("apw_")).toBe(true);
  });
});

describe("requireAgent", () => {
  it("resolves the agent and its wallet", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent, key } = await createAgent(db, wallet.id, { name: "Worker" });
    const found = await requireAgent(requestWith(key), db);
    expect(found.agent.id).toBe(agent.id);
    expect(found.wallet.id).toBe(wallet.id);
  });

  it("rejects revoked keys and wrong token types", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent, key } = await createAgent(db, wallet.id, { name: "Worker" });
    await revokeAgent(db, wallet.id, agent.id);
    await expect(requireAgent(requestWith(key), db)).rejects.toThrow(/Unknown or revoked/);
    await expect(requireAgent(requestWith("apw_notanagent"), db)).rejects.toThrow(/not an agent key/);
  });

  it("refuses to spend a revoked agent key end to end", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const { agent, key } = await createAgent(db, wallet.id, { name: "Worker" });
    await revokeAgent(db, wallet.id, agent.id);
    await expect(requireAgent(requestWith(key), db)).rejects.toBeInstanceOf(HttpError);
  });
});
