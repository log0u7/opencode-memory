import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import {
  BODY_PREVIEW_MAX,
  canonicalScope,
  DEFAULT_LIMIT,
  FALLBACK_SCOPE,
  forget,
  KIND_MAX,
  list,
  MAX_LIMIT,
  renderEntries,
  save,
  search,
  SecretDetectedError,
  sweep,
} from "../src/lib/store.js";
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

  it("rejects credentials moved into the title or the kind", () => {
    const db = openMemoryDb(":memory:");
    expect(() =>
      save(db, input({ title: "openai key sk-abcdefghij1234567890", body: "harmless" })),
    ).toThrow(SecretDetectedError);
    expect(() =>
      save(db, input({ kind: "gotcha ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    ).toThrow(SecretDetectedError);
    db.close();
  });

  it("rejects a kind longer than the cap", () => {
    const db = openMemoryDb(":memory:");
    expect(() => save(db, input({ kind: "k".repeat(KIND_MAX + 1) }))).toThrow(/kind/);
    expect(() => save(db, input({ kind: "k".repeat(KIND_MAX) }))).not.toThrow();
    db.close();
  });

  it("replaces an entry that repeats a scope and title instead of duplicating it", () => {
    const db = openMemoryDb(":memory:");
    const first = save(db, input({ body: "batches of 1000" }));
    const second = save(db, input({ title: first.title.toUpperCase(), body: "batches of 500" }), {
      now: first.updated_at + 1,
    });

    expect(second.id).toBe(first.id);
    expect(second.body).toBe("batches of 500");
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBeGreaterThan(first.updated_at);
    expect(list(db, { scope: "/work/project" })).toHaveLength(1);
    db.close();
  });

  it("keeps same-titled entries of different scopes apart", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ scope: "/work/a" }));
    save(db, input({ scope: "/work/b" }));

    expect(list(db, { scope: "/work/a" })).toHaveLength(1);
    expect(list(db, { scope: "/work/b" })).toHaveLength(1);
    db.close();
  });

  it("sees one canonical scope whatever the trailing slash", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ scope: "/work/project/" }));
    expect(list(db, { scope: "/work/project" })).toHaveLength(1);
    db.close();
  });

  it("purges expired entries when saving", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "stale", expires_at: Date.now() - 1000 }));
    save(db, input({ title: "fresh" }));

    expect(list(db, { scope: "/work/project" }).map((e) => e.title)).toEqual(["fresh"]);
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

  it("clamps an out-of-range limit instead of returning the whole store", () => {
    const db = openMemoryDb(":memory:");
    for (let i = 0; i < MAX_LIMIT + 5; i++) {
      save(db, input({ title: `postgres note ${i}` }));
    }

    // SQLite reads a negative LIMIT as unbounded and a fuzzy one as a type error.
    expect(search(db, { query: "postgres", scope: "/work/project", limit: -1 })).toHaveLength(
      DEFAULT_LIMIT.search,
    );
    expect(search(db, { query: "postgres", scope: "/work/project", limit: 1e9 })).toHaveLength(
      MAX_LIMIT,
    );
    expect(list(db, { scope: "/work/project", limit: 1.5 })).toHaveLength(1);
    expect(list(db, { scope: "/work/project", limit: 0 })).toHaveLength(DEFAULT_LIMIT.list);
    db.close();
  });

  it("finds an entry when only some query tokens match", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres migration", body: "batches of 1000" }));

    expect(search(db, { query: "postgres", scope: "/work/project" })).toHaveLength(1);
    expect(search(db, { query: "migration strategy", scope: "/work/project" })).toHaveLength(1);
    expect(search(db, { query: "migrat", scope: "/work/project" })).toHaveLength(1);
    db.close();
  });

  it("returns nothing instead of failing on an empty query", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres migration" }));
    expect(search(db, { query: "   ", scope: "/work/project" })).toEqual([]);
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

    expect(forget(db, { id: e1.id, scope: "/work/project" })).toBe(1);
    expect(forget(db, { query: "postgres", scope: "/work/project" })).toBe(1);
    expect(list(db, { scope: "/work/project" })).toEqual([]);
    db.close();
  });

  it("keeps matching entries of other scopes when deleting by query", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres batching", scope: "/work/project" }));
    save(db, input({ title: "postgres container", scope: "/work/other" }));

    expect(forget(db, { query: "postgres", scope: "/work/project" })).toBe(1);
    expect(list(db, { scope: "/work/other" })).toHaveLength(1);
    db.close();
  });

  it("deletes global entries from any scope but never foreign ones", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres tuning", scope: "global" }));
    save(db, input({ title: "postgres sharding", scope: "/work/other" }));

    expect(forget(db, { query: "postgres", scope: "/work/project" })).toBe(1);
    expect(list(db, { scope: "/work/project" })).toEqual([]);
    expect(list(db, { scope: "/work/other" })).toHaveLength(1);
    db.close();
  });

  it("refuses to delete by id outside the caller scope", () => {
    const db = openMemoryDb(":memory:");
    const foreign = save(db, input({ title: "postgres replica", scope: "/work/other" }));

    expect(forget(db, { id: foreign.id, scope: "/work/project" })).toBe(0);
    expect(list(db, { scope: "/work/other" })).toHaveLength(1);
    db.close();
  });

  it("reports zero when neither id nor query matches anything", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres batching" }));

    expect(forget(db, { query: "zebra qux", scope: "/work/project" })).toBe(0);
    expect(forget(db, { query: "   ", scope: "/work/project" })).toBe(0);
    expect(forget(db, { id: "missing", scope: "/work/project" })).toBe(0);
    expect(list(db, { scope: "/work/project" })).toHaveLength(1);
    db.close();
  });

  it("deletes by query on an exact all-token match, not on a fuzzy one", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres batching" }));
    save(db, input({ title: "docker compose" }));

    expect(forget(db, { query: "postgres batching", scope: "/work/project" })).toBe(1);
    // "batch" is only a prefix of the stored tokens: the fuzzy fallback would match,
    // and a destructive path must never use it.
    expect(forget(db, { query: "batch", scope: "/work/project" })).toBe(0);
    expect(list(db, { scope: "/work/project" }).map((e) => e.title)).toEqual(["docker compose"]);
    db.close();
  });
});

