import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createWallet, creditTopup, listLedger } from "../src/ledger";
import {
  BOUNTIES_API_PREFIX,
  centsForSats,
  claimBountyRemote,
  creditBountyPayout,
  getLink,
  handleBountyEvent,
  linkBounty,
  listBounties,
  listLinks,
  pushTrustBountyPaid,
  submitWorkRemote,
  touchLinkStatus,
  trustSubjectForWorker,
  workerRefFor,
} from "../src/bounties";
import { HttpError, type AppEnv } from "../src/types";

function fakeEnv(fetcher?: (req: Request) => Promise<Response>): AppEnv {
  return {
    BOUNTIES: fetcher ? { fetch: fetcher } : undefined,
    BOUNTY_SATS_PER_CENT: "40000",
  } as unknown as AppEnv;
}

async function makeWallet() {
  const db = makeTestDb();
  const { wallet } = await createWallet(db, { name: "Earner", email: "earn@example.com" });
  return { db, wallet };
}

describe("bounty client", () => {
  it("claims through the binding with the wallet worker ref", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const env = fakeEnv(async (req) => {
      calls.push({ url: req.url, body: JSON.parse((await req.text()) || "{}") });
      return Response.json({ bounty: { id: "b1", title: "Fix docs", amountSats: 5000 } });
    });
    const result = (await claimBountyRemote(env, "b1", workerRefFor("w1"))) as {
      bounty: { id: string };
    };
    expect(result.bounty.id).toBe("b1");
    expect(calls[0].url).toContain(`${BOUNTIES_API_PREFIX}/bounties/b1/claim`);
    expect(calls[0].body).toEqual({ workerPubKey: "agentpay:w1" });
  });

  it("passes list filters as query params and surfaces upstream errors", async () => {
    let seen = "";
    const env = fakeEnv(async (req) => {
      seen = req.url;
      return Response.json({ items: [], total: 0 });
    });
    await listBounties(env, { status: "open", category: "dev", limit: 10, offset: 5 });
    expect(seen).toContain("status=open");
    expect(seen).toContain("category=dev");
    expect(seen).toContain("limit=10");
    expect(seen).toContain("offset=5");

    const failing = fakeEnv(async () => Response.json({ error: "not_found" }, { status: 404 }));
    await expect(claimBountyRemote(failing, "missing", "agentpay:w1")).rejects.toBeInstanceOf(HttpError);
  });

  it("forwards submit payloads", async () => {
    let body: unknown;
    const env = fakeEnv(async (req) => {
      body = JSON.parse((await req.text()) || "{}");
      return Response.json({ status: "submitted" });
    });
    await submitWorkRemote(env, "b1", { workUri: "https://example.com/w", notes: "done" });
    expect(body).toEqual({ workUri: "https://example.com/w", notes: "done" });
  });
});

describe("bounty links", () => {
  it("records a claim link and keeps settle status on re-claim", async () => {
    const { db, wallet } = await makeWallet();
    await linkBounty(db, {
      bountyId: "b1",
      walletId: wallet.id,
      agentId: "ag1",
      workerRef: workerRefFor(wallet.id),
      title: "Fix docs",
      amountSats: 5000,
    });
    let link = await getLink(db, "b1");
    expect(link?.wallet_id).toBe(wallet.id);
    expect(link?.status).toBe("claimed");

    await touchLinkStatus(db, "b1", "submitted");
    link = await getLink(db, "b1");
    expect(link?.status).toBe("submitted");

    await creditBountyPayout(db, fakeEnv(), {
      bountyId: "b1",
      walletId: wallet.id,
      amountSats: 5000,
    });
    await linkBounty(db, {
      bountyId: "b1",
      walletId: wallet.id,
      agentId: "ag1",
      workerRef: workerRefFor(wallet.id),
    });
    link = await getLink(db, "b1");
    expect(link?.status).toBe("paid");
    expect(link?.credited_cents).toBe(1);

    const links = await listLinks(db, wallet.id);
    expect(links).toHaveLength(1);
  });
});

