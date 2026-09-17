import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { forget, list, save, search } from "../src/lib/store.js";
import type { EntryInput } from "../src/types/entry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    scope: "/work/project",
    kind: "decision",
    title: "Use batching for migration",
    body: "Migrate postgres rows in batches of 1000 to avoid lock contention.",
    tags: ["db", "postgres"],
    expires_at: null,
    ...overrides,
  };
}

describe("store.save", () => {
  it("stores an entry with generated id and timestamps", () => {
    const db = openMemoryDb(":memory:");
    const entry = save(db, input());

    expect(entry.id).toMatch(/[0-9a-f-]{36}/);
    expect(entry.created_at).toBeGreaterThan(0);
    expect(entry.updated_at).toBe(entry.created_at);
    expect(entry.scope).toBe("/work/project");
    expect(entry.tags).toEqual(["db", "postgres"]);
    db.close();
  });

  it("rejects bodies that look like api keys", () => {
    const db = openMemoryDb(":memory:");
    expect(() => save(db, input({ body: "the key is sk-abcdefghij1234567890 keep it" }))).toThrow();
    expect(() =>
      save(db, input({ body: "token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    ).toThrow();
    db.close();
  });

  it("enforces length caps", () => {
    const db = openMemoryDb(":memory:");
    expect(() => save(db, input({ title: "x".repeat(121) }))).toThrow();
    expect(() => save(db, input({ body: "y".repeat(8001) }))).toThrow();
    expect(() =>
      save(db, input({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) })),
    ).toThrow();
    db.close();
  });
});

describe("store.search", () => {
  it("finds by query with bm25 ranking and scope fallback to global", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres migration", body: "batches of 1000" }));
    save(
      db,
      input({
        scope: "global",
        title: "docker tip",
        body: "postgres container needs shared_buffers",
      }),
    );

    const hits = search(db, { query: "postgres", scope: "/work/project" });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.scope).toBe("/work/project");
    expect(hits[1]?.scope).toBe("global");
    db.close();
  });

  it("excludes expired entries", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ expires_at: Date.now() - 1000 }));
    expect(search(db, { query: "migration", scope: "/work/project" })).toEqual([]);
    db.close();
  });

  it("respects limit", () => {
    const db = openMemoryDb(":memory:");
    for (let i = 0; i < 5; i++) {
      save(db, input({ title: `postgres note ${i}` }));
    }
    expect(search(db, { query: "postgres", scope: "/work/project", limit: 2 })).toHaveLength(2);
    db.close();
  });
});

describe("store.list", () => {
  it("lists newest first within scope and global", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "first" }), { now: 1000 });
    const b = save(db, input({ title: "second" }), { now: 2000 });
    const g = save(db, input({ scope: "global", title: "global note" }), { now: 3000 });

    const hits = list(db, { scope: "/work/project" });
    expect(hits.map((e) => e.id)).toEqual([g.id, b.id, a.id]);
    db.close();
  });
});

describe("store.forget", () => {
  it("deletes by id and by query, returning deleted count", () => {
    const db = openMemoryDb(":memory:");
    const e1 = save(db, input());
    save(db, input({ title: "another postgres thing" }));

    expect(forget(db, { id: e1.id })).toBe(1);
    expect(forget(db, { query: "postgres" })).toBe(1);
    expect(list(db, { scope: "/work/project" })).toEqual([]);
    db.close();
  });
});

describe("store with corrupted rows", () => {
  it("survives unparseable tags without crashing", () => {
    const db = openMemoryDb(":memory:");
    db.conn.run(
      "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["bad1", "/work/project", "fact", "corrupt", "body", "not-json", 1, 1, null],
    );

    const hits = list(db, { scope: "/work/project" });
    expect(hits[0]?.tags).toEqual([]);
    db.close();
  });
});

describe("fts query escaping", () => {
  it("handles extra whitespace and double quotes safely", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "quote handling" }));

    const hits = search(db, { query: '  "quote"   handling  ', scope: "/work/project" });
    expect(hits).toHaveLength(1);
    db.close();
  });
});
