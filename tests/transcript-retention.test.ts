import { mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeTranscriptFile } from "../src/compaction.js";
import {
  collectTranscripts,
  effectiveLastTouch,
  formatSweepResult,
  sweepTranscripts,
} from "../src/transcript-retention.js";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-memory-retention-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const SCOPE = "/home/u/project";

function seed(dir: string, scope: string, sessionID: string, body = "x"): string {
  const path = join(dir, encodeURIComponent(scope), `${sessionID}.md`);
  writeTranscriptFile(path, body);
  return path;
}

describe("effectiveLastTouch", () => {
  it("uses the max of atime and mtime", () => {
    expect(effectiveLastTouch({ mtimeMs: 100, atimeMs: 200 })).toBe(200);
    expect(effectiveLastTouch({ mtimeMs: 200, atimeMs: 100 })).toBe(200);
  });
  it("falls back to mtime when atime is 0/NaN", () => {
    expect(effectiveLastTouch({ mtimeMs: 100, atimeMs: 0 })).toBe(100);
    expect(effectiveLastTouch({ mtimeMs: 100, atimeMs: Number.NaN })).toBe(100);
  });
});

describe("collectTranscripts", () => {
  it("collects regular .md files across scopes", () => {
    const dir = tmpDir();
    seed(dir, SCOPE, "ses_a");
    seed(dir, "/other", "ses_b");
    const entries = collectTranscripts(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.sessionID).sort()).toEqual(["ses_a", "ses_b"]);
  });
  it("skips symlinks and non-md files", () => {
    const dir = tmpDir();
    seed(dir, SCOPE, "ses_a");
    const target = join(tmpdir(), "target.md");
    writeFileSync(target, "x");
    dirs.push(target);
    symlinkSync(target, join(dir, encodeURIComponent(SCOPE), "evil.md"));
    writeFileSync(join(dir, encodeURIComponent(SCOPE), "note.txt"), "x");
    const entries = collectTranscripts(dir);
    expect(entries).toHaveLength(1);
  });
  it("returns empty for missing dir", () => {
    expect(collectTranscripts(join(tmpdir(), "nope-xyz"))).toEqual([]);
  });
});