describe("bounty payouts", () => {
  it("converts sats to cents at the configured rate with a 1-cent floor", () => {
    expect(centsForSats(40000, fakeEnv())).toBe(1);
    expect(centsForSats(4_000_000, fakeEnv())).toBe(100);
    expect(centsForSats(5000, fakeEnv())).toBe(1);
    expect(centsForSats(1, fakeEnv())).toBe(1);
    expect(centsForSats(100, { BOUNTY_SATS_PER_CENT: "100" } as AppEnv)).toBe(1);
  });

  it("credits the wallet once and is idempotent by bounty ref", async () => {
    const { db, wallet } = await makeWallet();
    await linkBounty(db, {
      bountyId: "b1",
      walletId: wallet.id,
      agentId: null,
      workerRef: workerRefFor(wallet.id),
      title: "Fix docs",
      amountSats: 5000,
    });

    const first = await creditBountyPayout(db, fakeEnv(), {
      bountyId: "b1",
      walletId: wallet.id,
      amountSats: 5000,
      settleTxid: "tx1",
    });
    expect(first.credited).toBe(true);
    expect(first.amountCents).toBe(1);
    expect(first.balanceCents).toBe(1);

    const replay = await creditBountyPayout(db, fakeEnv(), {
      bountyId: "b1",
      walletId: wallet.id,
      amountSats: 5000,
    });
    expect(replay.credited).toBe(false);
    expect(replay.balanceCents).toBe(1);

    const events = await listLedger(db, wallet.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("adjust");
    expect(events[0].ref).toBe("bounty:b1");
    expect(events[0].amount_cents).toBe(1);
  });

  it("credits a wallet that already holds a top-up balance", async () => {
    const { db, wallet } = await makeWallet();
    await creditTopup(db, { walletId: wallet.id, amountCents: 2000, ref: "cs_1" });
    const result = await creditBountyPayout(db, fakeEnv(), {
      bountyId: "b2",
      walletId: wallet.id,
      amountSats: 4_000_000,
    });
    expect(result.credited).toBe(true);
    expect(result.balanceCents).toBe(2100);
  });
});

describe("handleBountyEvent", () => {
  it("ignores bounties with no agentpay link", async () => {
    const { db } = await makeWallet();
    const res = await handleBountyEvent(db, fakeEnv(), { bountyId: "nope", outcome: "paid", amountSats: 5000 });
    expect(res).toEqual({ ok: true, credited: false, reason: "no_agentpay_link" });
  });

  it("credits the linked wallet on paid and marks refunded on refund", async () => {
    const { db, wallet } = await makeWallet();
    await linkBounty(db, {
      bountyId: "b3",
      walletId: wallet.id,
      agentId: null,
      workerRef: workerRefFor(wallet.id),
      amountSats: 9000,
    });
    const paid = await handleBountyEvent(db, fakeEnv(), {
      bountyId: "b3",
      outcome: "paid",
      amountSats: 80000,
      settleTxid: "tx9",
    });
    expect(paid.credited).toBe(true);
    expect(paid.amountCents).toBe(2);
    expect((await getLink(db, "b3"))?.settle_txid).toBe("tx9");

    await linkBounty(db, {
      bountyId: "b4",
      walletId: wallet.id,
      agentId: null,
      workerRef: workerRefFor(wallet.id),
      amountSats: 5000,
    });
    const refunded = await handleBountyEvent(db, fakeEnv(), { bountyId: "b4", outcome: "refunded" });
    expect(refunded.credited).toBe(false);
    expect((await getLink(db, "b4"))?.status).toBe("refunded");
  });

  it("rejects non-positive amounts", async () => {
    const { db, wallet } = await makeWallet();
    await expect(
      creditBountyPayout(db, fakeEnv(), { bountyId: "b0", walletId: wallet.id, amountSats: 0 }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("trust settled-work push", () => {
  it("prefers the bounties account, then the bare key, then the wallet", () => {
    expect(trustSubjectForWorker({ worker_account: 42, worker_pubkey: "03ab", wallet_id: "apw_x" })).toBe("account:42");
    expect(trustSubjectForWorker({ worker_account: null, worker_pubkey: "03".repeat(33), wallet_id: "apw_x" })).toBe(
      `key:${"03".repeat(33)}`,
    );
    expect(trustSubjectForWorker({ worker_account: null, worker_pubkey: "agentpay:apw_x", wallet_id: "apw_x" })).toBe(
      "wallet:apw_x",
    );
    expect(trustSubjectForWorker({})).toBe(null);
  });

  it("posts the observation and reports what Trust stored", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ observations: 1 });
    }) as typeof fetch;
    try {
      const ok = await pushTrustBountyPaid(
        { TRUST_URL: "https://trust.test", TRUST_INGEST_SECRET: "s3cret" } as never,
        { subject: "key:abc", bountyId: "b9", amountSats: 8000, txid: "t".repeat(64) },
      );
      expect(ok).toBe(true);
      expect(seen.length).toBe(1);
      expect(seen[0].url).toBe("https://trust.test/v1/ingest");
      expect(seen[0].headers["x-trust-internal"]).toBe("s3cret");
      const obs = (seen[0].body as { observations: Array<Record<string, unknown>> }).observations[0];
      expect(obs).toMatchObject({ subject: "key:abc", source: "agentpay", kind: "bounty_paid", ref: "b9", value: 8000 });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("skips silently without a secret and never throws on failure", async () => {
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      throw new Error("network down");
    }) as typeof fetch;
    try {
      expect(
        await pushTrustBountyPaid({} as never, { subject: "key:abc", bountyId: "b9", amountSats: 1, txid: "t" }),
      ).toBe(false);
      expect(calls.length).toBe(0);
      expect(
        await pushTrustBountyPaid(
          { TRUST_URL: "https://trust.test", TRUST_INGEST_SECRET: "s" } as never,
          { subject: "key:abc", bountyId: "b9", amountSats: 1, txid: "t" },
        ),
      ).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
