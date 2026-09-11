import { describe, expect, it } from "vitest";
import { getCachedBsvUsd, satsPerCentFromUsd } from "../src/price";
import { makeTestDb } from "./helpers";

describe("price oracle", () => {
  it("derives sats/cent from USD ($25 -> 40000)", () => {
    expect(satsPerCentFromUsd(25)).toBe(40_000);
    expect(satsPerCentFromUsd(50)).toBe(20_000);
  });
  it("fails closed to default on bad input", () => {
    expect(satsPerCentFromUsd(0)).toBe(40_000);
    expect(satsPerCentFromUsd(NaN)).toBe(40_000);
  });
  it("empty cache returns null (configured rate applies)", async () => {
    const db = makeTestDb();
    await expect(getCachedBsvUsd(db)).resolves.toBeNull();
  });
});
