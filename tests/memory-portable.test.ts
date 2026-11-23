import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";
import { createMemoryOps } from "../src/lib/memory-ops.js";
import {
  exportPortable,
  importPortable,
  portableDefaultPath,
  portableDirectory,
} from "../src/lib/portable.js";
import { allLive, list, save, saveEntry } from "../src/lib/store.js";
import type { EntryInput } from "../src/types/entry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-portable-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    scope: "/work/project-a",
    kind: "fact",
    title: "postgres batching",
    body: "migrate in batches of 1000",
    tags: [],
    expires_at: null,
    ...overrides,
  };
}

const SCOPE = "/work/project-a";

/** Seeds a row past the save-time secret scan, the way a pre-0.10 store or a loosened
 * pattern could have left one behind: export must still refuse to spread it. */
function rawInsert(db: MemoryDb, id: string, body: string): void {
  db.conn.run(
    "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', 1000, 1000)",
    [id, SCOPE, "fact", `row ${id}`, body],
  );
}

function portableEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "portable-1",
    scope: SCOPE,
    kind: "fact",
    title: "imported entry",
    body: "a body worth keeping",
    tags: [],
    created_at: 1,
    updated_at: 1,
    expires_at: null,
    status: "current",
    ...overrides,
  };
}

describe("portable export", () => {
  it("round-trips entries into a different store with the same ids and fields", () => {
    const dbA = openMemoryDb(":memory:");
    save(
      dbA,
      input({ title: "one", body: "first", tags: ["t1"], paths: ["src/a.ts"], source: "build" }),
      { now: 1000 },
    );
    save(dbA, input({ title: "two", body: "second", commit_sha: "abc1234" }), { now: 2000 });
    save(dbA, input({ title: "three", body: "third", expires_at: 9999999999999 }), { now: 3000 });

    const file = join(dir, "round-trip.jsonl");
    expect(exportPortable(dbA, SCOPE, file)).toBe(3);

    const dbB = openMemoryDb(":memory:");
    expect(importPortable(dbB, file)).toBe(3);
    expect(JSON.stringify(allLive(dbB, SCOPE))).toBe(JSON.stringify(allLive(dbA, SCOPE)));
    dbA.close();
    dbB.close();
  });

  it("preserves paths and commit_sha through the round-trip", () => {
    const dbA = openMemoryDb(":memory:");
    const entry = save(
      dbA,
      input({
        title: "anchored",
        paths: ["src/a.ts", "docs/b.md"],
        commit_sha: "0123456789abcdef",
      }),
      { now: 1000 },
    );
    const file = join(dir, "anchored.jsonl");
    exportPortable(dbA, SCOPE, file);

    const dbB = openMemoryDb(":memory:");
    importPortable(dbB, file);
    const copy = dbB.conn.get<{
      paths: string;
      commit_sha: string | null;
    }>("SELECT paths, commit_sha FROM entries WHERE id = ?", [entry.id]);
    expect(JSON.parse(String(copy?.paths))).toEqual(["src/a.ts", "docs/b.md"]);
    expect(copy?.commit_sha).toBe("0123456789abcdef");
    dbA.close();
    dbB.close();
  });

  it("writes atomically: complete file, mode 0600, no tmp residue", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "one" }), { now: 1000 });
    save(db, input({ title: "two" }), { now: 2000 });

    const file = join(dir, "nested", "export.jsonl");
    exportPortable(db, SCOPE, file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readdirSync(dirname(file)).filter((name) => name.includes(".tmp"))).toEqual([]);
    db.close();
  });

  it("cleans up the tmp file when the rename fails", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "one" }), { now: 1000 });

    // A directory sitting at the target path makes the rename fail after the tmp
    // file was written: the cleanup must leave no residue behind.
    const target = join(dir, "occupied");
    mkdirSync(target);
    expect(() => exportPortable(db, SCOPE, target)).toThrow();
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
    db.close();
  });

  it("never exports credential-like bodies", () => {
    const db = openMemoryDb(":memory:");
    rawInsert(db, "secret-row", "token sk-abcdefghijklmnopqrstuvwxyz");
    save(db, input({ title: "clean", body: "no secrets here" }), { now: 1000 });

    const file = join(dir, "secrets.jsonl");
    expect(exportPortable(db, SCOPE, file)).toBe(1);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("sk-abcdefghij");
    expect(text).toContain("clean");
    db.close();
  });

  it("applies rejectContent and caps with limit", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "keep", body: "plain text" }), { now: 1000 });
    save(db, input({ title: "drop", body: "DROP TABLE users" }), { now: 2000 });
    save(db, input({ title: "keep2", body: "more text" }), { now: 3000 });

    const file = join(dir, "filtered.jsonl");
    expect(exportPortable(db, SCOPE, file, { rejectContent: (b) => b.includes("DROP") })).toBe(2);
    expect(readFileSync(file, "utf8")).not.toContain("DROP TABLE");

    const capped = join(dir, "capped.jsonl");
    expect(exportPortable(db, SCOPE, capped, { limit: 1 })).toBe(1);
    expect(readFileSync(capped, "utf8")).toContain("keep");
    db.close();
  });
});

