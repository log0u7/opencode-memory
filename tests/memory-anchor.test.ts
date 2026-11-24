import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentCommitHash, isEntryFresh } from "../src/lib/git.js";
import { createMemoryOps, memoryInventory } from "../src/lib/memory-ops.js";
import { openMemoryDb } from "../src/lib/db.js";
import { getById, saveEntry } from "../src/lib/store.js";
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

describe("ops.save auto commit anchoring", () => {
  it("captures HEAD when paths are anchored and no commit is given", () => {
    const ops = createMemoryOps(() => db);
    const sha = git(["rev-parse", "HEAD"]).trim();

    const text = ops.save(
      { kind: "lesson", title: "auto anchor", body: "b", paths: ["README.md"] },
      repo,
      undefined,
      { directory: repo },
    );
    const id = text.split(" ")[1] ?? "";

    expect(getById(db, id)?.entry.commit_sha).toBe(sha);
  });

  it("leaves the entry unchanged outside a repository", () => {
    const ops = createMemoryOps(() => db);
    const outside = mkdtempSync(join(tmpdir(), "memory-norepo-"));
    try {
      const text = ops.save(
        { kind: "lesson", title: "no repo", body: "b", paths: ["README.md"] },
        outside,
        undefined,
        { directory: outside },
      );
      const id = text.split(" ")[1] ?? "";

      expect(getById(db, id)?.entry.commit_sha).toBeUndefined();
      // hash-object alone would succeed outside a repository; the content
      // stamp is tied to the commit capture (a repository), so the entry
      // keeps its previous shape there too.
      expect(getById(db, id)?.entry.content_hashes).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not capture a commit when no paths are anchored", () => {
    const ops = createMemoryOps(() => db);

    const text = ops.save({ kind: "fact", title: "no paths", body: "b" }, repo, undefined, {
      directory: repo,
    });
    const id = text.split(" ")[1] ?? "";

    expect(getById(db, id)?.entry.commit_sha).toBeUndefined();
  });
});

describe("content anchoring", () => {
  function saveAnchored(title: string, paths: string[]): Entry {
    const ops = createMemoryOps(() => db);
    const text = ops.save({ kind: "lesson", title, body: "b", paths }, repo, undefined, {
      directory: repo,
    });
    const entry = getById(db, text.split(" ")[1] ?? "")?.entry;
    if (entry === undefined) throw new Error("save failed");
    return entry;
  }

  it("anchors a dirty-tree save by content and reads it fresh immediately", () => {
    // The 0.21.3 bug: modified before commit, the entry was stale at creation.
    writeFileSync(join(repo, "README.md"), "dirty state");
    const entry = saveAnchored("dirty save", ["README.md"]);

    expect(entry.commit_sha).toMatch(/^[0-9a-f]{7,64}$/);
    expect(entry.content_hashes?.["README.md"]).toMatch(/^[0-9a-f]{40}$/);
    expect(isEntryFresh(entry, repo)).toBe(true);
  });

  it("anchors an untracked file at save and reads it fresh", () => {
    writeFileSync(join(repo, "untracked.ts"), "new content");
    const entry = saveAnchored("untracked", ["untracked.ts"]);

    expect(entry.content_hashes?.["untracked.ts"]).toMatch(/^[0-9a-f]{40}$/);
    expect(isEntryFresh(entry, repo)).toBe(true);
  });

  it("goes stale when the anchored file changes after the save", () => {
    writeFileSync(join(repo, "README.md"), "saved state");
    const entry = saveAnchored("then edited", ["README.md"]);
    expect(isEntryFresh(entry, repo)).toBe(true);

    writeFileSync(join(repo, "README.md"), "changed after");
    expect(isEntryFresh(entry, repo)).toBe(false);
  });

  it("reads fresh again when the file is reverted to the saved content", () => {
    writeFileSync(join(repo, "README.md"), "saved state");
    const entry = saveAnchored("reverted", ["README.md"]);

    writeFileSync(join(repo, "README.md"), "moved away");
    expect(isEntryFresh(entry, repo)).toBe(false);

    writeFileSync(join(repo, "README.md"), "saved state");
    expect(isEntryFresh(entry, repo)).toBe(true);
  });

  it("goes stale when the anchored file is deleted", () => {
    writeFileSync(join(repo, "gone.ts"), "x");
    const entry = saveAnchored("deleted file", ["gone.ts"]);
    expect(isEntryFresh(entry, repo)).toBe(true);

    rmSync(join(repo, "gone.ts"));
    expect(isEntryFresh(entry, repo)).toBe(false);
  });

  it("falls back to the commit anchor when a path does not exist at save", () => {
    const entry = saveAnchored("ghost path", ["missing.ts"]);

    expect(entry.content_hashes).toBeUndefined();
    expect(entry.commit_sha).toMatch(/^[0-9a-f]{7,64}$/);
    expect(isEntryFresh(entry, repo)).toBe(false);
  });

  it("keeps the commit check for entries anchored by commit only", () => {
    // Backward compat: no content_hashes, the 0.11.0 commit-vs-worktree check rules.
    const commit = commitFile("src/a.ts", "v1");
    const entry = anchoredEntry(commit, ["src/a.ts"]);

    writeFileSync(join(repo, "src/a.ts"), "v2");
    expect(isEntryFresh(entry, repo)).toBe(false);

    writeFileSync(join(repo, "src/a.ts"), "v1");
    expect(isEntryFresh(entry, repo)).toBe(true);
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
