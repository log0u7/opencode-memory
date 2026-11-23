import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import type { Entry } from "../types/entry.js";
import type { MemoryDb } from "./db.js";
import {
  allLive,
  FALLBACK_SCOPE,
  listShareable,
  looksLikeSecret,
  validateEntry,
  SecretDetectedError,
} from "./store.js";

/** A portable file holds one JSON entry per line, in ascending created_at order so a
 * re-export of a growing store mostly appends. Line-oriented on purpose: git diffs and
 * manual reviews stay readable. */
export const PORTABLE_FILE_NAME = "memory-export.jsonl";

const ID_MAX = 200;

export type ExportOptions = {
  /** Extra caller-side content filter (e.g. a stricter secret policy): an entry whose
   * body makes the predicate true is left out of the file. */
  rejectContent?: (body: string) => boolean;
  /** Cap the file at the first `limit` entries in file order. */
  limit?: number;
  /** Export only the entries worth sharing cross-host: at least one endorsement
   * (a peer's, or the author's own when the save published with `shareable`). */
  shareable?: boolean;
};

export type ImportOptions = {
  /** Extra caller-side content filter: an entry whose body makes the predicate true
   * is skipped. */
  rejectContent?: (body: string) => boolean;
  /** Stop once this many entries have been imported. */
  max?: number;
};

/** Default portable file inside the project, versionable in git next to the code. */
export function portableDefaultPath(directory: string): string {
  return `${directory.replace(/\/+$/, "")}/.opencode/memory/${PORTABLE_FILE_NAME}`;
}

/** Directory behind the default portable path: the scope itself when it names an
 * absolute project directory. A named (non-path) scope and the fallback root scope
 * have no project directory, so no default can be derived. */
export function portableDirectory(scope: string): string | undefined {
  if (scope !== FALLBACK_SCOPE && isAbsolute(scope)) {
    return scope;
  }
  return undefined;
}

/** The file a tool call writes to or reads from: the explicit path when given, else
 * the project default. Throws when no default can be derived, so the caller answers
 * with guidance instead of touching a surprise location. */
export function resolvePortablePath(path: string | undefined, scope: string): string {
  if (path !== undefined && path.length > 0) {
    return path;
  }
  const directory = portableDirectory(scope);
  if (directory === undefined) {
    throw new Error(
      "cannot derive the default portable path: the scope must be an absolute project directory; pass an explicit path",
    );
  }
  return portableDefaultPath(directory);
}

/**
 * Write the live entries of one scope (tombstones included) to a portable JSONL file.
 * Entries whose text fields match a credential pattern are never written, whatever the
 * caller passes: the file is meant for git and for other machines, and a secret that
 * survived an old save must not gain a second life there.
 *
 * The write is atomic (tmp file + rename, mode 0600): a reader, a git snapshot or a
 * failed export never sees a partial file. Returns the number of entries written.
 */
export function exportPortable(
  db: MemoryDb,
  scope: string,
  filePath: string,
  opts: ExportOptions = {},
): number {
  const entries = opts.shareable === true ? listShareable(db, scope) : allLive(db, scope);
  const capped =
    opts.limit === undefined ? entries : entries.slice(0, Math.max(0, Math.trunc(opts.limit)));
  const kept = capped.filter(
    (entry) => !looksLikeSecret(entry) && !opts.rejectContent?.(entry.body),
  );
  writeAtomically(
    filePath,
    kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length > 0 ? "\n" : ""),
  );
  return kept.length;
}

/**
 * Read a portable JSONL file into the store, keeping the original ids so a re-import
 * is idempotent and cross-machine copies stay the same entries. Lines are validated
 * before anything is written; a structurally broken line aborts the whole import with
 * its line number, because a half-understood file must not become half a store.
 *
 * Existing ids are skipped, secret-like content is skipped, and the workflow-guard rule
 * holds in both directions: a `superseded` entry imports only when its own `supersedes`
 * target travels in the same file, and a current entry whose target stays outside the
 * file imports without the link, so an import never tombstones or claims local rows.
 * Returns how many entries were inserted and how many valid lines were skipped (ids
 * already present, caller-side content rejects, orphan superseded rows, the `max` cap).
 */
