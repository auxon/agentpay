/**
 * Google sign-in: ID-token verification (worker/src/google.ts) and the
 * /auth/google/config + POST /auth/google + POST /auth/google/link routes.
 *
 * ID tokens are signed locally with a WebCrypto RS256 key; the Google cert
 * endpoint is stubbed so no network is touched.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "./helpers";
import { api } from "../src/api";
import { verifyGoogleIdToken } from "../src/google";
import { createWallet } from "../src/ledger";
import type { AppEnv } from "../src/types";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const KID = "test-kid";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeIdToken(payload: Record<string, unknown>): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = new TextEncoder().encode(`${header}.${body}`);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data));
  return `${header}.${body}.${b64url(sig)}`;
}

function idPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-sub-123",
    email: "ada@example.com",
    name: "Ada",
    iat: nowS - 10,
    exp: nowS + 3600,
    ...overrides,
  };
}

function stubGoogleCerts(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })),
  );
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  (publicJwk as { kid?: string }).kid = KID;
  stubGoogleCerts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  stubGoogleCerts();
});

describe("verifyGoogleIdToken", () => {
  it("accepts a properly signed token", async () => {
    const token = await makeIdToken(idPayload());
    const identity = await verifyGoogleIdToken(token, CLIENT_ID);
    expect(identity).toEqual({ sub: "google-sub-123", email: "ada@example.com", name: "Ada" });
  });

  it("rejects a token for a different audience", async () => {
    const token = await makeIdToken(idPayload({ aud: "other-client" }));
    await expect(verifyGoogleIdToken(token, CLIENT_ID)).rejects.toThrow(/different client/);
  });

  it("rejects an expired token", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const token = await makeIdToken(idPayload({ exp: nowS - 3600 }));
    await expect(verifyGoogleIdToken(token, CLIENT_ID)).rejects.toThrow(/expired/);
  });

  it("rejects a tampered signature", async () => {
    const token = await makeIdToken(idPayload());
    const parts = token.split(".");
    const badSig = parts[2].slice(0, -2) + (parts[2].endsWith("AA") ? "BB" : "AA");
    await expect(verifyGoogleIdToken(`${parts[0]}.${parts[1]}.${badSig}`, CLIENT_ID)).rejects.toThrow(
      /signature/,
    );
  });

  it("rejects a bad issuer and a missing subject", async () => {
    const badIss = await makeIdToken(idPayload({ iss: "https://evil.example.com" }));
    await expect(verifyGoogleIdToken(badIss, CLIENT_ID)).rejects.toThrow(/issuer/);
    const noSub = await makeIdToken(idPayload({ sub: "" }));
    await expect(verifyGoogleIdToken(noSub, CLIENT_ID)).rejects.toThrow(/subject/);
  });
});

function req(path: string, db: TestDb, init?: RequestInit, envExtra?: Partial<AppEnv>) {
  const env = { DB: db, ...envExtra } as AppEnv;
  return Promise.resolve(api.request(path, init, env));
}

async function jsonOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("GET /auth/google/config", () => {
  it("reports unconfigured when no client id is set", async () => {
    const db = makeTestDb();
    const { status, body } = await jsonOf(await req("/api/agentpay/auth/google/config", db));
    expect(status).toBe(200);
    expect(body).toEqual({ configured: false, clientId: null });
  });

  it("reports configured with the client id when set", async () => {
    const db = makeTestDb();
    const { status, body } = await jsonOf(
      await req("/api/agentpay/auth/google/config", db, undefined, { GOOGLE_CLIENT_ID: CLIENT_ID }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ configured: true, clientId: CLIENT_ID });
  });
});

describe("POST /auth/google", () => {
  const env = { GOOGLE_CLIENT_ID: CLIENT_ID };

  it("501s when Google login is not configured", async () => {
    const db = makeTestDb();
    const { status, body } = await jsonOf(
      await req("/api/agentpay/auth/google", db, { method: "POST", body: JSON.stringify({ idToken: "x" }) }),
    );
    expect(status).toBe(501);
    expect(body.error).toMatch(/not configured/);
  });

  it("mints a wallet and user row for a new identity", async () => {
    const db = makeTestDb();
    const idToken = await makeIdToken(idPayload());
    const { status, body } = await jsonOf(
      await req("/api/agentpay/auth/google", db, { method: "POST", body: JSON.stringify({ idToken }) }, env),
    );
    expect(status).toBe(200);
    expect(body.isNew).toBe(true);
    expect(String(body.token)).toMatch(/^apw_/);
    expect(String(body.recoveryCode)).toMatch(/^apr_/);
    expect(body.walletId).toBeTruthy();
    const row = await db
      .prepare("SELECT * FROM ap_users WHERE google_sub = ?")
      .bind("google-sub-123")
      .first<{ wallet_id: string; email: string }>();
    expect(row?.wallet_id).toBe(body.walletId);
    expect(row?.email).toBe("ada@example.com");
  });

  it("returns the same wallet (fresh token) on second login", async () => {
    const db = makeTestDb();
    const idToken = await makeIdToken(idPayload());
    const post = (t: string) =>
      req("/api/agentpay/auth/google", db, { method: "POST", body: JSON.stringify({ idToken: t }) }, env).then(
        jsonOf,
      );
    const first = await post(idToken);
    const second = await post(idToken);
    expect(second.status).toBe(200);
    expect(second.body.isNew).toBe(false);
    expect(second.body.recoveryCode).toBeNull();
    expect(second.body.walletId).toBe(first.body.walletId);
    expect(second.body.token).not.toBe(first.body.token);
    // The old token no longer works: only the fresh hash is stored.
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM ap_users")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects an invalid ID token", async () => {
    const db = makeTestDb();
    const { status } = await jsonOf(
      await req("/api/agentpay/auth/google", db, { method: "POST", body: JSON.stringify({ idToken: "bogus" }) }, env),
    );
    expect(status).toBe(401);
  });
});

describe("POST /auth/google/link", () => {
  const env = { GOOGLE_CLIENT_ID: CLIENT_ID };

  it("attaches an existing wallet to the Google identity", async () => {
    const db = makeTestDb();
    const { wallet, token } = await createWallet(db, { name: "Old way" });
    const idToken = await makeIdToken(idPayload({ sub: "google-sub-999" }));
    const { status, body } = await jsonOf(
      await req(
        "/api/agentpay/auth/google/link",
        db,
        { method: "POST", body: JSON.stringify({ idToken, walletToken: token }) },
        env,
      ),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, walletId: wallet.id });
    const row = await db
      .prepare("SELECT wallet_id FROM ap_users WHERE google_sub = ?")
      .bind("google-sub-999")
      .first<{ wallet_id: string }>();
    expect(row?.wallet_id).toBe(wallet.id);
    // And a later sign-in lands on the linked wallet.
    const signIn = await jsonOf(
      await req("/api/agentpay/auth/google", db, { method: "POST", body: JSON.stringify({ idToken }) }, env),
    );
    expect(signIn.body.walletId).toBe(wallet.id);
    expect(signIn.body.isNew).toBe(false);
  });

  it("rejects a bad wallet token", async () => {
    const db = makeTestDb();
    const idToken = await makeIdToken(idPayload());
    const { status, body } = await jsonOf(
      await req(
        "/api/agentpay/auth/google/link",
        db,
        { method: "POST", body: JSON.stringify({ idToken, walletToken: "apw_" + "0".repeat(64) }) },
        env,
      ),
    );
    expect(status).toBe(401);
    expect(String(body.error)).toMatch(/Unknown or revoked/);
  });
});
