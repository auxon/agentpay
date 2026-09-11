import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { createAgent, createWallet, creditTopup, refundSpend, spend } from "../src/ledger";
import {
  attestationPublicKey,
  buildAttestation,
  clampAttestationDays,
  loadSigningKey,
  signAttestation,
  signingKeyId,
  stableStringify,
  verifyAttestation,
} from "../src/attestations";
import type { AppEnv } from "../src/types";
import { creditBountyPayout, linkBounty, workerRefFor } from "../src/bounties";

async function testKeyEnv(db: unknown): Promise<AppEnv> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { DB: db, ATTESTATION_KEY_JWK: JSON.stringify(jwk) } as unknown as AppEnv;
}

async function makeSpender() {
  const db = makeTestDb();
  const { wallet } = await createWallet(db, { name: "Reputable" });
  const { agent } = await createAgent(db, wallet.id, { name: "payer" });
  await creditTopup(db, { walletId: wallet.id, amountCents: 5000, ref: "cs_att_1" });
  await spend(db, {
    walletId: wallet.id,
    agent,
    amountCents: 120,
    description: "Resize",
    service: "BSV Wallets",
    tool: "resize",
  });
  await spend(db, {
    walletId: wallet.id,
    agent,
    amountCents: 80,
    description: "Timestamp",
    service: "BSV Wallets",
    tool: "timestamp",
  });
  await spend(db, {
    walletId: wallet.id,
    agent,
    amountCents: 50,
    description: "Usenet post",
    service: "UsenetBSV",
    tool: "post",
  });
  return { db, wallet, agent };
}

describe("stableStringify", () => {
  it("is deterministic regardless of key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      stableStringify({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    );
    expect(stableStringify({ a: 1 })).toBe('{"a":1}');
  });
});

describe("attestation signing", () => {
  it("signs and verifies, and rejects tampering", async () => {
    const { db, wallet } = await makeSpender();
    const env = await testKeyEnv(db);
    const attestation = await buildAttestation(db, wallet.id, 30);
    expect(attestation).not.toBeNull();
    expect(attestation!.metrics.settledPayments).toBe(3);
    expect(attestation!.metrics.spentCents).toBe(250);
    expect(attestation!.metrics.distinctServices).toBe(2);

    const signed = await signAttestation(env, attestation!);
    expect(signed?.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    const key = await attestationPublicKey(env);
    expect(key?.alg).toBe("ES256");

    expect(await verifyAttestation(key!.publicJwk, attestation!, signed!.signature)).toBe(true);

    const tampered = {
      ...attestation!,
      metrics: { ...attestation!.metrics, settledPayments: 999 },
    };
    expect(await verifyAttestation(key!.publicJwk, tampered, signed!.signature)).toBe(false);
  });

  it("rejects signatures from a different key", async () => {
    const { db, wallet } = await makeSpender();
    const env = await testKeyEnv(db);
    const otherEnv = await testKeyEnv(db);
    const attestation = await buildAttestation(db, wallet.id, 30);
    const signed = await signAttestation(env, attestation!);
    const otherKey = await attestationPublicKey(otherEnv);
    expect(await verifyAttestation(otherKey!.publicJwk, attestation!, signed!.signature)).toBe(false);
  });

  it("returns null with no key configured and null with no activity", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Empty" });
    expect(await loadSigningKey({ DB: db } as unknown as AppEnv)).toBeNull();
    expect(await buildAttestation(db, wallet.id, 30)).toBeNull();
  });

  it("clamps windows and derives a stable key id", async () => {
    expect(clampAttestationDays(undefined)).toBe(30);
    expect(clampAttestationDays(3650)).toBe(365);
    expect(clampAttestationDays(0)).toBe(1);
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    const first = await signingKeyId(jwk);
    const second = await signingKeyId(jwk);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it("counts refunds in the window", async () => {
    const { db, wallet, agent } = await makeSpender();
    await refundSpend(db, { walletId: wallet.id, agentId: agent.id, amountCents: 50, ref: "refund:att" });
    const attestation = await buildAttestation(db, wallet.id, 30);
    expect(attestation!.metrics.refundedCents).toBe(50);
    expect(attestation!.metrics.settledPayments).toBe(3);
  });
});

describe("bounty earnings attestation", () => {
  it("attests a wallet whose only activity is bounty income", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Earner" });
    await linkBounty(db, {
      bountyId: "b_att",
      walletId: wallet.id,
      agentId: null,
      workerRef: workerRefFor(wallet.id),
      title: "Task",
      amountSats: 400_000,
    });
    const env = {
      ...(await testKeyEnv(db)),
      BOUNTY_SATS_PER_CENT: "40000",
    } as AppEnv;
    await creditBountyPayout(db, env, {
      bountyId: "b_att",
      walletId: wallet.id,
      amountSats: 400_000,
    });

    const att = await buildAttestation(db, wallet.id, 30);
    expect(att).not.toBeNull();
    expect(att?.metrics.bountyPayouts).toBe(1);
    expect(att?.metrics.earnedCents).toBe(10);
    expect(att?.metrics.settledPayments).toBe(0);
  });

  it("still returns null when there is neither spending nor earnings", async () => {
    const db = makeTestDb();
    const { wallet } = await createWallet(db, { name: "Idle" });
    expect(await buildAttestation(db, wallet.id, 30)).toBeNull();
  });
});
