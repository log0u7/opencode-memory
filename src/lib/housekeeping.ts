import { setMeta, type MemoryDb } from "./db.js";
import { isEntryFresh } from "./git.js";
import { canonicalScope } from "./store.js";

/** Default age at which a dated entry becomes sweepable: one week. */
export const DEFAULT_SWEEP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Automatic housekeeping cadence: the plugin sweeps once at boot, then daily. */
export const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type HousekeepingRule = "dated" | "duplicate";

export type HousekeepingReport = {
  /** Entries moved to the trash (recoverable through memory_restore for the
   * standard 30 days), with the rule that moved them. */
  tombstoned: Array<{ id: string; title: string; rule: HousekeepingRule }>;
  /** Entries removed for good, with the rule that removed them. */
  deleted: Array<{ id: string; title: string; rule: HousekeepingRule }>;
  /** Live entries the sweep left in place. */
  kept: number;
  /** Anchored entries whose files are unchanged since their commit and whose
   * heat stepped down by one. 0 unless a directory was passed. */
  cooled: number;
};

/** Content that describes a moment, not a durable truth. Case-insensitive; the
 * single-word markers carry word boundaries so "impending" or "metadata" never
 * read as state markers. */
const DATED_MARKER =
  /\d{4}-\d{2}-\d{2}|état au|état:|state as of|en cours|en vol|attente|\b(?:pending|ETA)\b/i;

/** Kinds the sweep never touches: orchestrator steering rows, managed by the
 * lead and todowrite, are exempt from every rule. */
const STEERING_KINDS = new Set(["epic", "task"]);

const LIVE_CURRENT = "deleted_at IS NULL AND status = 'current'";

type Candidate = {
  id: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  paths: string | null;
  commit_sha: string | null;
  heat: number;
};

/**
 * Conservative automatic housekeeping for one scope (plus `global`, like every
 * read). Two passes, oldest hazards first:
 *
 * 1. `dated` — an entry that is not a lesson, not code-anchored, and carries a
 *    dated-state marker is tombstoned once it has not been updated for `ttlMs`.
 *    Lessons are exempt (their freshness is the anchoring's job) and anchored
 *    entries are left to the anchoring, which already knows whether their code
 *    moved. Tombstones follow the standard 30-day retention.
 * 2. `duplicate` — entries of the same scope with the same normalized title and
 *    body, and the same anchoring, collapse to the newest copy; the older ones
 *    are deleted for good (an exact duplicate adds nothing to the trash).
 * 3. `cooling` — an anchored entry whose files are unchanged since its commit
 *    is being honored: its heat steps down by one per sweep toward 0 (never
 *    below). Discipline lives in the code, so a re-recorded lesson that keeps
 *    proving true can cool off and give its priority slot back. Runs only when
 *    the caller passes a `directory` (the git root freshness is checked against).
 *
 * Everything it does is reported; nothing is dropped silently.
 */
export function sweepHousekeeping(
  db: MemoryDb,
  options: { scope: string; ttlMs?: number; now?: number; directory?: string },
): HousekeepingReport {
  const scope = canonicalScope(options.scope);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SWEEP_TTL_MS;
  const report: HousekeepingReport = { tombstoned: [], deleted: [], kept: 0, cooled: 0 };

  for (const candidate of candidates(db, scope, now)) {
    if (candidate.kind === "lesson" || STEERING_KINDS.has(candidate.kind)) {
      continue;
    }
    if (isAnchored(candidate)) {
      continue;
    }
    if (candidate.updated_at >= now - ttlMs) {
      continue;
    }
    if (!DATED_MARKER.test(`${candidate.title}\n${candidate.body}`)) {
      continue;
    }
    db.conn.run("UPDATE entries SET deleted_at = ? WHERE id = ?", [now, candidate.id]);
    report.tombstoned.push({ id: candidate.id, title: candidate.title, rule: "dated" });
  }

  for (const group of duplicateGroups(candidates(db, scope, now))) {
    // Newest copy survives; the rest are exact duplicates and leave the store.
    const stale = group.slice(0, -1);
    for (const duplicate of stale) {
      db.conn.run("DELETE FROM entries WHERE id = ?", [duplicate.id]);
      report.deleted.push({ id: duplicate.id, title: duplicate.title, rule: "duplicate" });
    }
  }

  if (options.directory !== undefined) {
    for (const candidate of candidates(db, scope, now)) {
      if (!isAnchored(candidate) || candidate.heat <= 0) {
        continue;
      }
      const fresh = isEntryFresh(
        {
          commit_sha: candidate.commit_sha ?? undefined,
          paths: parsedPaths(candidate.paths),
        },
        options.directory,
      );
      // One step per sweep: heat decays gradually, a single sweep never zeroes it.
      if (fresh) {
        db.conn.run("UPDATE entries SET heat = heat - 1 WHERE id = ?", [candidate.id]);
        report.cooled += 1;
      }
    }
  }

  report.kept = countLive(db, scope, now);
  // Stamped on every sweep (boot, daily, manual memory_sweep): the TUI sidebar
  // derives "last sweep: <age>" from this row, surviving process restarts.
  setMeta(db, "last_sweep_at", String(now));
  return report;
}

function candidates(db: MemoryDb, scope: string, now: number): Candidate[] {
  return db.conn.all<Candidate>(
    `SELECT id, scope, kind, title, body, created_at, updated_at, paths, commit_sha, heat FROM entries
     WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?) AND ${LIVE_CURRENT}
     ORDER BY created_at ASC, id ASC`,
    [scope, now],
  );
}

function countLive(db: MemoryDb, scope: string, now: number): number {
  return (
    db.conn.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entries
       WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?) AND ${LIVE_CURRENT}`,
      [scope, now],
    )?.n ?? 0
  );
}

/** Anchored means paths and commit together (the 0.11.0 anchor pair): a bare
 * commit is the auto-anchor every plugin save carries, and would make the dated
 * rule unreachable. */
function isAnchored(candidate: Candidate): boolean {
  return candidate.commit_sha !== null && parsedPaths(candidate.paths).length > 0;
}

function parsedPaths(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Groups of exact duplicates: same scope, same normalized title (lower+trim),
 * same normalized body (trim+collapsed whitespace), same anchoring. Distinct
 * paths or commits mean the entries document different states of the code and
 * are not duplicates.
 */
function duplicateGroups(candidates: Candidate[]): Candidate[][] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (STEERING_KINDS.has(candidate.kind)) {
      continue;
    }
    const key = JSON.stringify([
      candidate.scope,
      candidate.title.trim().toLowerCase(),
      candidate.body.trim().replace(/\s+/g, " "),
      parsedPaths(candidate.paths),
      candidate.commit_sha,
    ]);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }
  // Candidates arrive oldest-first, so each group is age-ordered already.
  return [...groups.values()].filter((group) => group.length > 1);
}
