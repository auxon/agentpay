import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { claimTrial, trialCents, trialEnabled } from "../src/trial";
import type { AppEnv } from "../src/types";

function env(over: Record<string, string> = {}): AppEnv {
  return { DB: makeTestDb(), TRIAL_ENABLED: "1", ...over } as unknown as AppEnv;
}

describe("trial faucet", () => {
  it("disabled by default", () => {
    expect(trialEnabled({ DB: makeTestDb() } as unknown as AppEnv)).toBe(false);
  });
  it("clamps trial size 1..500", () => {
    expect(trialCents(env({ TRIAL_CENTS: "9999" }))).toBe(25);
    expect(trialCents(env({ TRIAL_CENTS: "50" }))).toBe(50);
  });
  it("mints a funded wallet + key", async () => {
    const e = env();
    const claim = await claimTrial(e.DB, e, "1.2.3.4", "trial-bot");
    expect(claim.amountCents).toBe(25);
    expect(claim.key.startsWith("agp_")).toBe(true);
    expect(claim.token.startsWith("apw_")).toBe(true);
    expect(claim.recoveryCode.length).toBeGreaterThan(0);
  });
  it("one claim per IP per day fails closed", async () => {
    const e = env();
    await claimTrial(e.DB, e, "5.6.7.8", "a");
    await expect(claimTrial(e.DB, e, "5.6.7.8", "b")).rejects.toMatchObject({ status: 429 });
  });
  it("total budget cap enforced", async () => {
    const e = env({ TRIAL_TOTAL_CAP_CENTS: "25" });
    await claimTrial(e.DB, e, "9.9.9.1", "a");
    await expect(claimTrial(e.DB, e, "9.9.9.2", "b")).rejects.toMatchObject({ status: 429 });
  });
  it("disabled faucet refuses", async () => {
    const e = env({ TRIAL_ENABLED: "0" });
    await expect(claimTrial(e.DB, e, "2.2.2.2")).rejects.toMatchObject({ status: 403 });
  });
});
