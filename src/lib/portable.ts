import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import type { Entry } from "../types/entry.js";
import type { MemoryDb } from "./db.js";
import {
  allLive,
  FALLBACK_SCOPE,
  listShareable,
  listShareableAll,
  looksLikeSecret,
  validateEntry,
  SecretDetectedError,
} from "./store.js";

/** A portable file holds one JSON entry per line, in ascending created_at order so a
 * re-export of a growing store mostly appends. Line-oriented on purpose: git diffs and
 * manual reviews stay readable. */
export const PORTABLE_FILE_NAME = "memory-export.jsonl";

const ID_MAX = 200;
const SCOPE_MAX = 512;
const SOURCE_MAX = 256;
/** A line stamped further in the future than this is hostile or clock-broken. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** expires_at may reach at most a decade ahead: no credible TTL needs more. */
const EXPIRES_MAX_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export type ExportOptions = {
  /** Extra caller-side content filter (e.g. a stricter secret policy): an entry whose
   * body makes the predicate true is left out of the file. */
  rejectContent?: (body: string) => boolean;
  /** Cap the file at the first `limit` entries in file order. */
  limit?: number;
  /** Export only the entries worth sharing cross-host: at least one endorsement
   * (a peer's, or the author's own when the save published with `shareable`). */
  shareable?: boolean;
  /** With `shareable`, export the shareable entries of every scope, not just the
   * caller's: the mesh outbox is one machine-wide file. */
  allScopes?: boolean;
  /** Stamp every exported line with this machine's hostname as `origin_host`:
   * the peer marker that tells a remote import to remap the scope to `global`. */
  originHost?: string;
};

export type ImportOptions = {
  /** Extra caller-side content filter: an entry whose body makes the predicate true
   * is skipped. */
  rejectContent?: (body: string) => boolean;
  /** Stop once this many entries have been imported. */
  max?: number;
  /** The sending node's fingerprint (derived from the mesh inbox file's node id,
   * proven by the transport). A cross-host entry keeps its endorsements only when at
   * least one carries this fingerprint; anything else arrives non-shareable. */
  originFingerprint?: string;
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
  const entries =
    opts.shareable === true
      ? opts.allScopes === true
        ? listShareableAll(db)
        : listShareable(db, scope)
      : allLive(db, scope);
  const capped =
    opts.limit === undefined ? entries : entries.slice(0, Math.max(0, Math.trunc(opts.limit)));
  const kept = capped.filter(
    (entry) => !looksLikeSecret(entry) && !opts.rejectContent?.(entry.body),
  );
  writeAtomically(
    filePath,
    kept
      .map((entry) =>
        JSON.stringify(
          opts.originHost === undefined ? entry : { ...entry, origin_host: opts.originHost },
        ),
      )
      .join("\n") + (kept.length > 0 ? "\n" : ""),
  );
  return kept.length;
}

/**
 * Read a portable JSONL file into the store, keeping the original ids so a re-import
 * is idempotent and cross-machine copies stay the same entries. Lines are validated
 * before anything is written; a structurally broken line aborts the whole import with
 * its line number, because a half-understood file must not become half a store.
 *
 * Entries stamped with an `origin_host` (the marker the mesh outbox export adds) are
 * cross-host knowledge: their scope is a path that only exists on the machine that
 * wrote them, and importing it verbatim would bury the entry in a scope this host
 * never reads. Such entries are remapped to the `global` scope, so the local reads
 * (search, list, inventory) surface them. The trust model is assumed, not verified
 * per entry: transport runs between TLS-pinned paired hosts, exports are secret-
 * scanned, and only endorsed entries travel; cross-host knowledge is machine-wide
 * by nature, hence the `global` destination.
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
  const now = Date.now();
  const batch = readBatch(filePath, now);
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
    // Peer entries land in `global` (see above); local exports keep their scope
    // verbatim, the 0.13.0 same-machine round-trip behavior.
    const crossHost = entry.origin_host !== undefined;
    // The endorsement trust gate (0.24.0): agent names are self-declared, so a
    // cross-host endorsement survives only when it carries the fingerprint of the
    // node the transport proved (the inbox file's authenticated sender). Without
    // that stamp the endorsement is unverifiable: the entry arrives non-shareable
    // and re-endorsable locally. Same-machine imports keep the file's endorsements
    // verbatim: the round-trip and the retro-compat path.
    let endorsed = entry.endorsed_by;
    if (crossHost && endorsed !== undefined) {
      const fingerprint = opts.originFingerprint;
      const verified =
        fingerprint !== undefined &&
        endorsed.some((endorser) => endorser.endsWith(`@${fingerprint}`));
      if (!verified) {
        endorsed = undefined;
      }
    }
    insertImported(db, entry, link, {
      crossHost,
      ...(endorsed !== undefined ? { endorsed } : {}),
    });
    imported += 1;
  }
  return { imported, skipped: batch.length - imported };
}

/** Parse and validate every non-empty line up front, so validation failures surface
 * before any write. The built-in secret scan skips instead of throwing: refusing one
 * credential-looking line must not make the rest of the file unreadable. */
