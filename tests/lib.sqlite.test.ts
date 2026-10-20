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

// A bare `require` is undefined inside an ES module, which is how the built plugin
// is loaded: this guards the adapter against that regression.
describe("openSqlite (node runtime branch)", () => {
  it("opens a real node:sqlite connection and round-trips a row", () => {
    const conn = openSqlite(join(dir, "node.db"));
    conn.exec("CREATE TABLE t (a TEXT)");
    conn.run("INSERT INTO t VALUES (?)", ["x"]);

    expect(conn.all<{ a: string }>("SELECT a FROM t")).toEqual([{ a: "x" }]);
    expect(conn.get<{ a: string }>("SELECT a FROM t")?.a).toBe("x");
    conn.close();
  });

  it("ignores a stale Bun global left by an older runtime", () => {
    // Bun 1.3 removed the Bun.sqlite global, so the branch must be chosen from the
    // runtime version: a leftover global must not pick the bun engine.
    const globalRuntime = globalThis as { Bun?: unknown };
    const original = globalRuntime.Bun;
    globalRuntime.Bun = { sqlite: { Database: class NeverLoaded {} } };

    try {
      const conn = openSqlite(join(dir, "node.db"));
      conn.exec("CREATE TABLE t (a TEXT)");
      conn.run("INSERT INTO t VALUES (?)", ["y"]);

      expect(conn.all<{ a: string }>("SELECT a FROM t")).toEqual([{ a: "y" }]);
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

// Bun 1.3 removed the Bun.sqlite global and ships the engine as the bun:sqlite module, so
// the branch is chosen from process.versions.bun and the module goes through the same
// createRequire seam as node:sqlite. The loader is injected because bun:sqlite does not
// exist under Node, which is where CI runs.
// ponytail: the real bun:sqlite module load is not covered by any test here. Vitest runs
// its workers on Node even when launched through `bun x`, so a Bun-gated test would be dead
// code, and the matrix has no Bun entry. Verify it by hand against the built dist:
// `bun -e 'import("./dist/lib/db.js").then(async (m) => { const db = m.openMemoryDb(":memory:"); db.close(); })'`
// Upgrade path: a Bun entry in the CI matrix.
describe("openSqlite (bun runtime branch)", () => {
  it("loads bun:sqlite for a Bun runtime that no longer exposes the Bun.sqlite global", () => {
    const versions = process.versions as { bun?: string };
    const original = versions.bun;
    versions.bun = "1.3.14";
    const asked: string[] = [];

    try {
      const conn = openSqlite(join(dir, "bun.db"), (id) => {
        asked.push(id);
        return { Database: FakeBunDatabase };
      });

      expect(asked).toEqual(["bun:sqlite"]);
      conn.run("INSERT INTO t VALUES (?)", [1]);
      expect(conn.all("INSERT INTO t VALUES (?)")).toEqual([1]);
      expect(conn.get<{ a: number }>("INSERT INTO t VALUES (?)")?.a).toBeUndefined();
      conn.exec("PRAGMA journal_mode = WAL");
      conn.close();
    } finally {
      if (original === undefined) {
        delete versions.bun;
      } else {
        versions.bun = original;
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
