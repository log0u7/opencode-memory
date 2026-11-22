import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentCommitHash, isEntryFresh } from "../src/lib/git.js";
import { memoryInventory } from "../src/lib/memory-ops.js";
import { openMemoryDb } from "../src/lib/db.js";
import { saveEntry } from "../src/lib/store.js";
import type { Entry } from "../src/types/entry.js";

let repo: string;
let dbPath: string;
let db: ReturnType<typeof openMemoryDb>;

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
  repo = mkdtempSync(join(tmpdir(), "memory-anchor-"));
  git(["init", "-q"]);
  commitFile("README.md", "init");
  dbPath = join(repo, "memory.db");
  db = openMemoryDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
  dbPath = "";
});

function anchoredEntry(commit: string, paths: string[]): Entry {
  return saveEntry(db, {
    scope: repo,
    kind: "decision",
    title: "anchored",
    body: "b",
    tags: [],
    expires_at: null,
    paths,
    commit_sha: commit,
  }).entry;
}

describe("currentCommitHash", () => {
  it("returns HEAD inside a repository", () => {
    expect(currentCommitHash(repo)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns undefined outside a repository", () => {
    expect(currentCommitHash("/tmp")).toBeUndefined();
  });
});

describe("isEntryFresh", () => {
  it("treats unanchored entries as always fresh", async () => {
    const entry = {
      id: "x",
      scope: repo,
      kind: "fact",
      title: "t",
      body: "b",
      tags: [],
      created_at: 0,
      updated_at: 0,
      expires_at: null,
    };
    expect(isEntryFresh(entry, repo)).toBe(true);
    expect(isEntryFresh({ ...entry, commit_sha: "abc123" }, repo)).toBe(true);
    expect(isEntryFresh({ ...entry, paths: ["a.ts"] }, repo)).toBe(true);
  });

  it("goes stale when an anchored path changes after the commit", async () => {
    const commit = commitFile("src/a.ts", "v1");
    const entry = anchoredEntry(commit, ["src/a.ts"]);
    expect(isEntryFresh(entry, repo)).toBe(true);

    writeFileSync(join(repo, "src/a.ts"), "v2");
    expect(isEntryFresh(entry, repo)).toBe(false);
  });

  it("goes stale when an anchored path is untracked", async () => {
    const commit = commitFile("src/b.ts", "v1");
    const entry = anchoredEntry(commit, ["src/b.ts", "src/new.ts"]);
    expect(isEntryFresh(entry, repo)).toBe(false);
  });

  it("stays fresh when an unrelated path changes", async () => {
    const commit = commitFile("src/keep.ts", "v1");
    const entry = anchoredEntry(commit, ["src/keep.ts"]);
    commitFile("src/other.ts", "unrelated");
    expect(isEntryFresh(entry, repo)).toBe(true);
  });
});

describe("entry validation", () => {
  it("rejects absolute paths, traversal and too many paths", () => {
    expect(() =>
      saveEntry(db, {
        scope: "s",
        kind: "fact",
        title: "t",
        body: "b",
        tags: [],
        expires_at: null,
        paths: ["/etc/passwd"],
      }),
    ).toThrow(/relative/);
    expect(() =>
      saveEntry(db, {
        scope: "s",
        kind: "fact",
        title: "t",
        body: "b",
        tags: [],
        expires_at: null,
        paths: ["../esc"],
      }),
    ).toThrow(/relative/);
    expect(() =>
      saveEntry(db, {
        scope: "s",
        kind: "fact",
        title: "t",
        body: "b",
        tags: [],
        expires_at: null,
        paths: Array.from({ length: 21 }, (_, i) => `f${i}`),
      }),
    ).toThrow(/20 paths/);
  });

  it("rejects a malformed commit sha", () => {
    expect(() =>
      saveEntry(db, {
        scope: "s",
        kind: "fact",
        title: "t",
        body: "b",
        tags: [],
        expires_at: null,
        commit_sha: "not-a-sha!",
      }),
    ).toThrow(/git sha/);
  });

  it("round-trips paths and commit_sha", () => {
    const entry = saveEntry(db, {
      scope: "s",
      kind: "fact",
      title: "t",
      body: "b",
      tags: [],
      expires_at: null,
      paths: ["src/a.ts"],
      commit_sha: "abc1234",
    }).entry;
    expect(entry.paths).toEqual(["src/a.ts"]);
    expect(entry.commit_sha).toBe("abc1234");
  });
});

describe("inventory freshness filter", () => {
  it("hides stale anchored entries and keeps fresh ones", async () => {
    const commit = commitFile("src/a.ts", "v1");
    anchoredEntry(commit, ["src/a.ts"]);
    saveEntry(db, {
      scope: repo,
      kind: "lesson",
      title: "still true",
      body: "b",
      tags: [],
      expires_at: null,
      paths: ["README.md"],
      commit_sha: commit,
    });

    // src/a.ts changed: the anchored decision is stale, the lesson is fresh.
    writeFileSync(join(repo, "src/a.ts"), "v2");

    const withDirectory = memoryInventory(() => db, dbPath, repo, { directory: repo });
    expect(withDirectory).toContain("still true");
    expect(withDirectory).not.toContain("anchored");
    expect(withDirectory).not.toContain("anchored");

    // Without a directory, no staleness filtering (previous behavior).
    const withoutDirectory = memoryInventory(() => db, dbPath, repo);
    expect(withoutDirectory).toContain("anchored");
    expect(withoutDirectory).toContain("still true");
  });

  it("returns null when every entry is stale", async () => {
    const commit = commitFile("src/c.ts", "v1");
    anchoredEntry(commit, ["src/c.ts"]);
    writeFileSync(join(repo, "src/c.ts"), "v2");
    expect(memoryInventory(() => db, dbPath, repo, { directory: repo })).toBeNull();
  });
});