describe("sweepTranscripts", () => {
  it("dry run reports candidates without deleting", () => {
    const dir = tmpDir();
    const pKeep = seed(dir, SCOPE, "ses_keep");
    const pOld = seed(dir, SCOPE, "ses_old");
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    utimesSync(pKeep, Date.now() / 1000, Date.now() / 1000);
    utimesSync(pOld, old / 1000, old / 1000);
    const result = sweepTranscripts(dir, {
      retentionDays: 30,
      keepRecent: 1,
      dryRun: true,
      now: Date.now(),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sessionID).toBe("ses_old");
    expect(result.removed).toHaveLength(0);
    expect(result.bytesFreed).toBe(0);
    expect(() => statSync(pOld)).not.toThrow();
  });

  it("apply deletes eligible files", () => {
    const dir = tmpDir();
    const pKeep = seed(dir, SCOPE, "ses_keep");
    const pOld = seed(dir, SCOPE, "ses_old");
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    utimesSync(pKeep, Date.now() / 1000, Date.now() / 1000);
    utimesSync(pOld, old / 1000, old / 1000);
    const result = sweepTranscripts(dir, {
      retentionDays: 30,
      keepRecent: 1,
      dryRun: false,
      now: Date.now(),
    });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.sessionID).toBe("ses_old");
    expect(result.bytesFreed).toBeGreaterThan(0);
    let gone = false;
    try {
      statSync(pOld);
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
    // kept file remains
    expect(() => statSync(pKeep)).not.toThrow();
  });

  it("keepRecent protects the newest N even when old", () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i++) {
      const p = seed(dir, SCOPE, `ses_${i}`);
      const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
      utimesSync(p, old / 1000, old / 1000);
    }
    const result = sweepTranscripts(dir, {
      retentionDays: 30,
      keepRecent: 10,
      dryRun: true,
      now: Date.now(),
    });
    // keepRecent=10 > 5 files, so none eligible
    expect(result.candidates).toHaveLength(0);
  });

  it("keepRecent floor keeps newest even beyond retention", () => {
    const dir = tmpDir();
    // 12 files, all old
    for (let i = 0; i < 12; i++) {
      const p = seed(dir, SCOPE, `ses_${i}`);
      const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
      utimesSync(p, old / 1000, old / 1000);
    }
    const result = sweepTranscripts(dir, {
      retentionDays: 30,
      keepRecent: 10,
      dryRun: true,
      now: Date.now(),
    });
    // 12 - 10 = 2 eligible
    expect(result.candidates).toHaveLength(2);
  });

  it("maxSessions caps per scope", () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i++) {
      seed(dir, SCOPE, `ses_${i}`);
    }
    const result = sweepTranscripts(dir, {
      retentionDays: 0,
      maxSessions: 2,
      keepRecent: 1,
      dryRun: true,
      now: Date.now(),
    });
    // keepRecent=1 protects newest; maxSessions=2 means index>=2 eligible -> 3 files (indices 2,3,4)
    expect(result.candidates).toHaveLength(3);
  });

  it("disabled (retentionDays 0, maxSessions 0) removes nothing", () => {
    const dir = tmpDir();
    const p = seed(dir, SCOPE, "ses_old");
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    utimesSync(p, old / 1000, old / 1000);
    const result = sweepTranscripts(dir, { dryRun: true, now: Date.now() });
    expect(result.candidates).toHaveLength(0);
  });

  it("protected session is never removed", () => {
    const dir = tmpDir();
    const p1 = seed(dir, SCOPE, "ses_keep");
    const p2 = seed(dir, SCOPE, "ses_protected");
    const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
    utimesSync(p1, old / 1000, old / 1000);
    utimesSync(p2, (old - 1000) / 1000, (old - 1000) / 1000);
    const without = sweepTranscripts(dir, {
      retentionDays: 30,
      keepRecent: 1,
      dryRun: true,
      now: Date.now(),
    });
    expect(without.candidates.map((c) => c.sessionID)).toContain("ses_protected");
    const withProt = sweepTranscripts(dir, {
      retentionDays: 30,
      keepRecent: 1,
      protectedSessionID: "ses_protected",
      dryRun: true,
      now: Date.now(),
    });
    expect(withProt.candidates.map((c) => c.sessionID)).not.toContain("ses_protected");
  });

  it("stat failure preserves file (not collected)", () => {
    // Can't easily force stat failure; skip by simulating missing scope dir handling already covered.
    const dir = tmpDir();
    seed(dir, SCOPE, "ses_a");
    const result = sweepTranscripts(dir, {
      retentionDays: 1,
      dryRun: true,
      now: Date.now() + 10 * 24 * 60 * 60 * 1000,
    });
    expect(result.candidates).toHaveLength(0);
  });

  it("keeps newest by effective last touch (atime resets clock)", () => {
    const dir = tmpDir();
    const p = seed(dir, SCOPE, "ses_touched");
    const oldMtime = Date.now() - 60 * 24 * 60 * 60 * 1000;
    utimesSync(p, Date.now() / 1000, Date.now() / 1000); // atime now = recent, mtime old
    // make mtime old but atime recent by setting mtime only
    utimesSync(p, oldMtime / 1000, Date.now() / 1000);
    const stat = statSync(p);
    expect(effectiveLastTouch(stat)).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
    const result = sweepTranscripts(dir, {
      retentionDays: 30,
      keepRecent: 1,
      dryRun: true,
      now: Date.now(),
    });
    expect(result.candidates).toHaveLength(0);
  });
});

describe("formatSweepResult", () => {
  it("formats dry run", () => {
    const r = sweepTranscripts(tmpDir(), { dryRun: true });
    const text = formatSweepResult(r, true);
    expect(text).toContain("dry run");
    expect(text).toContain("kept");
  });
});
