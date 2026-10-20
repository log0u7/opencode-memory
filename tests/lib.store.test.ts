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
  saveEntry,
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
    expect(() => save(db, input({ body: "aws key AKIAABCDEFGHIJKLMNOP in notes" }))).toThrow(
      SecretDetectedError,
    );
    expect(() => save(db, input({ body: "gitlab token glpat-abcdefghijklmnopqrst" }))).toThrow(
      SecretDetectedError,
    );
    expect(() =>
      save(db, input({ body: "gcp key AIza0123456789abcdefghijklmnopqrstuvwxy here" })),
    ).toThrow(SecretDetectedError);
    expect(() => save(db, input({ body: "slack token xoxp-1234567890123-123456789" }))).toThrow(
      SecretDetectedError,
    );
    expect(() =>
      save(
        db,
        input({
          body: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        }),
      ),
    ).toThrow(SecretDetectedError);
    expect(() =>
      save(db, input({ body: "pem:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpA..." })),
    ).toThrow(SecretDetectedError);
    db.close();
  });

  it("rejects credentials in the token formats released since the first patterns", () => {
    const db = openMemoryDb(":memory:");
    // GitHub fine-grained PAT: the current default, not covered by the ghp_ class.
    expect(() =>
      save(
        db,
        input({
          body: "pat github_pat_11AAAA7Yk3mQ0abcdefghijklmnopqrstuvwxyz0123456789ABCDEF for ci",
        }),
      ),
    ).toThrow(SecretDetectedError);
    // GitHub OAuth and server-to-server classes.
    expect(() =>
      save(db, input({ body: "oauth gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    ).toThrow(SecretDetectedError);
    expect(() =>
      save(db, input({ body: "deploy ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
    ).toThrow(SecretDetectedError);
    // GitLab rotate token, npm granular token, AWS temporary id, Google OAuth token.
    expect(() => save(db, input({ body: "rotate glrt-abcdefghijklmnopqrst" }))).toThrow(
      SecretDetectedError,
    );
    expect(() =>
      save(db, input({ body: `npm token npm_${"a".repeat(36)} in the workflow` })),
    ).toThrow(SecretDetectedError);
    expect(() => save(db, input({ body: "temp aws ASIAABCDEFGHIJKLMNOP in notes" }))).toThrow(
      SecretDetectedError,
    );
    expect(() =>
      save(
        db,
        input({
          body: "google ya29.a0AfH6SBBcxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx in notes",
        }),
      ),
    ).toThrow(SecretDetectedError);
    // A webhook URL is a credential by itself.
    expect(() =>
      save(
        db,
        input({
          body: "hook https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnop",
        }),
      ),
    ).toThrow(SecretDetectedError);
    db.close();
  });

  it("accepts normal prose that merely mentions secrets", () => {
    const db = openMemoryDb(":memory:");
    expect(() =>
      save(
        db,
        input({
          body: "we rotated the password on the staging database; the api key lives in the vault, ask ops for access",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      save(db, input({ body: "the docs mention sk- keys and AKIA ids as examples of formats" })),
    ).not.toThrow();
    expect(() =>
      save(
        db,
        input({
          body: "the docs list gho_, github_pat_, glrt-, npm_ and ya29. as token formats to redact",
        }),
      ),
    ).not.toThrow();
    db.close();
  });

  it("enforces length caps", () => {
    const db = openMemoryDb(":memory:");
    expect(() => save(db, input({ title: "x".repeat(121) }))).toThrow();
    expect(() => save(db, input({ body: "y".repeat(8001) }))).toThrow();
    expect(() =>
      save(db, input({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) })),
    ).toThrow();
    // A tool result stays bounded, so a tag cannot smuggle an unbounded payload.
    expect(() => save(db, input({ tags: ["x".repeat(65)] }))).toThrow(/tag/i);
    expect(() => save(db, input({ tags: ["x".repeat(64)] }))).not.toThrow();
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

  it("tells a fresh save apart from a rewrite, so a caller can report it", () => {
    const db = openMemoryDb(":memory:");
    const created = saveEntry(db, input({ body: "batches of 1000" }));
    const rewritten = saveEntry(db, input({ body: "batches of 500" }), { now: Date.now() + 1 });

    expect(created.created).toBe(true);
    expect(rewritten.created).toBe(false);
    expect(rewritten.entry.id).toBe(created.entry.id);
    expect(saveEntry).toBeTypeOf("function");
    db.close();
  });

  it("persists a new expiry when rewriting an entry", () => {
    const db = openMemoryDb(":memory:");
    const first = save(db, input({ expires_at: Date.now() + 600_000 }));
    const later = Date.now() + 1_200_000;
    const rewritten = save(db, input({ expires_at: later }));

    expect(rewritten.id).toBe(first.id);
    expect(rewritten.expires_at).toBe(later);
    const stored = db.conn.get<{ expires_at: number | null }>(
      "SELECT expires_at FROM entries WHERE id = ?",
      [rewritten.id],
    );
    expect(stored?.expires_at).toBe(later);
    db.close();
  });

  it("clears the expiry when rewriting without one", () => {
    const db = openMemoryDb(":memory:");
    const first = save(db, input({ expires_at: Date.now() + 600_000 }));
    const rewritten = save(db, input({ expires_at: null }));

    expect(rewritten.id).toBe(first.id);
    expect(rewritten.expires_at).toBeNull();
    const stored = db.conn.get<{ expires_at: number | null }>(
      "SELECT expires_at FROM entries WHERE id = ?",
      [rewritten.id],
    );
    expect(stored?.expires_at).toBeNull();
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

  it("fills the remaining slots with prefix matches after the strict ones", () => {
    const db = openMemoryDb(":memory:");
    // The default fixture tags and body carry "postgres", so the fixtures here control
    // their own tokens.
    const strictOne = save(
      db,
      input({ tags: [], title: "postgres migration plan", body: "phased rollout" }),
    );
    const strictTwo = save(
      db,
      input({ tags: [], title: "postgres migration rollback", body: "safe rollback" }),
    );
    const looseOne = save(db, input({ tags: [], title: "postgresql tuning", body: "buffers" }));
    const looseTwo = save(db, input({ tags: [], title: "migrations checklist", body: "steps" }));

    const hits = search(db, { query: "postgres migration", scope: "/work/project" });

    // Every match comes back, strict ones first, each entry exactly once.
    expect(hits).toHaveLength(4);
    expect(
      hits
        .slice(0, 2)
        .map((e) => e.id)
        .sort(),
    ).toEqual([strictOne.id, strictTwo.id].sort());
    expect(
      hits
        .slice(2)
        .map((e) => e.id)
        .sort(),
    ).toEqual([looseOne.id, looseTwo.id].sort());
    expect(new Set(hits.map((e) => e.id)).size).toBe(4);
    db.close();
  });

  it("keeps the strict matches when the limit is smaller than the fused set", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ tags: [], title: "postgres migration plan", body: "phased rollout" }));
    save(db, input({ tags: [], title: "postgres migration rollback", body: "safe rollback" }));
    save(db, input({ tags: [], title: "postgresql tuning", body: "buffers" }));

    const hits = search(db, { query: "postgres migration", scope: "/work/project", limit: 2 });

    expect(hits.map((e) => e.title).sort()).toEqual([
      "postgres migration plan",
      "postgres migration rollback",
    ]);
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

  it("filters by kind across scope and global", () => {
    const db = openMemoryDb(":memory:");
    const lesson = save(db, input({ kind: "lesson", title: "old lesson" }), { now: 1000 });
    const globalLesson = save(
      db,
      input({ kind: "lesson", scope: "global", title: "global lesson" }),
      { now: 1500 },
    );
    save(db, input({ kind: "fact", title: "new fact" }), { now: 2000 });

    const hits = list(db, { scope: "/work/project", kind: "lesson" });
    expect(hits.map((e) => e.id)).toEqual([globalLesson.id, lesson.id]);
    db.close();
  });
});

describe("store.forget", () => {
  it("deletes by id and by query, returning the deleted entries", () => {
    const db = openMemoryDb(":memory:");
    const e1 = save(db, input());
    save(db, input({ title: "another postgres thing" }));

    expect(forget(db, { id: e1.id, scope: "/work/project" }).map((e) => e.id)).toEqual([e1.id]);
    const byQuery = forget(db, { query: "postgres", scope: "/work/project" });
    expect(byQuery.map((e) => e.title)).toEqual(["another postgres thing"]);
    expect(list(db, { scope: "/work/project" })).toEqual([]);
    db.close();
  });

  it("keeps matching entries of other scopes when deleting by query", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres batching", scope: "/work/project" }));
    save(db, input({ title: "postgres container", scope: "/work/other" }));

    expect(forget(db, { query: "postgres", scope: "/work/project" })).toHaveLength(1);
    expect(list(db, { scope: "/work/other" })).toHaveLength(1);
    db.close();
  });

  it("deletes by id across scopes, so closed worktrees stay cleanable", () => {
    const db = openMemoryDb(":memory:");
    const zombie = save(db, input({ title: "zombie note", scope: "/old/worktree" }));

    expect(forget(db, { id: zombie.id, scope: "/work/project" })).toHaveLength(1);
    expect(list(db, { scope: "/old/worktree" })).toEqual([]);
    db.close();
  });

  it("deletes global entries from any scope but never foreign ones", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres tuning", scope: "global" }));
    save(db, input({ title: "postgres sharding", scope: "/work/other" }));

    expect(forget(db, { query: "postgres", scope: "/work/project" })).toHaveLength(1);
    expect(list(db, { scope: "/work/project" })).toEqual([]);
    expect(list(db, { scope: "/work/other" })).toHaveLength(1);
    db.close();
  });

  it("deletes a foreign-scoped entry by id (ids are globally unique)", () => {
    const db = openMemoryDb(":memory:");
    const foreign = save(db, input({ title: "postgres replica", scope: "/work/other" }));

    expect(forget(db, { id: foreign.id, scope: "/work/project" })).toHaveLength(1);
    expect(list(db, { scope: "/work/other" })).toEqual([]);
    db.close();
  });

  it("reports nothing when neither id nor query matches anything", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres batching" }));

    expect(forget(db, { query: "zebra qux", scope: "/work/project" })).toEqual([]);
    expect(forget(db, { query: "   ", scope: "/work/project" })).toEqual([]);
    expect(forget(db, { id: "missing", scope: "/work/project" })).toEqual([]);
    expect(list(db, { scope: "/work/project" })).toHaveLength(1);
    db.close();
  });

  it("deletes by query on an exact all-token match, not on a fuzzy one", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres batching" }));
    save(db, input({ title: "docker compose" }));

    expect(forget(db, { query: "postgres batching", scope: "/work/project" })).toHaveLength(1);
    // "batch" is only a prefix of the stored tokens: the fuzzy fallback would match,
    // and a destructive path must never use it.
    expect(forget(db, { query: "batch", scope: "/work/project" })).toEqual([]);
    expect(list(db, { scope: "/work/project" }).map((e) => e.title)).toEqual(["docker compose"]);
    db.close();
  });

  it("returns every entry a query delete removed, not just the first", () => {
    const db = openMemoryDb(":memory:");
    // The default fixture tags carry "postgres", and tags are indexed: keep them out of
    // the way so the query matches on the title alone.
    const note = { tags: ["db"] };
    save(db, input({ ...note, title: "postgres batching", body: "batches" }));
    save(db, input({ ...note, title: "postgres replica", body: "replicas" }));
    save(db, input({ ...note, title: "postgres tuning", body: "tuning" }));
    save(db, input({ ...note, title: "docker compose", body: "containers" }));

    const deleted = forget(db, { query: "postgres", scope: "/work/project" });
    expect(deleted.map((e) => e.title).sort()).toEqual([
      "postgres batching",
      "postgres replica",
      "postgres tuning",
    ]);
    expect(deleted.every((e) => e.body.length > 0)).toBe(true);
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

  it("returns nothing instead of failing on a punctuation-only query", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "quote handling" }));
    expect(search(db, { query: "!!!", scope: "/work/project" })).toEqual([]);
    expect(search(db, { query: '"""', scope: "/work/project" })).toEqual([]);
    db.close();
  });
});

describe("entry title folding", () => {
  // ponytail: SQLite lower() folds ASCII only, so a non-ASCII title re-saved in a
  // different case is not deduped. Upgrade path: a normalized key column.
  it("dedups ascii titles case-insensitively but not non-ascii ones", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "Über config" }));

    expect(list(db, { scope: "/work/project" })).toHaveLength(1);

    const second = save(db, input({ title: "ÜBER CONFIG" }));
    expect(second.id).toBeTruthy();
    expect(list(db, { scope: "/work/project" })).toHaveLength(2);
    db.close();
  });

  it("dedups an ascii title in any case", () => {
    const db = openMemoryDb(":memory:");
    const first = save(db, input({ title: "use wal mode" }));
    const second = save(db, input({ title: "Use WAL Mode" }));

    expect(second.id).toBe(first.id);
    db.close();
  });
});
