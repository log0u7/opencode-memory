import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every git invocation goes through this recorder, so the tests count real
// subprocesses instead of trusting an internal call graph. One shared,
// append-only log keeps the markers stable across execFileSync and spawnSync.
const gitLog = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record = (file: string, args: string[]) => {
    if (file === "git") gitLog.calls.push(args);
  };
  return {
    ...actual,
    execFileSync: vi.fn(((file: string, args: string[], options?: object) => {
      record(file, args);
      return actual.execFileSync(file, args as never, options as never);
    }) as unknown as typeof actual.execFileSync),
    spawnSync: vi.fn(((file: string, args: string[], options?: object) => {
      record(file, args);
      return actual.spawnSync(file, args as never, options as never);
    }) as unknown as typeof actual.spawnSync),
  };
});

import { isEntryFresh } from "../src/lib/git.js";
import { openMemoryDb } from "../src/lib/db.js";
import { INVENTORY_MAX_CHARS, createMemoryOps, memoryInventory } from "../src/lib/memory-ops.js";
import { getById } from "../src/lib/store.js";

function gitInvocations(): string[][] {
  return gitLog.calls;
}

let repo: string;
let dbPath: string;
let db: ReturnType<typeof openMemoryDb>;

function git(args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function commitAll(message: string): string {
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

function file(name: string, content: string): void {
  mkdirSync(dirname(join(repo, name)), { recursive: true });
  writeFileSync(join(repo, name), content);
}

function save(args: Parameters<ReturnType<typeof createMemoryOps>["save"]>[0]): string {
  const ops = createMemoryOps(() => db);
  return ops.save(args, repo, undefined, { directory: repo });
}

function commitDirAll(dir: string, message: string): string {
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", message],
    { encoding: "utf8" },
  );
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "memory-perf-"));
  git(["init", "-q"]);
  file(".gitignore", "memory.db\n");
  file("README.md", "init");
  commitAll("init");
  dbPath = join(repo, "memory.db");
  db = openMemoryDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
  gitLog.calls.length = 0;
});

describe("inventory freshness cost", () => {
  it("stops probing freshness once the character budget is filled", () => {
    const ops = createMemoryOps(() => db);
    // Ten short lesson lines plus forty long fact lines, each anchored to its
    // own file: the budget fills long before the tail, which must never be
    // probed (one git subprocess per anchored entry would be the old cost).
    for (let i = 0; i < 10; i++) {
      file(`l${i}.txt`, "x");
      ops.save(
        {
          kind: "lesson",
          title: `lesson ${i} ${"t".repeat(40)}`,
          body: "b",
          paths: [`l${i}.txt`],
        },
        repo,
        undefined,
        { directory: repo },
      );
    }
    for (let i = 0; i < 40; i++) {
      file(`f${i}.txt`, "x");
      ops.save(
        {
          kind: "fact",
          title: `fact ${i}`,
          body: `${"a".repeat(250)}. ${"b".repeat(100)}`,
          paths: [`f${i}.txt`],
        },
        repo,
        undefined,
        { directory: repo },
      );
    }
    const marker = gitInvocations().length;

    const inventory = memoryInventory(() => db, dbPath, repo, { directory: repo }) as string;

    const during = gitInvocations().slice(marker);
    // One batched hash-object for the whole probed lot; content-stamped
    // entries need no diff/ls-files, and cut entries are probed never.
    expect(during).toHaveLength(1);
    expect(during[0]).toContain("hash-object");
    expect(inventory.length).toBeLessThanOrEqual(INVENTORY_MAX_CHARS);
    // The newest facts ride at the top of the recency order; the oldest tail
    // is what the budget cuts.
    expect(inventory).toContain("fact 39");
    expect(inventory).not.toContain("fact 0");
  });

  it("batches all anchored paths of a lot into one hash-object call", () => {
    const ops = createMemoryOps(() => db);
    for (let i = 0; i < 5; i++) {
      file(`p${i}.txt`, `content ${i}`);
      ops.save(
        { kind: "fact", title: `e${i}`, body: "short", paths: [`p${i}.txt`] },
        repo,
        undefined,
        { directory: repo },
      );
    }
    const marker = gitInvocations().length;

    memoryInventory(() => db, dbPath, repo, { directory: repo });

    const hashObject = gitInvocations()
      .slice(marker)
      .filter((args) => args.includes("hash-object"));
    expect(hashObject).toHaveLength(1);
    const probed = hashObject[0] ?? [];
    for (let i = 0; i < 5; i++) {
      expect(probed).toContain(`p${i}.txt`);
    }
  });

  it("keeps one deleted anchored path from poisoning the whole batch", () => {
    const ops = createMemoryOps(() => db);
    file("alive.txt", "a");
    file("doomed.txt", "d");
    commitAll("two files");
    ops.save({ kind: "fact", title: "alive", body: "b", paths: ["alive.txt"] }, repo, undefined, {
      directory: repo,
    });
    ops.save({ kind: "fact", title: "doomed", body: "b", paths: ["doomed.txt"] }, repo, undefined, {
      directory: repo,
    });
    rmSync(join(repo, "doomed.txt"));
    const marker = gitInvocations().length;

    const inventory = memoryInventory(() => db, dbPath, repo, { directory: repo }) as string;

    const hashObject = gitInvocations()
      .slice(marker)
      .filter((args) => args.includes("hash-object"));
    expect(hashObject).toHaveLength(1);
    expect(hashObject[0]).not.toContain("doomed.txt");
    expect(inventory).toContain("alive");
    expect(inventory).not.toContain("doomed");
  });
});

