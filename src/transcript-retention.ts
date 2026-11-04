import { lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** One transcript file discovered on disk, with the stats needed for retention decisions. */
export type TranscriptEntry = {
  path: string;
  scope: string;
  sessionID: string;
  mtimeMs: number;
  atimeMs: number;
  size: number;
};

export type TranscriptCandidate = {
  path: string;
  scope: string;
  sessionID: string;
  reason: string;
  bytes: number;
  ageDays: number;
};

export type SweepOptions = {
  /** Epoch ms "now". Defaults to Date.now(). */
  now?: number;
  /** Delete transcripts older than this many days. 0 (default) disables age-based deletion. */
  retentionDays?: number;
  /** Always keep this many newest transcripts per scope, regardless of age. Default 10. */
  keepRecent?: number;
  /** Hard cap on transcripts per scope (newest kept). 0 (default) disables the cap. */
  maxSessions?: number;
  /** Session id that must never be deleted (the active session). */
  protectedSessionID?: string;
  /** When true, report candidates without deleting. Default false. */
  dryRun?: boolean;
};

export type SweepResult = {
  candidates: TranscriptCandidate[];
  removed: TranscriptCandidate[];
  kept: number;
  bytesFreed: number;
  errors: string[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Last touch = most recent of access or modification. Falls back to modification when
 * atime is unavailable (noatime mounts) or invalid. */
export function effectiveLastTouch(stat: { mtimeMs: number; atimeMs: number }): number {
  const atime = Number.isFinite(stat.atimeMs) ? stat.atimeMs : 0;
  const mtime = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  return Math.max(atime, mtime, 0);
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Walk every scope directory and return one entry per regular .md transcript file. */
export function collectTranscripts(dir: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let scopeEntries: unknown;
  try {
    scopeEntries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of (scopeEntries ?? []) as Array<{ isDirectory(): boolean; name: string }>) {
    if (!entry.isDirectory()) {
      continue;
    }
    let scope: string;
    try {
      scope = decodeURIComponent(entry.name);
    } catch {
      scope = entry.name;
    }
    const scopeDirPath = join(dir, entry.name);
    let names: string[];
    try {
      names = readdirSync(scopeDirPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const path = join(scopeDirPath, name);
      if (!isRegularFile(path)) {
        continue;
      }
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        // Stat failure: treat as unknown and preserve (do not collect for deletion).
        continue;
      }
      let sessionID: string;
      try {
        sessionID = decodeURIComponent(name.slice(0, -".md".length));
      } catch {
        sessionID = name.slice(0, -".md".length);
      }
      out.push({
        path,
        scope,
        sessionID,
        mtimeMs: stat.mtimeMs,
        atimeMs: stat.atimeMs,
        size: stat.size,
      });
    }
  }
  return out;
}

/** Determine which transcripts are eligible for removal under the given policy. Never
 * mutates disk unless `dryRun` is false. Returns the candidate list (plus removal
 * results when applied) so callers can report and audit. */
export function sweepTranscripts(dir: string, options: SweepOptions = {}): SweepResult {
  const now =
    typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const retentionDays =
    typeof options.retentionDays === "number" && options.retentionDays > 0
      ? options.retentionDays
      : 0;
  const keepRecent = Math.max(1, Math.floor(options.keepRecent ?? 10));
  const maxSessions =
    typeof options.maxSessions === "number" && options.maxSessions > 0
      ? Math.floor(options.maxSessions)
      : 0;
  const protectedID =
    typeof options.protectedSessionID === "string" && options.protectedSessionID.length > 0
      ? options.protectedSessionID
      : undefined;
  const dryRun = options.dryRun === true;

  const entries = collectTranscripts(dir);

  // Group by scope, newest first by effective last touch.
  const byScope = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    const list = byScope.get(entry.scope);
    if (list) {
      list.push(entry);
    } else {
      byScope.set(entry.scope, [entry]);
    }
  }

  const candidates: TranscriptCandidate[] = [];
  for (const [, list] of byScope) {
    const ordered = [...list].sort((a, b) => effectiveLastTouch(b) - effectiveLastTouch(a));
    for (let index = 0; index < ordered.length; index++) {
      const entry = ordered[index];
      if (entry === undefined) {
        continue;
      }
      if (protectedID !== undefined && entry.sessionID === protectedID) {
        continue;
      }
      // Safety floor: never touch the newest `keepRecent`.
      if (index < keepRecent) {
        continue;
      }
      const reasons: string[] = [];
      const ageMs = now - effectiveLastTouch(entry);
      const ageDays = Math.max(0, Math.floor(ageMs / MS_PER_DAY));
      if (retentionDays > 0 && ageMs > retentionDays * MS_PER_DAY) {
        reasons.push(`age ${ageDays}d > ${retentionDays}d`);
      }
      if (maxSessions > 0 && index >= maxSessions) {
        reasons.push(`beyond maxSessions ${maxSessions}`);
      }
      if (reasons.length === 0) {
        continue;
      }
      candidates.push({
        path: entry.path,
        scope: entry.scope,
        sessionID: entry.sessionID,
        reason: reasons.join("; "),
        bytes: entry.size,
        ageDays,
      });
    }
  }

  // Oldest first for a readable report.
  candidates.sort((a, b) => a.ageDays - b.ageDays || a.path.localeCompare(b.path));

  const removed: TranscriptCandidate[] = [];
  const errors: string[] = [];
  let bytesFreed = 0;

  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        unlinkSync(candidate.path);
        removed.push(candidate);
        bytesFreed += candidate.bytes;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${candidate.path}: ${message}`);
      }
    }
  }

  const kept = entries.length - (dryRun ? 0 : removed.length);
  return { candidates, removed, kept, bytesFreed, errors };
}

/** Human-readable summary of a sweep result, bounded so it never floods the context. */
export function formatSweepResult(result: SweepResult, dryRun: boolean): string {
  const lines: string[] = [];
  if (dryRun) {
    lines.push(`dry run: ${result.candidates.length} transcript(s) eligible for removal`);
  } else {
    lines.push(`removed ${result.removed.length} transcript(s), freed ${result.bytesFreed} bytes`);
    if (result.errors.length > 0) {
      lines.push(`errors: ${result.errors.length}`);
    }
  }
  lines.push(`kept ${result.kept} transcript(s)`);
  const preview = (dryRun ? result.candidates : result.removed).slice(0, 20);
  for (const item of preview) {
    lines.push(
      `- ${item.scope}/${item.sessionID} (${item.bytes} bytes, ${item.ageDays}d): ${item.reason}`,
    );
  }
  if ((dryRun ? result.candidates : result.removed).length > preview.length) {
    lines.push(
      `... and ${(dryRun ? result.candidates : result.removed).length - preview.length} more`,
    );
  }
  if (result.errors.length > 0) {
    for (const error of result.errors.slice(0, 10)) {
      lines.push(`! ${error}`);
    }
  }
  return lines.join("\n");
}
