import { describe, expect, it } from "vitest";
import { nextStep } from "../src/onboard";

describe("onboard nextStep", () => {
  it("zero balance + no earnings -> earn_first", () => {
    const n = nextStep({ balanceCents: 0, linkedAccounts: [], claims: 0, paidClaims: 0, hasHistory: false });
    expect(n.stage).toBe("earn_first");
    expect(n.tool).toBe("list_bounties");
  });
  it("funded + no history -> spend_first dry run", () => {
    const n = nextStep({ balanceCents: 500, linkedAccounts: [], claims: 0, paidClaims: 0, hasHistory: false });
    expect(n.stage).toBe("spend_first");
    expect(n.args).toMatchObject({ dryRun: true });
  });
  it("history + unlinked -> link_account", () => {
    const n = nextStep({ balanceCents: 500, linkedAccounts: [], claims: 1, paidClaims: 1, hasHistory: true });
    expect(n.stage).toBe("link_account");
    expect(n.tool).toBe("claim_bounty");
  });
  it("linked + history -> scale with bountyAccount", () => {
    const n = nextStep({ balanceCents: 500, linkedAccounts: [33], claims: 2, paidClaims: 1, hasHistory: true });
    expect(n.stage).toBe("scale");
    expect(n.args).toMatchObject({ bountyAccount: 33 });
  });
});
