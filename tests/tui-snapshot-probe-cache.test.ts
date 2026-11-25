import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts every git subprocess git.ts would spawn while delegating to the real
// implementations: the freshness cache is measured, not assumed.
const probes = vi.hoisted(() => ({ git: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const countGit = <T>(fn: T): T =>
    ((...args: unknown[]) => {
      if (args[0] === "git") probes.git += 1;
      return (fn as (...a: unknown[]) => unknown)(...args);
    }) as unknown as T;
  return {
    ...actual,
    execFileSync: countGit(actual.execFileSync),
    spawnSync: countGit(actual.spawnSync),
  };
});

import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";
import { buildSidebarSnapshot, freshCache } from "../src/lib/tui-snapshot.js";

const NOW = 1_800_000_000_000;

describe("tui-snapshot freshness cache", () => {
  let repo: string;
  let db: MemoryDb;

  function git(args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  function insertAnchored(
    title: string,
    paths: string[],
    sha: string,
    hashes?: Record<string, string>,
  ): void {
    db.conn.run(
      `INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at,
         source, deleted_at, paths, commit_sha, supersedes, status, superseded_at, heat, endorsed_by, content_hashes)
       VALUES (?, '/w', 'fact', ?, 'body', '[]', ?, ?, NULL, NULL, ?, ?, NULL, 'current', NULL, 0, NULL, ?)`,
      [title, title, NOW, NOW, JSON.stringify(paths), sha, hashes ? JSON.stringify(hashes) : null],
    );
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tui-probe-cache-"));
    git(["init", "-q"]);
    mkdirSync(dirname(join(repo, "src/a.ts")), { recursive: true });
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(repo, `src/${name}.ts`), `export const ${name} = 1;\n`);
    }
    git(["add", "."]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    db = openMemoryDb(":memory:");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("probes git once for 10 identical snapshots", () => {
    const sha = git(["rev-parse", "HEAD"]).trim();
    insertAnchored("e1", ["src/a.ts"], sha);
    insertAnchored("e2", ["src/b.ts"], sha);
    insertAnchored("e3", ["src/c.ts"], sha);
    const options = { scope: "/w", now: NOW, directory: repo };

    probes.git = 0;
    buildSidebarSnapshot(db, options);
    const afterOne = probes.git;

    probes.git = 0;
    for (let i = 0; i < 10; i++) {
      buildSidebarSnapshot(db, options);
    }
    // Before the cache this burst cost 60 subprocesses (3 entries x 2 git calls
    // x 10 snapshots); the cache pays the first snapshot only: 11 identical
    // snapshots cost 7 git subprocesses — 6 probes plus the one memoized
    // rev-parse that resolves the legacy rows' anchor root — 9 fewer than one
    // snapshot used to.
    expect(afterOne).toBe(7);
    expect(probes.git).toBe(0);
  });

  it("re-probes when the working tree moves or the stamp changes", () => {
    const sha = git(["rev-parse", "HEAD"]).trim();
    insertAnchored("moved", ["src/a.ts"], sha);
    const options = { scope: "/w", now: NOW, directory: repo };

    probes.git = 0;
    expect(buildSidebarSnapshot(db, options).stale).toBe(0);

    // An edit moves mtime: cache miss, honest re-probe, verdict flips.
    writeFileSync(join(repo, "src/a.ts"), "export const changed = true;\n");
    probes.git = 0;
    expect(buildSidebarSnapshot(db, options).stale).toBe(1);
    expect(probes.git).toBe(2);

    // Identical snapshots after the edit hit the cache again.
    probes.git = 0;
    for (let i = 0; i < 5; i++) {
      expect(buildSidebarSnapshot(db, options).stale).toBe(1);
    }
    expect(probes.git).toBe(0);

    // A new (commit, paths) stamp is a fresh key: probed once. The new file is
    // edited past the anchored commit, so it probes and goes stale.
    writeFileSync(join(repo, "src/b.ts"), "export const b = 2;\n");
    insertAnchored("second stamp", ["src/b.ts"], sha);
    probes.git = 0;
    expect(buildSidebarSnapshot(db, options).stale).toBe(2);
    expect(probes.git).toBe(2);
  });

  it("keeps verdicts stable across repeated snapshots", () => {
    const sha = git(["rev-parse", "HEAD"]).trim();
    insertAnchored("fresh", ["src/a.ts"], sha);
    insertAnchored("gone", ["src/deleted.ts"], sha); // missing path: stale
    const options = { scope: "/w", now: NOW, directory: repo };

    for (let i = 0; i < 10; i++) {
      const snap = buildSidebarSnapshot(db, options);
      expect(snap.stale).toBe(1); // fresh stays fresh, gone stays stale
    }
  });

  it("caches content-anchored verdicts: one git call, no re-hash on hit", () => {
    const hashOf = (name: string): string => git(["hash-object", `src/${name}.ts`]).trim();
    insertAnchored("content e1", ["src/a.ts"], git(["rev-parse", "HEAD"]).trim(), {
      "src/a.ts": hashOf("a"),
    });
    const options = { scope: "/w", now: NOW, directory: repo };

    probes.git = 0;
    expect(buildSidebarSnapshot(db, options).stale).toBe(0);
    // Content mode costs one hash-object, not diff + ls-files, plus the one
    // memoized rev-parse that resolves these legacy rows' anchor root.
    expect(probes.git).toBe(2);

    probes.git = 0;
    const cached = freshCache.size();
    for (let i = 0; i < 5; i++) {
      expect(buildSidebarSnapshot(db, options).stale).toBe(0);
    }
    expect(probes.git).toBe(0);
    expect(freshCache.size()).toBe(cached);
  });

  it("re-probes when content changes and when the anchor stamp moves", () => {
    const sha = git(["rev-parse", "HEAD"]).trim();
    const hashA = git(["hash-object", "src/a.ts"]).trim();
    insertAnchored("hash e1", ["src/a.ts"], sha, { "src/a.ts": hashA });
    const options = { scope: "/w", now: NOW, directory: repo };
    expect(buildSidebarSnapshot(db, options).stale).toBe(0);

    // An edit moves mtime: honest re-probe against the saved blob.
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    expect(buildSidebarSnapshot(db, options).stale).toBe(1);

    // Reverted to the saved content: fresh again.
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    expect(buildSidebarSnapshot(db, options).stale).toBe(0);

    // A different content stamp is a different key even with the same
    // (commit, paths): re-probed once.
    insertAnchored("hash e2", ["src/a.ts"], sha, { "src/a.ts": sha });
    probes.git = 0;
    const stamped = freshCache.size();
    expect(buildSidebarSnapshot(db, options).stale).toBe(1); // sha is not a blob hash of a.ts
    expect(probes.git).toBe(1);
    expect(freshCache.size()).toBe(stamped + 1); // two entries, one edit, one revert
  });

  it("evicts the oldest verdicts past the 10_000 bound", () => {
    // Malformed shas fail the regex before any git call: 10_001 distinct keys
    // fill the cache cheaply, one statSync per missing path, and zero
    // per-entry subprocesses (the single rev-parse resolves the probe root
    // once, memoized).
    probes.git = 0;
    for (let i = 0; i < 10_001; i++) {
      freshCache.probe({ commit_sha: "not-a-sha", paths: [`missing-${i}.ts`] }, repo);
    }
    expect(probes.git).toBe(1);
    expect(freshCache.size()).toBe(10_000);

    freshCache.probe({ commit_sha: "not-a-sha", paths: ["one-more.ts"] }, repo);
    expect(freshCache.size()).toBe(10_000);
  });
});
