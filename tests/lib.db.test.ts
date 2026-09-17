import { mkdtempSync, rmSync } from "node:fs";
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
});