describe("inventory line hygiene", () => {
  it("points truncated facts at memory_search in English", () => {
    save({ kind: "fact", title: "long", body: `${"a".repeat(250)}. ${"b".repeat(100)}` });
    const inventory = memoryInventory(() => db, dbPath, repo, { directory: repo }) as string;
    expect(inventory).toContain("… (memory_search)");
    expect(inventory).not.toContain("body complet");
  });

  it("drops the author stamp from inventory lines", () => {
    const ops = createMemoryOps(() => db);
    ops.save({ kind: "fact", title: "authored", body: "b" }, repo, "build", { directory: repo });
    const inventory = memoryInventory(() => db, dbPath, repo, { directory: repo }) as string;
    expect(inventory).toContain("(updated ");
    expect(inventory).not.toContain(", by build");
    expect(inventory).not.toContain(" by build");
  });
});

describe("anchored paths resolve from the git root", () => {
  it("keeps a subdir save fresh when checked from the root", () => {
    const sub = join(repo, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "mod.ts"), "export {}");
    const sha = commitDirAll(repo, "pkg");
    const ops = createMemoryOps(() => db);
    const text = ops.save(
      { kind: "fact", title: "pkg fact", body: "b", paths: ["mod.ts"] },
      repo,
      undefined,
      { directory: sub },
    );
    const id = text.split(" ")[1] ?? "";
    const entry = getById(db, id)?.entry;

    expect(entry?.paths).toEqual(["pkg/mod.ts"]);
    expect(entry?.repo_root).toBe(repo);
    expect(entry?.commit_sha).toBe(sha);
    expect(Object.keys(entry?.content_hashes ?? {})).toEqual(["pkg/mod.ts"]);
    expect(isEntryFresh(entry ?? {}, repo)).toBe(true);
    expect(isEntryFresh(entry ?? {}, sub)).toBe(true);

    const inventory = memoryInventory(() => db, dbPath, repo, { directory: repo }) as string;
    expect(inventory).toContain("pkg fact");
  });

  it("keeps a global anchored entry fresh when viewed from another project", () => {
    file("anchor.txt", "stable content");
    commitAll("anchor");
    const ops = createMemoryOps(() => db);
    const text = ops.save(
      { kind: "fact", title: "global anchor", body: "b", paths: ["anchor.txt"] },
      "global",
      undefined,
      { directory: repo },
    );
    const id = text.split(" ")[1] ?? "";
    const entry = getById(db, id)?.entry;

    const other = mkdtempSync(join(tmpdir(), "memory-other-"));
    try {
      execFileSync("git", ["-C", other, "init", "-q"], { encoding: "utf8" });
      writeFileSync(join(other, "unrelated.txt"), "z");
      expect(isEntryFresh(entry ?? {}, other)).toBe(true);
      const inventory = memoryInventory(() => db, dbPath, other, {
        directory: other,
        project: "other",
      }) as string;
      expect(inventory).toContain("global anchor");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
