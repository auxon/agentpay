import { describe, expect, it } from "vitest";
import { applyTrustMultiplier, decidePayTrust } from "../src/trust";

describe("pay trust (work -> spend)", () => {
  it("fast-paths at 650 with no slashes", () => {
    const d = decidePayTrust({ score: 650, provisional: false, slashes: 0, tier: "A" });
    expect(d.fastPath).toBe(true);
    expect(applyTrustMultiplier(100, d)).toBe(200);
  });
  it("fails closed on provisional", () => {
    const d = decidePayTrust({ score: 950, provisional: true, slashes: 0 });
    expect(d.fastPath).toBe(false);
    expect(applyTrustMultiplier(100, d)).toBe(100);
  });
  it("fails closed on slashes", () => {
    const d = decidePayTrust({ score: 800, provisional: false, slashes: 2 });
    expect(d.fastPath).toBe(false);
  });
  it("fails closed on low score", () => {
    const d = decidePayTrust({ score: 500, provisional: false, slashes: 0 });
    expect(d.fastPath).toBe(false);
  });
  it("null threshold never becomes a limit", () => {
    const d = decidePayTrust({ score: 900, provisional: false, slashes: 0 });
    expect(applyTrustMultiplier(null, d)).toBeNull();
  });
  it("null reputation fails closed", () => {
    const d = decidePayTrust(null);
    expect(d.fastPath).toBe(false);
    expect(d.reason).toBe("no_reputation");
  });
});
