const ALPH = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function nanoid(length = 8): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let id = "";
  for (const b of buf) id += ALPH[b % ALPH.length];
  return id;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${nanoid(10)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) return false;
  let out = 0;
  for (let i = 0; i < aa.byteLength; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** UTC day key for per-agent daily limit accounting. */
export function utcDay(t: number = Date.now()): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function cleanStr(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}