describe("store scope canonicalization", () => {
  it("normalizes trailing slashes, whitespace and empty values", () => {
    expect(canonicalScope("/work/project")).toBe("/work/project");
    expect(canonicalScope("/work/project/")).toBe("/work/project");
    expect(canonicalScope("  /work/project  ")).toBe("/work/project");
    expect(canonicalScope("/")).toBe(FALLBACK_SCOPE);
    expect(canonicalScope(undefined, "/work/project")).toBe("/work/project");
    expect(canonicalScope("", "")).toBe(FALLBACK_SCOPE);
    expect(canonicalScope(undefined)).toBe(FALLBACK_SCOPE);
  });

  it("prefers the first usable candidate so both entry points agree", () => {
    expect(canonicalScope("/work/a", "/work/b")).toBe("/work/a");
    expect(canonicalScope(undefined, undefined, "/work/c")).toBe("/work/c");
    expect(canonicalScope("", undefined)).toBe(FALLBACK_SCOPE);
  });

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

describe("store rendering", () => {
  it("keeps a tool result bounded whatever the body length", () => {
    const db = openMemoryDb(":memory:");
    const entries = [save(db, input({ body: "z".repeat(8000) }))];
    const rendered = renderEntries(entries);

    expect(rendered.length).toBeLessThan(BODY_PREVIEW_MAX + 500);
    expect(rendered).toContain("[truncated]");
    expect(rendered).toContain(entries[0]?.title ?? "");
    db.close();
  });

  it("renders entries as compact json, not pretty printed", () => {
    const db = openMemoryDb(":memory:");
    const entries = [save(db, input())];
    expect(renderEntries(entries)).not.toContain("\n");
    db.close();
  });
});

describe("store.sweep", () => {
  it("deletes expired rows and reports the count", () => {
    const db = openMemoryDb(":memory:");
    const insert = (id: string, expires_at: number | null) =>
      db.conn.run(
        "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, "/work/project", "fact", id, "body", "[]", 1, 1, expires_at],
      );
    insert("old", 1000);
    insert("kept", 2000);

    expect(sweep(db, { now: 1500 })).toBe(1);
    expect(list(db, { scope: "/work/project", now: 1500 }).map((e) => e.title)).toEqual(["kept"]);
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

describe("fts query escaping", () => {
  it("handles extra whitespace and double quotes safely", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "quote handling" }));

    const hits = search(db, { query: '  "quote"   handling  ', scope: "/work/project" });
    expect(hits).toHaveLength(1);
    db.close();
  });
});