function readBatch(filePath: string, now: number): Entry[] {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const batch: Entry[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const entry = parseLine(line, index + 1, now);
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

function parseLine(line: string, lineNo: number, now: number): Entry {
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
  if (scope.length > SCOPE_MAX) {
    throw new Error(`line ${lineNo}: scope must be at most ${SCOPE_MAX} characters`);
  }
  let project: string | undefined;
  if (fields.project !== undefined) {
    if (
      typeof fields.project !== "string" ||
      fields.project.length === 0 ||
      fields.project.length > SCOPE_MAX
    ) {
      throw new Error(`line ${lineNo}: project must be a 1..${SCOPE_MAX} character string`);
    }
    project = fields.project;
  }
  if (fields.source !== undefined && typeof fields.source === "string") {
    if (fields.source.length > SOURCE_MAX) {
      throw new Error(`line ${lineNo}: source must be at most ${SOURCE_MAX} characters`);
    }
  }
  const created_at = expectNumber(fields.created_at, "created_at", lineNo);
  if (created_at > now + CLOCK_SKEW_MS) {
    throw new Error(
      `line ${lineNo}: created_at must not be more than 5 minutes in the future (clock skew or hostile file)`,
    );
  }
  const updated_at = expectNumber(fields.updated_at, "updated_at", lineNo);
  if (updated_at > now + CLOCK_SKEW_MS) {
    throw new Error(
      `line ${lineNo}: updated_at must not be more than 5 minutes in the future (clock skew or hostile file)`,
    );
  }
  const expires_at =
    fields.expires_at === undefined || fields.expires_at === null
      ? null
      : expectNumber(fields.expires_at, "expires_at", lineNo);
  if (expires_at !== null && expires_at > now + EXPIRES_MAX_MS) {
    throw new Error(`line ${lineNo}: expires_at must not be more than 10 years in the future`);
  }
  if (fields.origin_host !== undefined) {
    if (typeof fields.origin_host !== "string" || fields.origin_host.length === 0) {
      throw new Error(`line ${lineNo}: origin_host must be a non-empty string`);
    }
  }
  return {
    id,
    scope,
    kind: expectString(fields.kind, "kind", lineNo),
    title: expectString(fields.title, "title", lineNo),
    body: expectString(fields.body, "body", lineNo),
    tags: expectStringArray(fields.tags, "tags", lineNo),
    created_at,
    updated_at,
    expires_at,
    ...(typeof fields.source === "string" ? { source: fields.source } : {}),
    ...(fields.endorsed_by === undefined
      ? {}
      : { endorsed_by: expectStringArray(fields.endorsed_by, "endorsed_by", lineNo) }),
    ...(fields.origin_host !== undefined ? { origin_host: fields.origin_host as string } : {}),
    ...(project !== undefined ? { project } : {}),
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
 * lifecycle the store should keep verbatim. The entries_fts trigger indexes the row.
 * A cross-host line (stamped with an origin_host) remaps both scope keys to the
 * global markers: the peer's scope and project are paths that exist only on the
 * machine that wrote the line. `endorsed` arrives already trust-gated by the caller
 * (importPortable): verified endorsements persist, unverifiable ones stay out. */
function insertImported(
  db: MemoryDb,
  entry: Entry,
  supersedes: string | undefined,
  options: { crossHost?: boolean; endorsed?: string[] } = {},
): void {
  const crossHost = options.crossHost === true;
  const endorsed = options.endorsed;
  db.conn.run(
    "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at, source, paths, commit_sha, supersedes, status, superseded_at, deleted_at, project, endorsed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    [
      entry.id,
      crossHost ? "global" : entry.scope,
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
      crossHost ? null : (entry.project ?? null),
      endorsed !== undefined && endorsed.length > 0 ? JSON.stringify(endorsed) : null,
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
