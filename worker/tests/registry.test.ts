import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers";
import { getService, listServices, registryAvailable, rowToService } from "../src/registry";

const XM_TABLE = `
CREATE TABLE xm_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  manifest_url TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  network TEXT NOT NULL DEFAULT '',
  pay_to TEXT NOT NULL DEFAULT '',
  owner_contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  featured INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT NOT NULL DEFAULT '[]',
  tool_count INTEGER NOT NULL DEFAULT 0,
  paid_count INTEGER NOT NULL DEFAULT 0,
  free_count INTEGER NOT NULL DEFAULT 0,
  min_price_sats INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  reports_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT
);`;

function seedService(db: ReturnType<typeof makeTestDb>) {
  db.raw.exec(XM_TABLE);
  db.raw
    .prepare(
      "INSERT INTO xm_services (id, name, tagline, manifest_url, base_url, network, pay_to, status, featured, tools_json, tool_count, paid_count, free_count, min_price_sats) VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', 1, ?, 2, 1, 1, 100)",
    )
    .run(
      "s_test",
      "OCR API",
      "Image to text",
      "https://example.com/manifest.json",
      "https://example.com",
      "bsv",
      "1PayToAddress",
      JSON.stringify([
        { name: "ocr", method: "POST", path: "https://example.com/ocr", priceSats: 100, paid: true, description: "OCR one page", body: "" },
        { name: "ping", method: "GET", path: "https://example.com/ping", priceSats: 0, paid: false, description: "", body: "" },
      ]),
    );
}

describe("x402market registry discovery", () => {
  it("reports unavailable when xm_services has not been created", async () => {
    const db = makeTestDb();
    expect(await registryAvailable(db)).toBe(false);
    expect(await listServices(db)).toEqual([]);
  });

  it("lists verified services with parsed tools", async () => {
    const db = makeTestDb();
    seedService(db);
    expect(await registryAvailable(db)).toBe(true);
    const services = await listServices(db);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("OCR API");
    expect(services[0].featured).toBe(true);
    expect(services[0].tools.map((t) => t.name)).toEqual(["ocr", "ping"]);
    expect(services[0].tools[0].priceSats).toBe(100);
  });

  it("fetches a service by id and returns null for unknown or unverified ids", async () => {
    const db = makeTestDb();
    seedService(db);
    const service = await getService(db, "s_test");
    expect(service?.payTo).toBe("1PayToAddress");
    expect(await getService(db, "s_missing")).toBeNull();
    db.raw.exec("UPDATE xm_services SET status = 'hidden' WHERE id = 's_test'");
    expect(await getService(db, "s_test")).toBeNull();
  });

  it("survives malformed tools_json", () => {
    const row = {
      id: "s_bad",
      name: "Bad",
      tagline: "",
      description: "",
      manifest_url: "https://example.com/m.json",
      base_url: "",
      network: "",
      pay_to: "",
      status: "verified",
      featured: 0,
      tools_json: "{not json",
      tool_count: 0,
      paid_count: 0,
      free_count: 0,
      min_price_sats: null,
      created_at: "",
      updated_at: "",
      last_checked_at: null,
    };
    expect(rowToService(row).tools).toEqual([]);
  });
});
