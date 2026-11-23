import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { sweepHousekeeping } from "../src/lib/housekeeping.js";
import { list, restore } from "../src/lib/store.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const TTL = 7 * DAY;

type Row = {
  scope?: string;
  kind?: string;
  title?: string;
  body?: string;
  created_at?: number;
  updated_at?: number;
  paths?: string[] | null;
  commit_sha?: string | null;
};

/** Direct row insert: duplicate tests need same-title rows, which save() would
 * rewrite instead of stacking. */
function insert(db: ReturnType<typeof openMemoryDb>, overrides: Row = {}): string {
  const id = randomUUID();
  db.conn.run(
    `INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at, source, paths, commit_sha, supersedes, status, superseded_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, NULL, NULL, ?, ?, NULL, 'current', NULL)`,
    [
      id,
      overrides.scope ?? "/w",
      overrides.kind ?? "fact",
      overrides.title ?? "note",
      overrides.body ?? "body",
      overrides.created_at ?? NOW,
      overrides.updated_at ?? NOW,
      overrides.paths === undefined ? null : JSON.stringify(overrides.paths),
      overrides.commit_sha ?? null,
    ],
  );
  return id;
}

function liveIds(db: ReturnType<typeof openMemoryDb>, scope = "/w"): string[] {
  return list(db, { scope, now: NOW, limit: 50 }).map((e) => e.id);
}

describe("housekeeping sweep: dated rule", () => {
  it("tombstones a dated entry past the default TTL and keeps it restorable", () => {
    const db = openMemoryDb(":memory:");
    const id = insert(db, {
      title: "migration status",
      body: "état: pending, ETA 2026-01-02",
      updated_at: NOW - 8 * DAY,
    });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report.tombstoned).toEqual([{ id, title: "migration status", rule: "dated" }]);
    expect(report.deleted).toEqual([]);
    expect(liveIds(db)).toEqual([]);
    // The tombstone follows the standard trash: restorable within 30 days.
    expect(restore(db, { id })?.id).toBe(id);
    expect(liveIds(db)).toEqual([id]);
    db.close();
  });

  it("keeps a dated entry younger than the TTL", () => {
    const db = openMemoryDb(":memory:");
    const id = insert(db, {
      title: "deploy state",
      body: "en cours",
      updated_at: NOW - 6 * DAY,
    });

    const report = sweepHousekeeping(db, { scope: "/w", ttlMs: TTL, now: NOW });

    expect(report.tombstoned).toEqual([]);
    expect(liveIds(db)).toEqual([id]);
    db.close();
  });

  it("never tombstones lessons, whatever their age", () => {
    const db = openMemoryDb(":memory:");
    const id = insert(db, {
      kind: "lesson",
      title: "batch writes",
      body: "state as of 2026-01-01: pending",
      updated_at: NOW - 60 * DAY,
    });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report.tombstoned).toEqual([]);
    expect(liveIds(db)).toEqual([id]);
    db.close();
  });

  it("leaves anchored entries to the anchoring rule", () => {
    const db = openMemoryDb(":memory:");
    const anchored = insert(db, {
      title: "schema note",
      body: "état: à revoir",
      updated_at: NOW - 60 * DAY,
      paths: ["src/db.ts"],
      commit_sha: "abc1234def",
    });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report.tombstoned).toEqual([]);
    expect(liveIds(db)).toEqual([anchored]);
    db.close();
  });

  it("treats a commit-only auto-anchor as unanchored for the dated rule", () => {
    const db = openMemoryDb(":memory:");
    const id = insert(db, {
      title: "todo",
      body: "waiting for review, pending",
      updated_at: NOW - 60 * DAY,
      commit_sha: "abc1234def",
    });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report.tombstoned).toEqual([{ id, title: "todo", rule: "dated" }]);
    db.close();
  });
});

