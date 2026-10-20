import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openMemoryDb", () => {
  it("creates schema and enables WAL on a file database", () => {
    const db = openMemoryDb(join(dir, "memory.db"));

    const journal = db.conn.get<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(journal?.journal_mode).toBe("wal");

    const tables = db.conn
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'entries%' ORDER BY name",
      )
      .map((r) => r.name);

    expect(tables).toContain("entries");
    expect(tables).toContain("entries_fts");

    db.close();
  });

  it.skipIf(process.platform === "win32")(
    "creates the store file and its directory with restrictive permissions",
    () => {
      const file = join(dir, "nested", "memory.db");
      const db = openMemoryDb(file);

      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
      for (const suffix of ["-wal", "-shm"]) {
        expect(statSync(`${file}${suffix}`).mode & 0o777).toBe(0o600);
      }
      db.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens an existing store created with loose permissions",
    () => {
      const file = join(dir, "memory.db");
      const db = openMemoryDb(file);
      db.close();
      chmodSync(file, 0o666);

      const reopened = openMemoryDb(file);
      reopened.close();

      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves a directory it did not create to its owner",
    () => {
      const parent = join(dir, "shared");
      mkdirSync(parent);
      // Umask-independent: the point is that openMemoryDb leaves the mode alone.
      chmodSync(parent, 0o755);
      const file = join(parent, "memory.db");
      const db = openMemoryDb(file);
      db.close();

      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(parent).mode & 0o777).toBe(0o755);
    },
  );

  it("keeps the FTS index in sync through triggers", () => {
    const db = openMemoryDb(join(dir, "memory.db"));

    db.conn.run(
      "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "e1",
        "/w",
        "decision",
        "Postgres migration",
        "Migrate in batches of 1000",
        "[]",
        1,
        1,
        null,
      ],
    );

    const queryHits =
      "SELECT e.id AS id FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid WHERE entries_fts MATCH ?";

    const hits = db.conn.all<{ id: string }>(queryHits, ["migration"]);
    expect(hits.map((h) => h.id)).toEqual(["e1"]);

    db.conn.run("DELETE FROM entries WHERE id = ?", ["e1"]);
    const after = db.conn.all<{ id: string }>(queryHits, ["migration"]);
    expect(after).toEqual([]);

    db.close();
  });

  it("reopening keeps data (durable store)", () => {
    const path = join(dir, "memory.db");

    const first = openMemoryDb(path);
    first.conn.run(
      "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["e1", "/w", "fact", "token endpoint", "audience is gateway", "[]", 1, 1, null],
    );
    first.close();

    const second = openMemoryDb(path);
    const row = second.conn.get<{ id: string; title: string }>("SELECT id, title FROM entries");
    expect(row?.id).toBe("e1");
    second.close();
  });

  it("adds the columns introduced after a store was first created", () => {
    const path = join(dir, "memory.db");
    const legacy = openMemoryDb(path);
    // A store written by an earlier release: the columns added since are not there.
    legacy.conn.run("ALTER TABLE entries DROP COLUMN source");
    legacy.close();

    const reopened = openMemoryDb(path);
    const columns = reopened.conn
      .all<{ name: string }>("PRAGMA table_info(entries)")
      .map((column) => column.name);
    expect(columns).toContain("source");

    // A row written before the migration reads back with no writer rather than failing.
    reopened.conn.run(
      "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["e1", "/w", "fact", "legacy note", "written before the column existed", "[]", 1, 1, null],
    );
    const rows = reopened.conn.all<{ id: string; source: string | null }>(
      "SELECT id, source FROM entries",
    );
    expect(rows.map((row) => row.id)).toEqual(["e1"]);
    expect(rows[0]?.source).toBeNull();
    reopened.close();
  });
});
