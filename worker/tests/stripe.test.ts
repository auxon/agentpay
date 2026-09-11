import { describe, expect, it } from "vitest";
import {
  TOPUP_MAX_CENTS,
  TOPUP_MIN_CENTS,
  TOPUP_PRESETS,
  isValidTopupAmount,
  productionRequiresLiveStripe,
  stripeKeyLivemode,
} from "../src/stripe";
import { isValidDailyLimit, isValidSpendAmount, MAX_AGENT_LIMIT_CENTS, MAX_SPEND_CENTS } from "../src/ledger";
import { formatCents } from "../src/ids";

describe("top-up validation", () => {
  it("accepts $1–$1,000 integer cents only", () => {
    expect(isValidTopupAmount(TOPUP_MIN_CENTS)).toBe(true);
    expect(isValidTopupAmount(TOPUP_MAX_CENTS)).toBe(true);
    expect(isValidTopupAmount(TOPUP_MIN_CENTS - 1)).toBe(false);
    expect(isValidTopupAmount(TOPUP_MAX_CENTS + 1)).toBe(false);
    expect(isValidTopupAmount(19.99)).toBe(false);
    expect(isValidTopupAmount("2000")).toBe(false);
  });

  it("offers $5/$20/$100 presets inside the range", () => {
    expect(TOPUP_PRESETS).toEqual([500, 2000, 10000]);
    for (const preset of TOPUP_PRESETS) expect(isValidTopupAmount(preset)).toBe(true);
  });
});

describe("livemode detection", () => {
  it("reads the key prefix", () => {
    expect(stripeKeyLivemode("rk_live_abc")).toBe(true);
    expect(stripeKeyLivemode("rk_test_abc")).toBe(false);
    expect(stripeKeyLivemode("")).toBeNull();
    expect(stripeKeyLivemode(undefined)).toBeNull();
  });

  it("fail-closes production on test keys", () => {
    expect(productionRequiresLiveStripe("entangleit.com", false)).toBe(true);
    expect(productionRequiresLiveStripe("entangleit.com", null)).toBe(true);
    expect(productionRequiresLiveStripe("entangleit.com", true)).toBe(false);
    expect(productionRequiresLiveStripe("localhost", false)).toBe(false);
  });
});

describe("spend and limit validation", () => {
  it("bounds a single spend", () => {
    expect(isValidSpendAmount(1)).toBe(true);
    expect(isValidSpendAmount(MAX_SPEND_CENTS)).toBe(true);
    expect(isValidSpendAmount(0)).toBe(false);
    expect(isValidSpendAmount(MAX_SPEND_CENTS + 1)).toBe(false);
    expect(isValidSpendAmount(1.5)).toBe(false);
  });

  it("allows null (no limit) or a positive limit up to the cap", () => {
    expect(isValidDailyLimit(null)).toBe(true);
    expect(isValidDailyLimit(1)).toBe(true);
    expect(isValidDailyLimit(MAX_AGENT_LIMIT_CENTS)).toBe(true);
    expect(isValidDailyLimit(0)).toBe(false);
    expect(isValidDailyLimit(MAX_AGENT_LIMIT_CENTS + 1)).toBe(false);
  });
});

describe("formatCents", () => {
  it("renders USD amounts", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(500)).toBe("$5.00");
    expect(formatCents(1999)).toBe("$19.99");
  });
});