describe("housekeeping sweep: exemptions", () => {
  it("exempts epic and task entries from both rules", () => {
    const db = openMemoryDb(":memory:");
    const epic = insert(db, {
      kind: "epic",
      title: "release 0.14",
      body: "en cours, ETA 2026-01-01",
      updated_at: NOW - 60 * DAY,
    });
    // Two identical task rows would be duplicates if the kind were not exempt.
    const taskOld = insert(db, {
      kind: "task",
      title: "release 0.14",
      body: "en cours, ETA 2026-01-01",
      created_at: NOW - 2 * DAY,
      updated_at: NOW - 60 * DAY,
    });
    const taskNew = insert(db, {
      kind: "task",
      title: "release 0.14",
      body: "en cours, ETA 2026-01-01",
      created_at: NOW - DAY,
      updated_at: NOW - 59 * DAY,
    });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report.tombstoned).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(new Set(liveIds(db))).toEqual(new Set([epic, taskOld, taskNew]));
    db.close();
  });
});

describe("housekeeping sweep: duplicate rule", () => {
  it("deletes the older of two exact duplicates and keeps the newest", () => {
    const db = openMemoryDb(":memory:");
    const older = insert(db, {
      title: "Postgres batching",
      body: "batch by 1000\nthen vacuum",
      created_at: NOW - 2 * DAY,
      updated_at: NOW - 2 * DAY,
    });
    const newer = insert(db, {
      title: "postgres batching",
      body: "batch by 1000 then vacuum",
      created_at: NOW - DAY,
    });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report.deleted).toEqual([{ id: older, title: "Postgres batching", rule: "duplicate" }]);
    expect(report.tombstoned).toEqual([]);
    expect(liveIds(db)).toEqual([newer]);
    // A duplicate is a real DELETE, not a tombstone.
    expect(db.conn.get("SELECT id FROM entries WHERE id = ?", [older])).toBeNull();
    db.close();
  });

  it("keeps same-body entries anchored differently", () => {
    const db = openMemoryDb(":memory:");
    const sameCommitOtherPaths = insert(db, {
      title: "batching",
      body: "batch by 1000",
      paths: ["src/b.ts"],
      commit_sha: "aaa1111",
    });
    const samePathsOtherCommit = insert(db, {
      title: "batching",
      body: "batch by 1000",
      paths: ["src/a.ts"],
      commit_sha: "bbb2222",
    });
    const unanchored = insert(db, { title: "batching", body: "batch by 1000" });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report.deleted).toEqual([]);
    expect(new Set(liveIds(db))).toEqual(
      new Set([sameCommitOtherPaths, samePathsOtherCommit, unanchored]),
    );
    db.close();
  });
});

describe("housekeeping sweep: report", () => {
  it("reports every action with counts and rules", () => {
    const db = openMemoryDb(":memory:");
    const dated = insert(db, {
      title: "status",
      body: "état: pending",
      updated_at: NOW - 10 * DAY,
    });
    const dupOld = insert(db, {
      title: "twin",
      body: "same",
      created_at: NOW - 2 * DAY,
      updated_at: NOW - 2 * DAY,
    });
    const dupNew = insert(db, { title: "twin", body: "same", created_at: NOW - DAY });
    const lesson = insert(db, {
      kind: "lesson",
      title: "learned",
      body: "en cours",
      updated_at: NOW - 10 * DAY,
    });
    const plain = insert(db, { title: "stable", body: "nothing dated here" });

    const report = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(report).toEqual({
      tombstoned: [{ id: dated, title: "status", rule: "dated" }],
      deleted: [{ id: dupOld, title: "twin", rule: "duplicate" }],
      kept: 3,
      cooled: 0,
    });
    expect(new Set(liveIds(db))).toEqual(new Set([dupNew, lesson, plain]));
    db.close();
  });

  it("is idempotent: a second sweep moves nothing", () => {
    const db = openMemoryDb(":memory:");
    insert(db, { title: "status", body: "état: pending", updated_at: NOW - 10 * DAY });
    insert(db, {
      title: "twin",
      body: "same",
      created_at: NOW - 2 * DAY,
      updated_at: NOW - 2 * DAY,
    });
    insert(db, { title: "twin", body: "same", created_at: NOW - DAY });

    const first = sweepHousekeeping(db, { scope: "/w", now: NOW });
    const second = sweepHousekeeping(db, { scope: "/w", now: NOW });

    expect(first.tombstoned).toHaveLength(1);
    expect(first.deleted).toHaveLength(1);
    expect(second).toEqual({ tombstoned: [], deleted: [], kept: first.kept, cooled: 0 });
    db.close();
  });
});