export function importPortable(
  db: MemoryDb,
  filePath: string,
  opts: ImportOptions = {},
): { imported: number; skipped: number } {
  const batch = readBatch(filePath);
  const batchIds = new Set(batch.map((entry) => entry.id));
  const max = opts.max === undefined ? undefined : Math.max(0, Math.trunc(opts.max));
  let imported = 0;
  for (const entry of batch) {
    if (max !== undefined && imported >= max) {
      break;
    }
    if (entryExists(db, entry.id)) {
      continue;
    }
    if (opts.rejectContent?.(entry.body)) {
      continue;
    }
    if (entry.status === "superseded") {
      if (entry.supersedes === undefined || !batchIds.has(entry.supersedes)) {
        continue;
      }
    }
    // A link kept only when its target travels in the same file: one pointing at a
    // local row would claim that row was replaced, which an import must never do.
    const link =
      entry.supersedes !== undefined && batchIds.has(entry.supersedes)
        ? entry.supersedes
        : undefined;
    insertImported(db, entry, link);
    imported += 1;
  }
  return { imported, skipped: batch.length - imported };
}

/** Parse and validate every non-empty line up front, so validation failures surface
 * before any write. The built-in secret scan skips instead of throwing: refusing one
 * credential-looking line must not make the rest of the file unreadable. */
function readBatch(filePath: string): Entry[] {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const batch: Entry[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const entry = parseLine(line, index + 1);
    try {
      validateEntry(entry);
    } catch (error) {
      if (error instanceof SecretDetectedError) {
        continue;
      }
      throw new Error(`line ${index + 1}: ${(error as Error).message}`);
    }
    batch.push(entry);
  }
  return batch;
}

function parseLine(line: string, lineNo: number): Entry {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNo}: not valid JSON`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`line ${lineNo}: not an entry object`);
  }
  const fields = raw as Record<string, unknown>;
  const id = fields.id;
  if (typeof id !== "string" || id.length === 0 || id.length > ID_MAX || /[\0\r\n]/.test(id)) {
    throw new Error(
      `line ${lineNo}: id must be a 1..${ID_MAX} character string without \\0, \\r or \\n`,
    );
  }
  const scope = fields.scope;
  if (typeof scope !== "string" || scope.length === 0) {
    throw new Error(`line ${lineNo}: scope must be a non-empty string`);
  }
  return {
    id,
    scope,
    kind: expectString(fields.kind, "kind", lineNo),
    title: expectString(fields.title, "title", lineNo),
    body: expectString(fields.body, "body", lineNo),
    tags: expectStringArray(fields.tags, "tags", lineNo),
    created_at: expectNumber(fields.created_at, "created_at", lineNo),
    updated_at: expectNumber(fields.updated_at, "updated_at", lineNo),
    expires_at:
      fields.expires_at === undefined || fields.expires_at === null
        ? null
        : expectNumber(fields.expires_at, "expires_at", lineNo),
    ...(typeof fields.source === "string" ? { source: fields.source } : {}),
    ...(fields.paths === undefined
      ? {}
      : { paths: expectStringArray(fields.paths, "paths", lineNo) }),
    ...(typeof fields.commit_sha === "string" ? { commit_sha: fields.commit_sha } : {}),
    ...(typeof fields.supersedes === "string" ? { supersedes: fields.supersedes } : {}),
    ...(fields.status === "superseded" ? { status: "superseded" as const } : {}),
    ...(typeof fields.superseded_at === "number" ? { superseded_at: fields.superseded_at } : {}),
  };
}

function expectString(value: unknown, what: string, lineNo: number): string {
  if (typeof value !== "string") {
    throw new Error(`line ${lineNo}: ${what} must be a string`);
  }
  return value;
}

function expectNumber(value: unknown, what: string, lineNo: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`line ${lineNo}: ${what} must be a finite number`);
  }
  return value;
}

function expectStringArray(value: unknown, what: string, lineNo: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`line ${lineNo}: ${what} must be an array of strings`);
  }
  return value as string[];
}

function entryExists(db: MemoryDb, id: string): boolean {
  return db.conn.get("SELECT id FROM entries WHERE id = ?", [id]) !== null;
}

/** Plain insert, not saveEntry: the file already carries the id, timestamps and
 * lifecycle the store should keep verbatim. The entries_fts trigger indexes the row. */
function insertImported(db: MemoryDb, entry: Entry, supersedes: string | undefined): void {
  db.conn.run(
    "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at, source, paths, commit_sha, supersedes, status, superseded_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    [
      entry.id,
      entry.scope,
      entry.kind,
      entry.title,
      entry.body,
      JSON.stringify(entry.tags),
      entry.created_at,
      entry.updated_at,
      entry.expires_at,
      entry.source ?? null,
      JSON.stringify(entry.paths ?? []),
      entry.commit_sha ?? null,
      supersedes ?? null,
      entry.status ?? "current",
      entry.superseded_at ?? null,
    ],
  );
}

function writeAtomically(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The tmp file may not exist yet: the original failure is the one to report.
    }
    throw error;
  }
}
