import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { makeTestDb } from "./helpers";
import { createWallet } from "../src/ledger";
import {
  dispatchEvent,
  getWebhook,
  hmacSign,
  isValidWebhookUrl,
  listDeliveries,
  parseAlertEvents,
  redeliverFailed,
  rotateWebhookSecret,
  setWebhook,
} from "../src/notify";
import type { AppEnv } from "../src/types";

function envWith(db: unknown): AppEnv {
  return { DB: db } as unknown as AppEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alert webhook config", () => {
  it("validates urls: https anywhere, http only on localhost", () => {
    expect(isValidWebhookUrl("https://hooks.example.com/x")).toBe(true);
    expect(isValidWebhookUrl("http://localhost:9999/x")).toBe(true);
    expect(isValidWebhookUrl("http://127.0.0.1:9999/x")).toBe(true);
    expect(isValidWebhookUrl("http://evil.example.com/x")).toBe(false);
    expect(isValidWebhookUrl("ftp://example.com")).toBe(false);
    expect(isValidWebhookUrl("nope")).toBe(false);
  });

  it("filters and dedupes event names", () => {
    expect(parseAlertEvents(["low_balance", "wat", "low_balance", "approval_required"])).toEqual([
      "low_balance",
      "approval_required",
    ]);
    expect(parseAlertEvents("spend, low_balance")).toEqual(["spend", "low_balance"]);
    expect(parseAlertEvents(null)).toEqual([]);
  });

  it("keeps the signing secret across updates and rotates it on demand", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const first = await setWebhook(db, wallet.id, {
      url: "https://hooks.example.com/a",
      events: ["low_balance"],
      lowBalanceCents: 500,
    });
    const updated = await setWebhook(db, wallet.id, {
      url: "https://hooks.example.com/b",
      events: ["spend"],
      lowBalanceCents: 1000,
    });
    expect(updated.url).toBe("https://hooks.example.com/b");
    expect(updated.secret).toBe(first.secret);
    expect(updated.low_balance_cents).toBe(1000);

    const rotated = await rotateWebhookSecret(db, wallet.id);
    expect(rotated?.secret).not.toBe(first.secret);
  });

  it("signs with HMAC-SHA256 over `timestamp.body`", async () => {
    const secret = "awh_test";
    const ts = "1700000000";
    const body = '{"event":"test"}';
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(await hmacSign(secret, ts, body)).toBe(expected);
  });
});

describe("webhook delivery", () => {
  it("delivers subscribed events, logs the attempt, and ignores the rest", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    const hook = await setWebhook(db, wallet.id, {
      url: "https://hooks.example.com/a",
      events: ["low_balance"],
      lowBalanceCents: 500,
    });

    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("ok", { status: 200 });
      }),
    );

    await dispatchEvent(envWith(db), wallet.id, "low_balance", { balanceCents: 100, thresholdCents: 500 });
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    const body = String(calls[0].init.body);
    expect(headers["X-Agentpay-Event"]).toBe("low_balance");
    expect(headers["X-Agentpay-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const expected = await hmacSign(hook.secret, headers["X-Agentpay-Timestamp"], body);
    expect(headers["X-Agentpay-Signature"]).toBe(`sha256=${expected}`);

    // Not subscribed: no second call.
    await dispatchEvent(envWith(db), wallet.id, "spend", { amountCents: 10 });
    expect(calls).toHaveLength(1);

    const deliveries = await listDeliveries(db, wallet.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status_code).toBe(200);
    expect(deliveries[0].delivered_at).toBeTruthy();
    expect((await getWebhook(db, wallet.id))?.last_success_at).toBeTruthy();
  });

  it("records failures and redelivers them", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Owner" });
    await setWebhook(db, wallet.id, {
      url: "https://hooks.example.com/a",
      events: ["spend"],
      lowBalanceCents: 500,
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await dispatchEvent(envWith(db), wallet.id, "spend", { amountCents: 25 });
    let deliveries = await listDeliveries(db, wallet.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].delivered_at).toBeNull();
    expect(deliveries[0].error).toBe("HTTP 500");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const result = await redeliverFailed(envWith(db), wallet.id);
    expect(result.delivered).toBe(1);
    expect(result.remaining).toBe(0);
    deliveries = await listDeliveries(db, wallet.id);
    expect(deliveries[0].delivered_at).toBeTruthy();
  });
});
