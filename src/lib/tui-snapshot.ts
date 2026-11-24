import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { getMeta, type MemoryDb } from "./db.js";
import { isEntryFresh } from "./git.js";
import { HOT_THRESHOLD } from "./store.js";
import type { MemorySidebarSnapshot } from "../rpc.js";

/**
 * Bound on the anchored entries probed for staleness per snapshot: the probe
 * costs one `statSync` per anchored path, and the sidebar refreshes on a poll
 * plus every host event. Entries beyond the cap (most recently updated first)
 * are not probed this tick. Verdicts are cached below, so the cap bounds the
 * stat work, not git subprocesses.
 */
export const SIDEBAR_STALE_CAP = 200;

/**
 * Freshness verdicts cached per process: one anchored entry costs 2 git
 * subprocesses per probe (`diff` + `ls-files`), and an active session
 * re-probes up to SIDEBAR_STALE_CAP entries on every event gap. The key
 * carries the observed state of every anchored path (mtimeMs + size, or
 * "missing"), so a cache hit still reflects the current working tree: an edit
 * moves mtime, a delete moves existence, the anchored (commit, paths) stamp
 * moves when the entry is re-saved. shortcut: mtime+size fingerprint, not a
 * content hash — a same-mtime same-size edit slips through until the next
 * observable change; upgrade if that ever matters in practice.
 */
const FRESH_CACHE_MAX = 10_000;

const freshVerdicts = new Map<string, boolean>();

/** Cache key for one anchored entry: the git stamp plus what the probe would
 * observe of each path right now. `\0` separators keep lists unambiguous. */
function freshKey(commitSha: string, paths: string[], directory: string): string {
  const root = resolve(directory);
  const parts = [root, commitSha];
  for (const path of paths) {
    parts.push(path);
    try {
      const stat = statSync(resolve(root, path));
      parts.push(`${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push("missing");
    }
  }
  return parts.join("\0");
}

function cachedFreshness(
  entry: { commit_sha: string; paths: string[] },
  directory: string,
): boolean {
  const key = freshKey(entry.commit_sha, entry.paths, directory);
  const hit = freshVerdicts.get(key);
  if (hit !== undefined) {
    // Refresh recency so eviction drops cold entries first.
    freshVerdicts.delete(key);
    freshVerdicts.set(key, hit);
    return hit;
  }
  const verdict = isEntryFresh(entry, directory);
  freshVerdicts.set(key, verdict);
  if (freshVerdicts.size > FRESH_CACHE_MAX) {
    freshVerdicts.delete(freshVerdicts.keys().next().value as string);
  }
  return verdict;
}

/** Test surface for the freshness cache: production code always goes through
 * buildSidebarSnapshot; tests reach the probe and its live size directly. */
export const freshCache = {
  probe: cachedFreshness,
  size: () => freshVerdicts.size,
};

/** Usable rows only: current, not trashed, not expired. Superseded tombstones
 * are neither live nor trashed — the sidebar counts what a read could return. */
const CURRENT_LIVE =
  "status = 'current' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

function count(db: MemoryDb, sql: string, params: unknown[]): number {
  return db.conn.get<{ n: number }>(sql, params)?.n ?? 0;
}

/** Pending sync files in one directory (.jsonl only; `.jsonl.imported` ones were
 * already consumed by a previous import pass). A missing directory is "nothing
 * there yet", not an error. */
function countJsonl(dir: string | undefined): number {
  if (dir === undefined) {
    return 0;
  }
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

/**
 * One aggregated read over the whole store for the TUI sidebar: machine-wide
 * counts (live, trashed, kinds, hot, shareable) plus the asking scope's share,
 * the staleness of its anchored entries (isEntryFresh against the project
 * directory), the last sweep's timestamp (metadata row) and cooled count (from
 * the caller's in-memory report), and the mesh sync file counts. Everything is
 * computed here so the formatter in rpc.ts stays a pure function of the
 * snapshot.
 */
export function buildSidebarSnapshot(
  db: MemoryDb,
  options: {
    /** The asking project's scope: stale and scope counts read scope + `global`. */
    scope: string;
    now: number;
    /** Git root the anchored entries are checked against; undefined skips the
     * staleness pass (stale stays 0). */
    directory?: string;
    /** Entries the caller's last housekeeping report cooled (in-memory only). */
    cooled?: number;
    /** Mesh sync directories; both undefined on a mesh-less machine. */
    inboxDir?: string;
    meshDataDir?: string;
  },
): MemorySidebarSnapshot {
  const now = options.now;
  const live = count(db, `SELECT COUNT(*) AS n FROM entries WHERE ${CURRENT_LIVE}`, [now]);
  const trashed = count(db, "SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NOT NULL", []);
  const kinds = db.conn.all<{ kind: string; count: number }>(
    `SELECT kind, COUNT(*) AS count FROM entries WHERE ${CURRENT_LIVE}
     GROUP BY kind ORDER BY count DESC, kind ASC`,
    [now],
  );
  const hot = count(db, `SELECT COUNT(*) AS n FROM entries WHERE heat >= ? AND ${CURRENT_LIVE}`, [
    HOT_THRESHOLD,
    now,
  ]);
  const shareable = count(
    db,
    `SELECT COUNT(*) AS n FROM entries
     WHERE endorsed_by IS NOT NULL AND endorsed_by != '[]' AND ${CURRENT_LIVE}`,
    [now],
  );
  const scope = count(
    db,
    `SELECT COUNT(*) AS n FROM entries WHERE (scope = ? OR scope = 'global') AND ${CURRENT_LIVE}`,
    [options.scope, now],
  );

  let stale = 0;
  if (options.directory !== undefined) {
    const anchored = db.conn.all<{ paths: string; commit_sha: string }>(
      `SELECT paths, commit_sha FROM entries
       WHERE (scope = ? OR scope = 'global') AND paths IS NOT NULL AND paths != '[]'
         AND commit_sha IS NOT NULL AND ${CURRENT_LIVE}
       ORDER BY updated_at DESC LIMIT ?`,
      [options.scope, now, SIDEBAR_STALE_CAP],
    );
    for (const row of anchored) {
      let paths: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.paths);
        if (Array.isArray(parsed)) {
          paths = parsed.filter((p): p is string => typeof p === "string");
        }
      } catch {
        // A malformed paths blob is not an anchored entry.
      }
      if (paths.length === 0) {
        continue;
      }
      if (!cachedFreshness({ commit_sha: row.commit_sha, paths }, options.directory)) {
        stale += 1;
      }
    }
  }

  const lastSweep = getMeta(db, "last_sweep_at");
  const lastSweepMs = lastSweep === null ? null : Number(lastSweep);
  return {
    store: true,
    live,
    trashed,
    kinds,
    hot,
    stale,
    shareable,
    scope,
    last_sweep_ms: lastSweepMs !== null && Number.isFinite(lastSweepMs) ? lastSweepMs : null,
    cooled: options.cooled ?? 0,
    sync_incoming: countJsonl(options.inboxDir),
    mesh_installed: options.meshDataDir !== undefined && existsSync(options.meshDataDir),
  };
}
