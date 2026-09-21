/**
 * Google Identity Services (GIS) ID-token verification.
 *
 * Sign-in uses Google's ID-token flow only: no client secret, no redirect.
 * We decode the JWT, fetch Google's RS256 public keys (cached 1h), verify the
 * signature via WebCrypto, and check issuer / audience / expiry / subject.
 *
 * The ID token is never logged and never persisted — only sub, email and name
 * end up in the DB.
 */
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CERTS_TTL_MS = 60 * 60 * 1000;
/** Clock-skew leeway, seconds, when checking exp. */
const EXP_LEEWAY_S = 60;

let certsCache: { at: number; keys: JsonWebKey[] } | null = null;

async function googlePublicKeys(): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (certsCache && now - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error(`Google cert fetch failed (HTTP ${res.status})`);
  const json = (await res.json()) as { keys?: JsonWebKey[] };
  if (!Array.isArray(json.keys)) throw new Error("Google cert fetch returned no keys");
  certsCache = { at: now, keys: json.keys };
  return json.keys;
}

function b64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleIdentity> {
  const parts = String(idToken ?? "").split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const [headB64, payloadB64, sigB64] = parts;
  let header: { kid?: unknown; alg?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(headB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch {
    throw new Error("Malformed ID token");
  }
  if (header.alg !== "RS256") throw new Error("Unexpected ID token algorithm");
  if (typeof header.kid !== "string" || !header.kid) throw new Error("ID token is missing its key id");
  const keys = await googlePublicKeys();
  const jwk = keys.find((k) => (k as { kid?: unknown }).kid === header.kid);
  if (!jwk) throw new Error("ID token was signed by an unknown key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${headB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(sigB64), data);
  if (!valid) throw new Error("Invalid ID token signature");

  const iss = payload.iss;
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com")
    throw new Error("Invalid ID token issuer");
  if (payload.aud !== clientId) throw new Error("ID token was issued for a different client");
  const nowS = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp < nowS - EXP_LEEWAY_S) throw new Error("ID token is expired");
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new Error("ID token has no subject");
  const email = typeof payload.email === "string" ? payload.email : "";
  const name =
    typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : email || "Google user";
  return { sub, email, name };
}
