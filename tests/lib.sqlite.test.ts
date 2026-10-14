import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openSqlite } from "../src/lib/sqlite.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-sqlite-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The Bun runtime branch of the adapter is exercised with a stub: it only has
// to honor the four operations the SqliteConn wrapper forwards.
describe("openSqlite (node runtime branch)", () => {
  // A bare `require` is undefined inside an ES module, which is how the built plugin
  // is loaded: this guards the adapter against that regression.
  it("opens a real node:sqlite connection and round-trips a row", () => {
    const globalRuntime = globalThis as { Bun?: unknown };
    const original = globalRuntime.Bun;
    delete globalRuntime.Bun;

    try {
      const conn = openSqlite(join(dir, "node.db"));
      conn.exec("CREATE TABLE t (a TEXT)");
      conn.run("INSERT INTO t VALUES (?)", ["x"]);

      expect(conn.all<{ a: string }>("SELECT a FROM t")).toEqual([{ a: "x" }]);
      expect(conn.get<{ a: string }>("SELECT a FROM t")?.a).toBe("x");
      conn.close();
    } finally {
      if (original !== undefined) {
        globalRuntime.Bun = original;
      }
    }
  });
});

class FakeBunDatabase {
  private statements = new Map<string, unknown[]>();

  query(sql: string) {
    const rows = this.statements.get(sql) ?? [];
    return {
      all: () => rows,
      get: () => rows[0] ?? null,
      run: () => undefined,
    };
  }

  run(sql: string, params: unknown[] = []): void {
    this.statements.set(sql, params);
  }

  close(): void {}
}

describe("openSqlite (bun runtime branch)", () => {
  it("uses bun:sqlite when the Bun global is present", () => {
    const globalRuntime = globalThis as { Bun?: unknown };
    const original = globalRuntime.Bun;
    globalRuntime.Bun = { sqlite: { Database: FakeBunDatabase } };

    try {
      const conn = openSqlite(join(dir, "fake.db"));
      conn.run("INSERT INTO t VALUES (?)", [1]);
      expect(conn.all("INSERT INTO t VALUES (?)")).toEqual([1]);
      expect(conn.get<{ a: number }>("INSERT INTO t VALUES (?)")?.a).toBeUndefined();
      conn.exec("PRAGMA journal_mode = WAL");
      conn.close();
    } finally {
      if (original === undefined) {
        delete globalRuntime.Bun;
      } else {
        globalRuntime.Bun = original;
      }
    }
  });
});