describe("portable import", () => {
  it("is idempotent: a re-import imports nothing", () => {
    const dbA = openMemoryDb(":memory:");
    save(dbA, input({ title: "one" }), { now: 1000 });
    save(dbA, input({ title: "two" }), { now: 2000 });
    const file = join(dir, "idempotent.jsonl");
    exportPortable(dbA, SCOPE, file);

    const dbB = openMemoryDb(":memory:");
    expect(importPortable(dbB, file)).toBe(2);
    expect(importPortable(dbB, file)).toBe(0);
    expect(allLive(dbB, SCOPE)).toHaveLength(2);
    dbA.close();
    dbB.close();
  });

  it("rejects credential-like bodies", () => {
    const db = openMemoryDb(":memory:");
    const file = join(dir, "secrets.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(portableEntry({ id: "good-id", body: "safe body" })),
        JSON.stringify(
          portableEntry({ id: "bad-id", body: "key = sk-abcdefghijklmnopqrstuvwxyz" }),
        ),
        "",
      ].join("\n"),
    );
    expect(importPortable(db, file)).toBe(1);
    expect(list(db, { scope: SCOPE }).map((entry) => entry.id)).toEqual(["good-id"]);
    db.close();
  });

  it("imports a superseded entry only when its supersedes target travels in the file", () => {
    const dbA = openMemoryDb(":memory:");
    const root = save(dbA, input({ title: "root", body: "v0" }), { now: 1000 });
    const mid = saveEntry(dbA, input({ title: "mid", body: "v1", supersedes: root.id }), {
      now: 2000,
    }).entry;
    const head = saveEntry(dbA, input({ title: "head", body: "v2", supersedes: mid.id }), {
      now: 3000,
    }).entry;
    // Rows: root = tombstone without supersedes, mid = tombstone with supersedes=root,
    // head = current with supersedes=mid.
    const file = join(dir, "chain.jsonl");
    expect(exportPortable(dbA, SCOPE, file)).toBe(3);

    const dbB = openMemoryDb(":memory:");
    expect(importPortable(dbB, file)).toBe(2);
    const byId = new Map(allLive(dbB, SCOPE).map((entry) => [entry.id, entry]));
    expect(byId.get(root.id)).toBeUndefined();
    expect(byId.get(mid.id)?.status).toBe("superseded");
    expect(byId.get(mid.id)?.supersedes).toBe(root.id);
    expect(byId.get(head.id)?.status).toBe("current");
    expect(byId.get(head.id)?.supersedes).toBe(mid.id);
    dbA.close();
    dbB.close();
  });

  it("skips a tombstone whose supersedes target is absent from the file", () => {
    const db = openMemoryDb(":memory:");
    const file = join(dir, "orphan-tombstone.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(
          portableEntry({ id: "tomb-1", status: "superseded", supersedes: "no-such-id" }),
        ),
        JSON.stringify(portableEntry({ id: "current-1" })),
        "",
      ].join("\n"),
    );
    expect(importPortable(db, file)).toBe(1);
    expect(list(db, { scope: SCOPE }).map((entry) => entry.id)).toEqual(["current-1"]);
    db.close();
  });

  it("imports a current entry without its supersedes link when the target is local", () => {
    const db = openMemoryDb(":memory:");
    const local = save(db, input({ title: "local", body: "local body" }), { now: 500 });

    const file = join(dir, "external.jsonl");
    writeFileSync(file, `${JSON.stringify(portableEntry({ supersedes: local.id }))}\n`);
    expect(importPortable(db, file)).toBe(1);

    const imported = db.conn.get<{ supersedes: string | null }>(
      "SELECT supersedes FROM entries WHERE id = 'portable-1'",
    );
    expect(imported?.supersedes).toBeNull();
    // The local entry is untouched: the import never tombstones it.
    expect(
      db.conn.get<{ status: string }>("SELECT status FROM entries WHERE id = ?", [local.id])
        ?.status,
    ).toBe("current");
    db.close();
  });

  it("aborts with the line number on a structurally broken file", () => {
    const db = openMemoryDb(":memory:");
    const file = join(dir, "broken.jsonl");
    writeFileSync(file, `${JSON.stringify(portableEntry())}\nnot json\n`);
    expect(() => importPortable(db, file)).toThrow(/^line 2: not valid JSON$/);
    expect(allLive(db, SCOPE)).toHaveLength(0);
    db.close();
  });

  it("rejects invalid entry fields with the save-time rules", () => {
    const db = openMemoryDb(":memory:");
    const file = join(dir, "invalid.jsonl");
    writeFileSync(file, `${JSON.stringify(portableEntry({ body: "x".repeat(8001) }))}\n`);
    expect(() => importPortable(db, file)).toThrow(/body must be at most 8000 characters/);
    expect(allLive(db, SCOPE)).toHaveLength(0);
    db.close();
  });

  it("names the line and field for every malformed shape", () => {
    const db = openMemoryDb(":memory:");
    const file = join(dir, "malformed.jsonl");
    const line = (overrides: Record<string, unknown>): string =>
      JSON.stringify(portableEntry(overrides));

    writeFileSync(file, "not json\n");
    expect(() => importPortable(db, file)).toThrow(/^line 1: not valid JSON$/);

    writeFileSync(file, `${["42", line()].join("\n")}\n`);
    expect(() => importPortable(db, file)).toThrow(/^line 1: not an entry object$/);

    writeFileSync(file, `${line({ id: "" })}\n`);
    expect(() => importPortable(db, file)).toThrow(/^line 1: id must be a 1..200/);

    writeFileSync(file, `${line({ id: "x".repeat(201) })}\n`);
    expect(() => importPortable(db, file)).toThrow(/^line 1: id must be a 1..200/);

    writeFileSync(file, `${line({ id: "bad\nid" })}\n`);
    expect(() => importPortable(db, file)).toThrow(/^line 1: id must be a 1..200/);

    writeFileSync(file, `${line({ id: "" })}\n`);
    expect(() => importPortable(db, file)).toThrow(/^line 1: id must be a 1..200/);

    writeFileSync(file, `${line({ scope: "" })}\n`);
    expect(() => importPortable(db, file)).toThrow(/scope must be a non-empty string/);

    writeFileSync(file, `${line({ created_at: "yesterday" })}\n`);
    expect(() => importPortable(db, file)).toThrow(/created_at must be a finite number/);

    writeFileSync(file, `${line({ kind: 7 })}\n`);
    expect(() => importPortable(db, file)).toThrow(/kind must be a string/);

    writeFileSync(file, `${line({ tags: "friends" })}\n`);
    expect(() => importPortable(db, file)).toThrow(/tags must be an array of strings/);

    writeFileSync(file, `${line({ paths: ["/etc/passwd"] })}\n`);
    expect(() => importPortable(db, file)).toThrow(/paths must be relative project paths/);
    expect(allLive(db, SCOPE)).toHaveLength(0);
    db.close();
  });

  it("applies rejectContent and stops at max", () => {
    const dbA = openMemoryDb(":memory:");
    save(dbA, input({ title: "one", body: "alpha" }), { now: 1000 });
    save(dbA, input({ title: "two", body: "beta" }), { now: 2000 });
    save(dbA, input({ title: "three", body: "gamma" }), { now: 3000 });
    const file = join(dir, "caps.jsonl");
    exportPortable(dbA, SCOPE, file);

    const dbB = openMemoryDb(":memory:");
    expect(importPortable(dbB, file, { rejectContent: (b) => b.includes("beta") })).toBe(2);
    expect(list(dbB, { scope: SCOPE }).map((entry) => entry.title)).toEqual(["three", "one"]);

    const dbC = openMemoryDb(":memory:");
    expect(importPortable(dbC, file, { max: 0 })).toBe(0);
    expect(importPortable(dbC, file, { max: 1 })).toBe(1);
    expect(allLive(dbC, SCOPE)).toHaveLength(1);
    dbA.close();
    dbB.close();
    dbC.close();
  });
});

