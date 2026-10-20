import { describe, expect, it } from "vitest";
import {
  BIP122_GENESIS,
  BSV_ASSET,
  BSV_NETWORK,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  SPEC_PAYMENT_PAYLOAD_EXAMPLE,
  SPEC_PAYMENT_REQUIRED_EXAMPLE,
  SPEC_SETTLEMENT_RESPONSE_EXAMPLE,
  SPEC_VERIFY_REQUEST_EXAMPLE,
  X402_VERSION,
  decodeX402Json,
  encodeX402Json,
  isAmbiguousBip122,
  isBsvNetwork,
  paymentPayloadGaps,
  paymentRequiredGaps,
  paymentRequiredHeaders,
  paymentResponseHeaders,
  paymentSignatureHeaders,
  readPaymentRequiredHeader,
  readPaymentResponseHeader,
  readPaymentSignatureHeader,
  settlementResponseGaps,
} from "../src/x402-spec";
import { bsvExactRequirements } from "../src/x402-spec";

describe("x402 v2 spec example conformance", () => {
  it("accepts the published PaymentRequired example with no schema gaps", () => {
    expect(SPEC_PAYMENT_REQUIRED_EXAMPLE.x402Version).toBe(X402_VERSION);
    expect(paymentRequiredGaps(SPEC_PAYMENT_REQUIRED_EXAMPLE)).toEqual([]);
    const accept = SPEC_PAYMENT_REQUIRED_EXAMPLE.accepts[0];
    expect(accept.network).toMatch(/^[a-z0-9]+:[a-zA-Z0-9]+$/);
    expect(accept.network).toBe("eip155:84532");
    expect(typeof accept.amount).toBe("string");
    expect(accept.maxTimeoutSeconds).toBe(60);
  });

  it("round-trips the spec PaymentRequired through the PAYMENT-REQUIRED header", () => {
    const headers = paymentRequiredHeaders(SPEC_PAYMENT_REQUIRED_EXAMPLE);
    expect(Object.keys(headers)).toEqual([PAYMENT_REQUIRED_HEADER]);
    const decoded = decodeX402Json(headers[PAYMENT_REQUIRED_HEADER]);
    expect(decoded).toEqual(SPEC_PAYMENT_REQUIRED_EXAMPLE);
    expect(paymentRequiredGaps(decoded)).toEqual([]);
  });

  it("accepts the published PaymentPayload example", () => {
    expect(paymentPayloadGaps(SPEC_PAYMENT_PAYLOAD_EXAMPLE)).toEqual([]);
    expect(SPEC_PAYMENT_PAYLOAD_EXAMPLE.accepted.scheme).toBe("exact");
    expect(SPEC_PAYMENT_PAYLOAD_EXAMPLE.payload).toHaveProperty("authorization");
  });

  it("accepts the published SettlementResponse and Verify request examples", () => {
    expect(settlementResponseGaps(SPEC_SETTLEMENT_RESPONSE_EXAMPLE)).toEqual([]);
    expect(SPEC_VERIFY_REQUEST_EXAMPLE.x402Version).toBe(2);
    expect(SPEC_VERIFY_REQUEST_EXAMPLE.paymentPayload).toEqual(SPEC_PAYMENT_PAYLOAD_EXAMPLE);
    expect(SPEC_VERIFY_REQUEST_EXAMPLE.paymentRequirements).toEqual(SPEC_PAYMENT_REQUIRED_EXAMPLE.accepts[0]);
  });

  it("flags a settlement_pending response that omits the broadcast hash", () => {
    expect(
      settlementResponseGaps({
        success: false,
        errorReason: "settlement_pending",
        transaction: "",
        network: "eip155:84532",
      }),
    ).toContain("settlement_pending requires a non-empty transaction");
  });
});

describe("HTTP header aliases", () => {
  it("writes PAYMENT-SIGNATURE and the v1 X-PAYMENT alias", () => {
    const headers = paymentSignatureHeaders("abc");
    expect(headers[PAYMENT_SIGNATURE_HEADER]).toBe("abc");
    expect(headers["X-PAYMENT"]).toBe("abc");
  });

  it("reads PAYMENT-SIGNATURE first, then X-PAYMENT", () => {
    const both = new Headers({ [PAYMENT_SIGNATURE_HEADER]: "v2", "X-PAYMENT": "v1" });
    expect(readPaymentSignatureHeader(both)).toBe("v2");
    expect(readPaymentSignatureHeader(new Headers({ "X-PAYMENT": "v1" }))).toBe("v1");
    expect(readPaymentRequiredHeader(new Headers({ [PAYMENT_REQUIRED_HEADER]: "req" }))).toBe("req");
  });

  it("writes and reads PAYMENT-RESPONSE plus the v1 alias", () => {
    const headers = paymentResponseHeaders(SPEC_SETTLEMENT_RESPONSE_EXAMPLE);
    expect(headers[PAYMENT_RESPONSE_HEADER]).toBeTruthy();
    expect(headers["X-PAYMENT-RESPONSE"]).toBe(headers[PAYMENT_RESPONSE_HEADER]);
    const h = new Headers(headers);
    expect(readPaymentResponseHeader(h)).toBe(headers[PAYMENT_RESPONSE_HEADER]);
    const decoded = decodeX402Json(readPaymentResponseHeader(h)!);
    expect(settlementResponseGaps(decoded)).toEqual([]);
  });

  it("round-trips arbitrary JSON through base64 including URL-safe alphabets", () => {
    const encoded = encodeX402Json({ hello: "x402" });
    expect(decodeX402Json(encoded)).toEqual({ hello: "x402" });
    const urlSafe = encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeX402Json(urlSafe)).toEqual({ hello: "x402" });
  });
});

describe("BSV CAIP-2 identifiers", () => {
  it("treats bsv:mainnet as the registered CAIP-2 id and refuses the BTC/BCH genesis", () => {
    expect(isBsvNetwork(BSV_NETWORK)).toBe(true);
    expect(isBsvNetwork("bsv:testnet")).toBe(true);
    expect(isBsvNetwork("eip155:8453")).toBe(false);
    expect(isAmbiguousBip122(BIP122_GENESIS)).toBe(true);
    expect(isAmbiguousBip122(BSV_NETWORK)).toBe(false);
  });

  it("emits a spec-complete BSV exact accept (string amount, CAIP-2, bazaar-ready extra)", () => {
    const accept = bsvExactRequirements({
      amountSats: 500,
      payTo: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4",
      lockingScriptHex: "76a914d69d9002e2522e3bf05f31cb7efa1e9562547f5a88ac",
    });
    expect(paymentRequiredGaps({
      x402Version: 2,
      resource: { url: "https://entangleit.com/api/agentpay/x402/chat" },
      accepts: [accept],
    })).toEqual([]);
    expect(accept.network).toBe("bsv:mainnet");
    expect(accept.asset).toBe(BSV_ASSET);
    expect(accept.amount).toBe("500");
    expect(accept.extra?.paymentFlow).toBe("upfront");
    expect(accept.extra?.payloadFormat).toEqual({ kind: "p2pkh-rawtx" });
  });
});
