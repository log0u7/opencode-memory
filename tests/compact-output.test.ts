import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";
import { createMemoryOps } from "../src/lib/memory-ops.js";
import { DEFAULT_LIMIT, save } from "../src/lib/store.js";
import type { EntryInput } from "../src/types/entry.js";

const SCOPE = "/work/project";

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    scope: SCOPE,
    kind: "fact",
    title: "entry",
    body: "some body",
    tags: [],
    expires_at: null,
    ...overrides,
  };
}

describe("compact line output", () => {
  let db: MemoryDb;

  beforeEach(() => {
    db = openMemoryDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("renders search hits as one line each under a scope header", () => {
    const entry = save(db, input({ title: "deploy checks", body: "three checks before merge" }));

    const out = ops().search({ query: "deploy" }, SCOPE);
    const [header, line] = out.split("\n");

    expect(header).toBe(`scope ${SCOPE} · 1 hits`);
    expect(line).toBe(`${entry.id.slice(0, 8)} fact deploy checks — three checks before merge`);
  });

  it("flattens newlines in the title and the body preview", () => {
    save(db, input({ title: "multi\nline title", body: "one\ntwo\nthree" }));

    const line = ops().search({ query: "multi" }, SCOPE).split("\n")[1] ?? "";

    expect(line).toMatch(/ fact multi line title — one two three$/);
  });

  it("adds metadata suffixes only when they say something, in order", () => {
    const ops = createMemoryOps(() => db);
    // A lesson re-recorded once reaches HOT_THRESHOLD: the hot suffix appears.
    ops.save({ kind: "lesson", title: "hot lesson", body: "b" }, SCOPE);
    ops.save({ kind: "lesson", title: "hot lesson", body: "b" }, SCOPE);
    const hotLine = ops.search({ query: "hot lesson" }, SCOPE).split("\n")[1] ?? "";
    expect(hotLine).toMatch(/ lesson hot lesson — b · hot$/);

    // One entry that is hot AND anchored AND truncated pins the suffix order.
    ops.save({ kind: "lesson", title: "heavy hot", body: "b" }, SCOPE);
    ops.save(
      { kind: "lesson", title: "heavy hot", body: "z".repeat(3000), paths: ["src/a.ts"] },
      SCOPE,
    );
    const heavyLine = ops.search({ query: "heavy hot" }, SCOPE).split("\n")[1] ?? "";
    expect(heavyLine).toMatch(/ lesson heavy hot — z{500}… · hot · src\/a\.ts · truncated:3000$/);
  });

  it("marks a hit stale only when the caller passes the checkout directory", () => {
    const entry = save(db, input({ title: "anchored note", paths: ["src/a.ts"] }));

    // No directory: no freshness check, no stale suffix.
    expect(ops().search({ query: "anchored" }, SCOPE)).not.toContain(" · stale");
    // Anchored but no commit_sha: nothing observable contradicts the entry.
    const withDir = ops().search({ query: "anchored" }, SCOPE, { directory: "/tmp" });
    expect(withDir).toContain(` · ${entry.paths?.[0]}`);
    expect(withDir).not.toContain(" · stale");
  });

  it("defaults search to 5 hits and list to 10 entries", () => {
    const ops = createMemoryOps(() => db);
    for (let i = 0; i < 8; i++) {
      ops.save({ kind: "fact", title: `postgres note ${i}`, body: "x" }, SCOPE);
    }

    expect(DEFAULT_LIMIT).toEqual({ search: 5, list: 10 });
    // Header plus five hits.
    expect(ops.search({ query: "postgres" }, SCOPE).split("\n")).toHaveLength(6);
  });

  it("lists under a scope header and pages beyond the first page", () => {
    const ops = createMemoryOps(() => db);
    for (let i = 0; i < 12; i++) {
      ops.save({ kind: "fact", title: `list note ${i}`, body: "x" }, SCOPE);
    }

    const page1 = ops.list({}, SCOPE);
    expect(page1).toMatch(/^scope \/work\/project · 10 entries\n/);
    expect(page1.split("\n")).toHaveLength(11);

    const page2 = ops.list({ page: 2 }, SCOPE);
    expect(page2).toMatch(/ · 2 entries \(page 2\)\n/);
    const ids1 = page1
      .split("\n")
      .slice(1)
      .map((line) => line.slice(0, 8));
    const ids2 = page2
      .split("\n")
      .slice(1)
      .map((line) => line.slice(0, 8));
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("resolves an 8-char id prefix in get, forget, restore and endorse", () => {
    const entry = save(db, input({ title: "target note" }));
    const id8 = entry.id.slice(0, 8);
    const ops = createMemoryOps(() => db);

    expect(ops.get({ id: id8 })).toContain(`id ${entry.id}`);
    expect(ops.forget({ id: id8 }, SCOPE)).toContain(`(${entry.id})`);
    expect(ops.restore({ id: id8 })).toBe(`restored "target note" (${entry.id})`);
    expect(ops.endorse({ id: id8, endorser: "peer" })).toContain("(shareable)");
  });

  it("still resolves full ids everywhere", () => {
    const entry = save(db, input({ title: "full id note" }));

    expect(ops().get({ id: entry.id })).toContain(`id ${entry.id}`);
  });

  it("reports the full candidate ids when a prefix is ambiguous", () => {
    db.conn.run(
      "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["aaaabbbb-1111", SCOPE, "fact", "one", "b", "[]", 1, 1, null],
    );
    db.conn.run(
      "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["aaaabbbb-2222", SCOPE, "fact", "two", "b", "[]", 1, 1, null],
    );

    expect(ops().get({ id: "aaaabbbb" })).toBe(
      "error: ambiguous id prefix aaaabbbb: aaaabbbb-1111, aaaabbbb-2222",
    );
  });

  it("answers an unknown prefix like an unknown id", () => {
    expect(ops().get({ id: "ffffffff" })).toBe("no entry with that id");
    expect(ops().restore({ id: "ffffffff" })).toBe("no entry with that id");
  });

  it("renders memory_get as the integral body plus a compact meta block", () => {
    const ops = createMemoryOps(() => db);
    const first = ops.save({ kind: "fact", title: "old way", body: "b" }, SCOPE);
    const firstId = first.split(" ")[1] ?? "";
    const body = "line one\nline two\nline three";
    save(db, input({ title: "new way", body, kind: "lesson", supersedes: firstId }));

    const entryId = getOnlyEntryId(db);
    const full = ops.get({ id: entryId.slice(0, 8) });

    expect(full.startsWith(body)).toBe(true);
    const meta = full.slice(full.indexOf("\n—\n") + 3);
    expect(meta).toBe(`id ${entryId} · lesson · just now · heat 1\nsupersedes ${firstId}`);
  });

  it("names anchored paths in the get meta block", () => {
    save(db, input({ title: "anchored get", paths: ["src/a.ts", "src/b.ts"] }));

    const full = ops().get({ id: getOnlyEntryId(db).slice(0, 8) });

    expect(full).toContain("\npaths: src/a.ts, src/b.ts");
  });

  it("accepts an 8-char prefix for supersedes at save time", () => {
    const ops = createMemoryOps(() => db);
    const first = ops.save({ kind: "fact", title: "superseded note", body: "b" }, SCOPE);
    const firstId = first.split(" ")[1] ?? "";

    const second = ops.save(
      { kind: "fact", title: "replacement note", body: "b", supersedes: firstId.slice(0, 8) },
      SCOPE,
    );

    expect(second).toContain(`replaced ${firstId}`);
  });

  /** One-entry helper: the id of the only live row in the store. */
  function getOnlyEntryId(store: MemoryDb): string {
    const row = store.conn.get<{ id: string }>(
      "SELECT id FROM entries WHERE deleted_at IS NULL AND status = 'current'",
    );
    return row?.id ?? "";
  }

  function ops() {
    return createMemoryOps(() => db);
  }
});

describe("stale suffix against a real checkout", () => {
  let repo: string;
  let db: MemoryDb;

  function git(args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  function commitFile(name: string, content: string): string {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
    git(["add", name]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", name]);
    return git(["rev-parse", "HEAD"]).trim();
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "compact-stale-"));
    git(["init", "-q"]);
    commitFile("README.md", "init");
    db = openMemoryDb(join(repo, "memory.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("marks an anchored hit stale when its file changed since the anchored commit", () => {
    const ops = createMemoryOps(() => db);
    // The stale note anchors at HEAD before the change; the fresh note anchors
    // at HEAD after it, so one search shows both verdicts.
    commitFile("src/a.ts", "one");
    const stale = ops.save(
      { kind: "fact", title: "stale note", body: "b", paths: ["src/a.ts"] },
      repo,
      undefined,
      { directory: repo },
    );
    writeFileSync(join(repo, "src/a.ts"), "two");
    git(["add", "src/a.ts"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "two"]);
    const fresh = ops.save(
      { kind: "fact", title: "fresh note", body: "b", paths: ["src/a.ts"] },
      repo,
      undefined,
      { directory: repo },
    );
    const staleId = stale.split(" ")[1] ?? "";
    const freshId = fresh.split(" ")[1] ?? "";

    const out = ops.search({ query: "note" }, repo, { directory: repo });
    const staleLine = out.split("\n").find((line) => line.includes(staleId.slice(0, 8))) ?? "";
    const freshLine = out.split("\n").find((line) => line.includes(freshId.slice(0, 8))) ?? "";

    expect(staleLine).toContain(" · stale · src/a.ts");
    expect(freshLine).not.toContain(" · stale");
  });
});