describe("portable paths and ops", () => {
  it("derives the default path from an absolute scope and refuses otherwise", () => {
    expect(portableDirectory("/work/project-a")).toBe("/work/project-a");
    expect(portableDirectory("my-project")).toBeUndefined();
    expect(portableDirectory("/")).toBeUndefined();
    expect(portableDefaultPath("/work/project-a")).toBe(
      "/work/project-a/.opencode/memory/memory-export.jsonl",
    );
  });

  it("exports and imports through the shared ops with the default path", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const root = join(dir, "proj");
    save(db, input({ scope: root, title: "seeded", body: "body" }), { now: 1000 });

    const expected = portableDefaultPath(root);
    expect(ops.exportEntries({ scope: root }, root)).toBe(`exported 1 entries to ${expected}`);
    expect(existsSync(expected)).toBe(true);

    // A fresh store, same project: the default path is shared, the import is idempotent.
    const dbB = openMemoryDb(":memory:");
    const opsB = createMemoryOps(() => dbB);
    expect(opsB.importEntries({}, root)).toBe(`imported 1 entries from ${expected}`);
    expect(opsB.importEntries({}, root)).toBe(`imported 0 entries from ${expected}`);
    db.close();
    dbB.close();
  });

  it("refuses to derive a default path from a non-path scope", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    expect(ops.exportEntries({ scope: "my-project" }, "my-project")).toMatch(
      /pass an explicit path/,
    );
    expect(ops.importEntries({}, "/")).toMatch(/pass an explicit path/);
    db.close();
  });

  it("honors an explicit path over the default", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const file = join(dir, "explicit.jsonl");
    expect(ops.exportEntries({ scope: "my-project", path: file }, "my-project")).toBe(
      `exported 0 entries to ${file}`,
    );
    expect(existsSync(file)).toBe(true);
    db.close();
  });
});
