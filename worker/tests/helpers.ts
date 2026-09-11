/**
 * Test-only D1 shim backed by Node's built-in SQLite (`node:sqlite`), so unit
 * tests exercise the real schema and the real SQL guards (atomic debit,
 * idempotent top-ups, daily limits) without miniflare.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");

type Row = Record<string, unknown>;

class FakeStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const info = this.db.prepare(this.sql).run(...(this.args as never[]));
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return (row as T) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const results = this.db.prepare(this.sql).all(...(this.args as never[])) as T[];
    return { results, success: true, meta: { changes: 0 } };
  }
}

export type TestDb = D1Database & { raw: DatabaseSync };

export function makeTestDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schema);
  const db = {
    raw,
    prepare: (sql: string) => new FakeStatement(raw, sql),
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
  };
  return db as unknown as TestDb;
}
