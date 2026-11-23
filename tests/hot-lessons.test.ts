import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";
import { sweepHousekeeping } from "../src/lib/housekeeping.js";
import { createMemoryOps, memoryInventory } from "../src/lib/memory-ops.js";
import { HOT_THRESHOLD, saveEntry } from "../src/lib/store.js";

let dir: string;
let dbPath: string;
let db: MemoryDb;

function git(args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function commitFile(name: string, content: string): string {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
  git(["add", name]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", name]);
  return git(["rev-parse", "HEAD"]).trim();
}

function save(
  kind: string,
  title: string,
  options: { now?: number; paths?: string[]; commit_sha?: string } = {},
) {
  return saveEntry(
    db,
    {
      scope: "/w",
      kind,
      title,
      body: "b",
      tags: [],
      expires_at: null,
      ...(options.paths !== undefined ? { paths: options.paths } : {}),
      ...(options.commit_sha !== undefined ? { commit_sha: options.commit_sha } : {}),
    },
    options.now !== undefined ? { now: options.now } : {},
  ).entry;
}

function saturateBudget(): void {
  // Saturate the 1200-char budget with newer facts (one per char-bucket).
  for (let i = 0; i < 40; i += 1) {
    save("fact", `fact number ${i} with a reasonably long descriptive title`, { now: 2000 + i });
  }
}

function hotLesson(title: string): ReturnType<typeof save> {
  // Oldest entry, saved twice: recency alone would cut it first, heat saves it.
  save("lesson", title, { now: 1000 });
  // The replace-by-title result is the one carrying heat 2.
  return saveEntry(db, {
    scope: "/w",
    kind: "lesson",
    title,
    body: "b2",
    tags: [],
    expires_at: null,
  }).entry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-hot-lessons-"));
  git(["init", "-q"]);
  commitFile("README.md", "init");
  dbPath = join(dir, "memory.db");
  db = openMemoryDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  dbPath = "";
});

describe("heat counter", () => {
  it("a new lesson starts at heat 1, a re-recorded one turns hot", () => {
    const first = save("lesson", "pin the db path");
    expect(first.heat).toBe(1);

    const second = saveEntry(db, {
      scope: "/w",
      kind: "lesson",
      title: "pin the db path",
      body: "b2",
      tags: [],
      expires_at: null,
    }).entry;
    expect(second.id).toBe(first.id);
    expect(second.heat).toBe(2);
    expect(second.heat).toBeGreaterThanOrEqual(HOT_THRESHOLD);
  });

  it("non-lesson saves carry no heat", () => {
    const entry = save("fact", "a fact");
    expect(entry.heat).toBeUndefined();
    const updated = saveEntry(db, {
      scope: "/w",
      kind: "fact",
      title: "a fact",
      body: "b2",
      tags: [],
      expires_at: null,
    }).entry;
    expect(updated.heat).toBeUndefined();
  });
});

describe("hot injection", () => {
  it("a hot lesson is injected first, marked [HOT], even with a saturated budget", () => {
    const hot = hotLesson("always quote git commit messages");
    expect(hot.heat).toBe(HOT_THRESHOLD);
    saturateBudget();

    const text = memoryInventory(() => db, dbPath, "/w");
    expect(text).not.toBeNull();
    const lines = (text as string).split("\n");
    const hotLine = lines.find((line) => line.includes(hot.title));
    expect(hotLine).toMatch(/^- \[lesson\]\[HOT\] always quote git commit messages \(updated /);
    const hotIndex = lines.indexOf(hotLine as string);
    const firstFactIndex = lines.findIndex((line) => line.includes("fact number"));
    expect(hotIndex).toBe(1); // right after the header
    expect(hotIndex).toBeLessThan(firstFactIndex);
  });

  it("non-hot lines are cut by the budget while the hot one stays", () => {
    const hot = hotLesson("the hot one");
    saturateBudget();

    const text = memoryInventory(() => db, dbPath, "/w") as string;
    // The budget fills with the newest facts; the oldest non-hot one is cut...
    expect(text).not.toContain("fact number 0 ");
    // ...while the hot lesson is still there.
    expect(text).toContain(`[HOT] ${hot.title}`);
  });

  it("a hot non-lesson entry is included too", () => {
    const fact = save("fact", "a hot fact", { now: 1000 });
    // Heat only accrues to lessons through saves; a fact can arrive hot through
    // another path (imports, future rules), so set it directly.
    db.conn.run("UPDATE entries SET heat = ? WHERE id = ?", [HOT_THRESHOLD, fact.id]);

    const text = memoryInventory(() => db, dbPath, "/w") as string;
    expect(text).toContain("[fact][HOT] a hot fact");
  });
});

describe("re-injection callback", () => {
  it("saving a lesson resets the injection cache, other saves do not", () => {
    const onLessonSaved = vi.fn();
    const ops = createMemoryOps(() => db, { onLessonSaved });

    ops.save({ kind: "fact", title: "plain fact", body: "b" }, "/w");
    expect(onLessonSaved).not.toHaveBeenCalled();

    ops.save({ kind: "lesson", title: "a lesson", body: "b" }, "/w");
    expect(onLessonSaved).toHaveBeenCalledTimes(1);

    // Re-recording the lesson (replace-by-title) fires again.
    ops.save({ kind: "lesson", title: "a lesson", body: "b2" }, "/w");
    expect(onLessonSaved).toHaveBeenCalledTimes(2);
  });
});

describe("cooling at sweep", () => {
  function readHeat(id: string): number | undefined {
    return db.conn.get<{ heat: number }>("SELECT heat FROM entries WHERE id = ?", [id])?.heat;
  }

  function anchoredLesson(title: string): ReturnType<typeof save> {
    const commit = commitFile("src/a.ts", "v1");
    saveEntry(db, {
      scope: dir,
      kind: "lesson",
      title,
      body: "b",
      tags: [],
      expires_at: null,
      paths: ["src/a.ts"],
      commit_sha: commit,
    });
    // The replace-by-title result is the one carrying heat 2.
    return saveEntry(db, {
      scope: dir,
      kind: "lesson",
      title,
      body: "b2",
      tags: [],
      expires_at: null,
      paths: ["src/a.ts"],
      commit_sha: commit,
    }).entry;
  }

  it("a fresh anchored entry loses one heat per sweep, down to 0", () => {
    const entry = anchoredLesson("anchored lesson");
    expect(entry.heat).toBe(2);

    const first = sweepHousekeeping(db, { scope: dir, directory: dir });
    expect(first.cooled).toBe(1);
    expect(readHeat(entry.id)).toBe(1);

    const second = sweepHousekeeping(db, { scope: dir, directory: dir });
    expect(second.cooled).toBe(1);
    expect(readHeat(entry.id)).toBe(0);

    // Floor: cooling never pushes heat below 0.
    const third = sweepHousekeeping(db, { scope: dir, directory: dir });
    expect(third.cooled).toBe(0);
    expect(readHeat(entry.id)).toBe(0);
  });

  it("a stale anchored entry keeps its heat", () => {
    const entry = anchoredLesson("stale lesson");
    expect(entry.heat).toBe(2);

    // The anchored file changes after the save: the entry is stale.
    commitFile("src/a.ts", "v2");

    const report = sweepHousekeeping(db, { scope: dir, directory: dir });
    expect(report.cooled).toBe(0);
    expect(readHeat(entry.id)).toBe(2);
  });

  it("without a directory the sweep never cools", () => {
    const entry = anchoredLesson("hot lesson");
    const report = sweepHousekeeping(db, { scope: dir });
    expect(report.cooled).toBe(0);
    expect(readHeat(entry.id)).toBe(2);
  });
});
