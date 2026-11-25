import { randomUUID } from "node:crypto";
import { isAbsolute, sep } from "node:path";

import type { MemoryDb } from "./db.js";
import { isEntryFresh } from "./git.js";
import type { Entry, EntryInput } from "../types/entry.js";

const TITLE_MAX = 120;
const BODY_MAX = 8000;
const TAGS_MAX = 12;
export const TAG_MAX = 64;
export const KIND_MAX = 64;
/** Hard ceiling on how many entries one read can return, whatever the caller asks. */
export const MAX_LIMIT = 50;
/** A rendered body is a preview, never the full text: it bounds a tool result. */
export const BODY_PREVIEW_MAX = 500;

/** A lesson re-recorded this many times (the first save counts) is hot: the
 * inventory injects it before everything else, outside the character budget. */
export const HOT_THRESHOLD = 2;

export const DEFAULT_LIMIT = { search: 5, list: 10 };

/** Scope used when no worktree and no directory is known, so rows stay addressable. */
export const FALLBACK_SCOPE = "/";

/** How long a trashed entry stays restorable before a sweep drops it for good. A
 * recoverable delete is worthless if the trash itself grows without bound. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Live rows only: a trashed entry is invisible to every read until it is restored. */
const LIVE = "deleted_at IS NULL";

// High-confidence credential formats only: a generic "password =" rule would block
// ordinary prose. Extend with care, one false positive costs a legitimate save.
// The three patterns whose tail class allows `_` or `-` (github_pat_, gl(pat|rt)- and
// ya29.) demand a digit or an uppercase letter in the tail: without it, a sentence written
// as one long token after the prefix is refused as a credential. The older sk-, AIza and
// xox[ap]- patterns keep their original shape and carry the same false-positive class;
// left as they are to keep this change focused.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI-style, also covers Anthropic sk-ant- keys
  /\bgh[posur]_[A-Za-z0-9]{30,}\b/, // GitHub PAT, OAuth, server-to-server, user-to-server, refresh
  /\bgithub_pat_(?=[A-Za-z0-9_]*[0-9A-Z])[A-Za-z0-9_]{22,}\b/, // GitHub fine-grained PAT
  /\bxoxb-\d{10,}-\d{10,}\b/, // Slack bot token
  /\bxox[ap]-[0-9A-Za-z-]{10,}/, // Slack user / app token
  /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+/, // Slack incoming webhook
  /\bA(?:K|S)IA[0-9A-Z]{16}\b/, // AWS access key id, long-lived and temporary
  /\bgl(?:pat|rt)-(?=[0-9A-Za-z_-]*[0-9A-Z])[0-9A-Za-z_-]{20,}\b/, // GitLab PAT and rotate token
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm granular token
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bya29\.(?=[0-9A-Za-z_-]*[0-9A-Z])[0-9A-Za-z_-]{20,}\b/, // Google OAuth access token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key block header
];

export class SecretDetectedError extends Error {
  constructor() {
    super("entry body looks like a credential; secrets must never be stored in memory");
    this.name = "SecretDetectedError";
  }
}

/**
 * One canonical scope string for one location. Callers hand in a worktree, a
 * directory, or both, so an entry written by either plugin entry point is found
 * by the other.
 */
export function canonicalScope(...candidates: Array<string | undefined>): string {
  const first = candidates.find((c) => typeof c === "string" && c.trim().length > 0);
  if (first === undefined) {
    return FALLBACK_SCOPE;
  }
  return first.trim().replace(/\/+$/, "") || FALLBACK_SCOPE;
}

/** Bound on the per-project scope value stored on an entry (the portable format
 * shares the bound, so a row always round-trips). */
export const PROJECT_MAX = 512;

/** One canonical project value for one entry: trimmed, trailing slashes dropped,
 * `undefined` when nothing usable remains — and undefined is the store's global
 * marker (the entry injects in every project). */
export function canonicalProject(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Field rules shared by saves and portable imports: bounds on title, body, kind, tags,
 * plus the shape of anchored paths and commit refs. Throws a TypeError naming the rule. */
export function validateEntry(input: EntryInput): void {
  if (input.title.length === 0 || input.title.length > TITLE_MAX) {
    throw new TypeError(`title must be 1..${TITLE_MAX} characters`);
  }
  if (input.body.length > BODY_MAX) {
    throw new TypeError(`body must be at most ${BODY_MAX} characters`);
  }
  if (input.kind.length === 0 || input.kind.length > KIND_MAX) {
    throw new TypeError(`kind must be 1..${KIND_MAX} characters`);
  }
  if (input.tags.length > TAGS_MAX) {
    throw new TypeError(`at most ${TAGS_MAX} tags allowed`);
  }
  // A tool result stays bounded, so a tag cannot smuggle an unbounded payload either.
  if (input.tags.some((tag) => tag.length > TAG_MAX)) {
    throw new TypeError(`each tag must be at most ${TAG_MAX} characters`);
  }
  if (input.paths !== undefined) {
    if (input.paths.length > 20) {
      throw new TypeError("at most 20 paths allowed");
    }
    for (const path of input.paths) {
      assertProjectPath(path, "paths");
    }
  }
  if (input.content_hashes !== undefined) {
    const keys = Object.keys(input.content_hashes);
    if (keys.length > 20) {
      throw new TypeError("at most 20 paths allowed");
    }
    for (const key of keys) {
      assertProjectPath(key, "content_hashes keys");
      if (!/^[0-9a-f]{40}$/.test(input.content_hashes[key] ?? "")) {
        throw new TypeError("content_hashes values must be git blob shas (40 hex)");
      }
    }
  }
  if (input.commit_sha !== undefined && !/^[0-9a-f]{7,64}$/i.test(input.commit_sha)) {
    throw new TypeError("commit_sha must be a git sha (7..64 hex)");
  }
  if (input.repo_root !== undefined) {
    if (input.repo_root.length === 0 || input.repo_root.length > 500) {
      throw new TypeError("repo_root must be 1..500 characters");
    }
    if (input.repo_root.endsWith(sep) || input.repo_root.endsWith("/")) {
      throw new TypeError("repo_root must not end with a path separator");
    }
  }
  if (input.project !== undefined) {
    if (input.project.length === 0 || input.project.length > PROJECT_MAX) {
      throw new TypeError(`project must be 1..${PROJECT_MAX} characters`);
    }
  }
  if (looksLikeSecret(input)) {
    throw new SecretDetectedError();
  }
}

/** Whether any high-confidence credential pattern matches one of the entry's text
 * fields. Shared by saves, portable exports and portable imports, so the three paths
 * can never drift apart on what counts as a secret. */
export function looksLikeSecret(
  input: Pick<EntryInput, "title" | "kind" | "body" | "tags">,
): boolean {
  return SECRET_PATTERNS.some((pattern) => matchesSecretPattern(input, pattern));
}

/** Shape rule for one anchored path (paths and content_hashes keys share it).
 * Throws a TypeError naming the field. */
function assertProjectPath(path: string, field: string): void {
  if (
    path.length === 0 ||
    path.length > 500 ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..") ||
    /[\0\r\n]/.test(path)
  ) {
    throw new TypeError(
      `${field} must be relative project paths (no '.. ', no absolute, max 500 chars)`,
    );
  }
}

function matchesSecretPattern(
  input: Pick<EntryInput, "title" | "kind" | "body" | "tags">,
  pattern: RegExp,
): boolean {
  if (pattern.test(input.title) || pattern.test(input.kind) || pattern.test(input.body)) {
    return true;
  }
  return input.tags.some((t) => pattern.test(t));
}

/** A model-supplied limit is untrusted: SQLite reads a negative LIMIT as unbounded,
 * so anything below one falls back to the default, and anything above the store
 * ceiling is clamped. */
export function clampLimit(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return fallback;
  }
  return Math.min(Math.trunc(requested), MAX_LIMIT);
}

function previewBody(body: string): string {
  if (body.length <= BODY_PREVIEW_MAX) {
    return body;
  }
  // Cut on the last word boundary inside the budget so a preview never ends
  // mid-word; a body with no break inside the budget is cut hard instead.
  const cut = body.slice(0, BODY_PREVIEW_MAX);
  const boundary = cut.search(/\s[\S]*$/);
  const head = boundary === -1 ? cut : cut.slice(0, boundary).trimEnd();
  return `${head}…`;
}

/** Newlines collapse to spaces: a one-line-per-hit result must stay one line. */
function flatten(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/**
 * Model-facing rendering of a result set: one stable line per entry, headed by the
 * 8-char id prefix the caller copies into memory_get. Metadata rides as a suffix only
 * when it says something (hot, stale anchoring, first anchored path, truncated body),
 * so a plain short hit costs ~120 chars instead of a full JSON object. A truncated
 * hit carries its real body length in `truncated`: the full text comes from memory_get.
 */
export function renderEntries(entries: Entry[], options: { directory?: string } = {}): string {
  return entries
    .map((entry) => {
      let line = `${entry.id.slice(0, 8)} ${entry.kind} ${flatten(entry.title)} — ${flatten(previewBody(entry.body))}`;
      if ((entry.heat ?? 0) >= HOT_THRESHOLD) {
        line += " · hot";
      }
      if (options.directory !== undefined && !isEntryFresh(entry, options.directory)) {
        line += " · stale";
      }
      if (entry.paths !== undefined && entry.paths.length > 0) {
        line += ` · ${entry.paths[0]}`;
      }
      if (entry.body.length > BODY_PREVIEW_MAX) {
        line += ` · truncated:${entry.body.length}`;
      }
      return line;
    })
    .join("\n");
}

export function sweep(db: MemoryDb, options: { now?: number } = {}): number {
  const now = options.now ?? Date.now();
  db.conn.run("DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?", [now]);
  const expired = changesOf(db);
  db.conn.run("DELETE FROM entries WHERE deleted_at IS NOT NULL AND deleted_at <= ?", [
    now - TRASH_RETENTION_MS,
  ]);
  return expired + changesOf(db);
}

function changesOf(db: MemoryDb): number {
  return db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
}

/** Whether a save inserted a row or rewrote the one already holding that scope and
 * title, so a caller can tell the model what actually happened. `superseded` names the
 * entry the save replaced through an explicit `supersedes`. */
export type SaveResult = { entry: Entry; created: boolean; superseded?: string };

export function save(db: MemoryDb, input: EntryInput, options: { now?: number } = {}): Entry {
  return saveEntry(db, input, options).entry;
}

export function saveEntry(
  db: MemoryDb,
  input: EntryInput,
  options: { now?: number } = {},
): SaveResult {
  validateEntry(input);
  const scope = canonicalScope(input.scope);
  const project = canonicalProject(input.project);
  const now = options.now ?? Date.now();

  // Expired rows are dead weight in search, so drop them with the save.
  sweep(db, { now });

  // An explicit supersedes replaces one named entry: the old row stays as a superseded
  // tombstone and the save inserts a fresh current row carrying the link. The target
  // must exist, be live and belong to the save's scope, or the link is a mistake the
  // caller hears about instead of a silent cross-project rewrite.
  // ponytail: the read-then-update-then-insert is not transactional, so two concurrent
  // saves naming the same target can both claim it. Ceiling is a double tombstone, not
  // data loss. Upgrade path: BEGIN IMMEDIATE around the whole save.
  let supersededId: string | undefined;
  let supersededEndorsedBy: string | null = null;
  if (input.supersedes !== undefined) {
    const target = db.conn.get<{ id: string; endorsed_by: string | null }>(
      `SELECT id, endorsed_by FROM entries WHERE id = ? AND scope = ? AND ${LIVE}`,
      [input.supersedes, scope],
    );
    if (target === null) {
      throw new TypeError("supersedes must name a live entry of the same scope");
    }
    db.conn.run("UPDATE entries SET status = 'superseded', superseded_at = ? WHERE id = ?", [
      now,
      target.id,
    ]);
    supersededId = target.id;
    supersededEndorsedBy = target.endorsed_by;
  }

  // A repeated title in the same scope is the same knowledge: rewrite it instead of
  // stacking duplicates. Superseding skips the rewrite on purpose: the named entry is
  // tombstoned and a fresh row takes over, even when the titles coincide.
  // ponytail: SQLite lower() folds ASCII only, so a non-ASCII title re-saved in a
  // different case is not deduped; and the read-then-write is not transactional, so two
  // concurrent saves of the same title can both insert. Ceiling is a rare duplicate, not
  // data loss. Upgrade path: a normalized key column plus BEGIN IMMEDIATE.
  const existing =
    input.supersedes === undefined
      ? db.conn.get<{ id: string; created_at: number; heat: number; endorsed_by: string | null }>(
          `SELECT id, created_at, heat, endorsed_by FROM entries WHERE scope = ? AND lower(trim(title)) = ? AND status = 'current' AND ${LIVE}`,
          [scope, input.title.trim().toLowerCase()],
        )
      : null;

  if (existing) {
    // Re-recording a lesson is the recurrence signal: every rewrite of a lesson
    // row heats it up by one. Other kinds leave the counter untouched.
    const heat = existing.heat + (input.kind === "lesson" ? 1 : 0);
    // A shareable re-save records the author's endorsement; existing endorsements
    // (author or peers) are never dropped by a rewrite.
    const endorsers = mergeEndorsement(parseStringArray(existing.endorsed_by ?? "[]"), input);
    db.conn.run(
      "UPDATE entries SET kind = ?, body = ?, tags = ?, updated_at = ?, expires_at = ?, source = ?, paths = ?, commit_sha = ?, content_hashes = ?, repo_root = ?, heat = ?, endorsed_by = ? WHERE id = ?",
      [
        input.kind,
        input.body,
        JSON.stringify(input.tags),
        now,
        input.expires_at ?? null,
        input.source ?? null,
        JSON.stringify(input.paths ?? []),
        input.commit_sha ?? null,
        input.content_hashes === undefined ? null : JSON.stringify(input.content_hashes),
        input.repo_root ?? null,
        heat,
        endorsers.length > 0 ? JSON.stringify(endorsers) : null,
        existing.id,
      ],
    );
    return {
      entry: {
        id: existing.id,
        scope,
        ...(project !== undefined ? { project } : {}),
        kind: input.kind,
        title: input.title,
        body: input.body,
        tags: input.tags,
        created_at: existing.created_at,
        updated_at: now,
        expires_at: input.expires_at,
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.paths !== undefined ? { paths: input.paths } : {}),
        ...(input.commit_sha !== undefined ? { commit_sha: input.commit_sha } : {}),
        ...(input.content_hashes !== undefined ? { content_hashes: input.content_hashes } : {}),
        ...(input.repo_root !== undefined ? { repo_root: input.repo_root } : {}),
        ...(endorsers.length > 0 ? { endorsed_by: endorsers } : {}),
        ...(heat > 0 ? { heat } : {}),
        status: "current",
      },
      created: false,
    };
  }

  const id = randomUUID();
  // A brand-new lesson starts hot-adjacent (heat 1): the first re-record tips it
  // over HOT_THRESHOLD. Other kinds start at the column default, 0.
  const heat = input.kind === "lesson" ? 1 : 0;
  // The superseded row's peer endorsements carry to the replacement: refining shared
  // knowledge must not drop it from the next outbox push. Only peers of the NEW source
  // carry — the author re-endorsing their own rewrite is exactly the anti-amplification
  // guard, and their shareable-at-save marker stays the only self-endorsement.
  // Author-published entries (shareable at save) carry the author's endorsement.
  const peerEndorsers =
    supersededEndorsedBy === null
      ? []
      : parseStringArray(supersededEndorsedBy).filter(
          (endorser) => endorserName(endorser) !== input.source,
        );
  const endorsers = mergeEndorsement(peerEndorsers, input);
  db.conn.run(
    "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at, source, paths, commit_sha, content_hashes, repo_root, supersedes, status, superseded_at, heat, endorsed_by, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      scope,
      input.kind,
      input.title,
      input.body,
      JSON.stringify(input.tags),
      now,
      now,
      input.expires_at,
      input.source ?? null,
      JSON.stringify(input.paths ?? []),
      input.commit_sha ?? null,
      input.content_hashes === undefined ? null : JSON.stringify(input.content_hashes),
      input.repo_root ?? null,
      input.supersedes ?? null,
      "current",
      null,
      heat,
      endorsers.length > 0 ? JSON.stringify(endorsers) : null,
      project ?? null,
    ],
  );

  return {
    entry: {
      id,
      scope,
      ...(project !== undefined ? { project } : {}),
      kind: input.kind,
      title: input.title,
      body: input.body,
      tags: input.tags,
      created_at: now,
      updated_at: now,
      expires_at: input.expires_at,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
      ...(input.commit_sha !== undefined ? { commit_sha: input.commit_sha } : {}),
      ...(input.content_hashes !== undefined ? { content_hashes: input.content_hashes } : {}),
      ...(input.repo_root !== undefined ? { repo_root: input.repo_root } : {}),
      ...(endorsers.length > 0 ? { endorsed_by: endorsers } : {}),
      ...(heat > 0 ? { heat } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      status: "current",
    },
    created: true,
    ...(supersededId !== undefined ? { superseded: supersededId } : {}),
  };
}

/** The entry's endorsers plus the author's own when the save publishes it. */
function mergeEndorsement(endorsers: string[], input: EntryInput): string[] {
  if (
    input.shareable !== true ||
    input.source === undefined ||
    endorsers.some((endorser) => endorserName(endorser) === input.source)
  ) {
    return endorsers;
  }
  return [...endorsers, input.source];
}

/** The agent an endorser stands for: the rich `agent@<fingerprint>` stamp (the node
 * identity an endorsement binds to since 0.24.0) reduces to the agent name. */
function endorserName(endorser: string): string {
  const match = /^(.*)@([0-9a-f]{16})$/.exec(endorser);
  return match?.[1] ?? endorser;
}

/**
 * One endorsement appended to the entry's `endorsed_by`. Idempotent per endorser, and
 * the endorsement is the share signal: any endorser other than the entry's author makes
 * it shareable. `null` when the id is not a live current row; `created` is false when
 * this endorser had already endorsed.
 *
 * When the caller wires the node's mesh fingerprint, the endorser is stamped in the
 * rich `agent@<fingerprint>` form: the endorsement binds to the node identity, which
 * the cross-host sync can verify against the transport-proven sending node. Without
 * a fingerprint the plain legacy form is kept — valid locally, never shareable
 * cross-host.
 */
export function endorseEntry(
  db: MemoryDb,
  target: { id: string; endorser: string; fingerprint?: string },
): { entry: Entry; created: boolean; shareable: boolean } | null {
  const row = db.conn.get<Row>(
    `SELECT * FROM entries WHERE id = ? AND status = 'current' AND ${LIVE}`,
    [target.id],
  );
  if (row === null) {
    return null;
  }
  const stamped =
    target.fingerprint === undefined ? target.endorser : `${target.endorser}@${target.fingerprint}`;
  const endorsers = parseStringArray(row.endorsed_by ?? "[]");
  const created = !endorsers.includes(stamped);
  if (created) {
    endorsers.push(stamped);
    db.conn.run("UPDATE entries SET endorsed_by = ? WHERE id = ?", [
      JSON.stringify(endorsers),
      target.id,
    ]);
  }
  const entry = rowToEntry({ ...row, endorsed_by: JSON.stringify(endorsers) });
  return { entry, created, shareable: isShareable(entry) };
}

/** An entry is worth sharing once someone other than its author vouched for it; the
 * author's own endorsement (the shareable-at-save marker) never qualifies alone. The
 * agent is compared by name: a rich `agent@<fingerprint>` stamp of the author is still
 * the author. */
export function isShareable(entry: Entry): boolean {
  return (entry.endorsed_by ?? []).some((endorser) => endorserName(endorser) !== entry.source);
}

/**
 * Candidates an explicit `supersedes` could replace, for saves that do not name one:
 * FTS over the title tokens (strict matches first, prefix matches fill the rest), same
 * kind, same scope, current rows only, minus the row the title rewrite already handles.
 * The store never replaces on its own: the list only arms the caller's report.
 *
 * ponytail: the ranked FTS pass scores every match, so a very broad prefix on a huge
 * store pays per match; the rowid fetch and the JS filters keep the per-save cost flat
 * at hundreds of entries. Upgrade path: window the FTS scan when stores grow past that.
 */
export function suggestReplacements(
  db: MemoryDb,
  query: { scope: string; kind: string; title: string; excludeId?: string },
  limit = 3,
): Entry[] {
  const scope = canonicalScope(query.scope);
  const cap = clampLimit(limit, 3);
  const title = query.title.trim().toLowerCase();

  // Two indexed steps instead of one filtered join: SQLite drives a filtered join from
  // the entries side and re-runs the MATCH once per row, which turns every suggestion
  // into a scan of the scope. Rank inside FTS (indexed), filter in JS: both stay flat.
  const hits: Entry[] = [];
  const seen = new Set<string>();
  for (const match of searchCandidates(query.title)) {
    const ranked = db.conn.all<{ rowid: number }>(
      "SELECT rowid FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?",
      [match, MAX_LIMIT],
    );
    if (ranked.length === 0) {
      continue;
    }
    const ids = ranked.map((row) => row.rowid);
    const rows = db.conn.all<Row & { rid: number }>(
      `SELECT rowid AS rid, * FROM entries WHERE rowid IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );
    const byRowid = new Map(rows.map((row) => [row.rid, row]));
    for (const { rowid } of ranked) {
      const row = byRowid.get(rowid);
      if (
        row === undefined ||
        row.kind !== query.kind ||
        row.scope !== scope ||
        row.status !== "current" ||
        row.deleted_at !== null ||
        row.title.trim().toLowerCase() === title ||
        (query.excludeId !== undefined && row.id === query.excludeId)
      ) {
        continue;
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        hits.push(rowToEntry(row));
      }
      if (hits.length >= cap) {
        return hits;
      }
    }
  }
  return hits;
}

/**
 * Fused search. The strict pass runs first and the prefix pass only fills what is left of
 * the limit, so a query never loses the loose matches it used to discard: two entries
 * holding every token answer a limit of ten with two results today.
 *
 * A strict hit contains every token by construction, so it is definitionally stronger
 * than a prefix hit. Pinning strict above prefix is therefore the correct special case of
 * reciprocal rank fusion, without the score arithmetic.
 */
export function search(
  db: MemoryDb,
  query: { query: string; scope: string; project?: string; limit?: number; now?: number },
): Entry[] {
  const scope = canonicalScope(query.scope);
  const project = canonicalProject(query.project);
  const limit = clampLimit(query.limit, DEFAULT_LIMIT.search);
  const now = query.now ?? Date.now();

  const hits: Entry[] = [];
  const seen = new Set<string>();
  for (const match of searchCandidates(query.query)) {
    for (const entry of ftsHits(db, match, scope, project, now, limit)) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        hits.push(entry);
      }
    }
    if (hits.length >= limit) {
      break;
    }
  }
  return hits.slice(0, limit);
}

function ftsHits(
  db: MemoryDb,
  match: string,
  scope: string,
  project: string | undefined,
  now: number,
  limit: number,
): Entry[] {
  // No project filter: a search crosses projects by default; the explicit filter
  // keeps the global (unscoped) rows of the matching project too.
  const projectFilter = project === undefined ? "" : "AND (e.project IS NULL OR e.project = ?) ";
  const args =
    project === undefined ? [match, scope, now, limit] : [match, scope, project, now, limit];
  return db.conn
    .all<Row>(
      `SELECT e.* FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
       WHERE entries_fts MATCH ? AND (e.scope = ? OR e.scope = 'global')
         ${projectFilter}
         AND (e.expires_at IS NULL OR e.expires_at > ?) AND e.status = 'current' AND e.${LIVE}
       ORDER BY bm25(entries_fts) ASC, e.updated_at DESC
       LIMIT ?`,
      args,
    )
    .map(rowToEntry);
}

export function list(
  db: MemoryDb,
  query: {
    scope: string;
    project?: string;
    limit?: number;
    now?: number;
    kind?: string;
    page?: number;
  },
): Entry[] {
  const scope = canonicalScope(query.scope);
  const project = canonicalProject(query.project);
  const limit = clampLimit(query.limit, DEFAULT_LIMIT.list);
  const now = query.now ?? Date.now();
  const kindFilter = query.kind === undefined ? "" : "AND kind = ? ";
  const kindArgs = query.kind === undefined ? [] : [query.kind];
  // No project filter: list reads the whole directory scope; the injection passes
  // one so a foreign project's rows stay out of the prompt.
  const projectFilter = project === undefined ? "" : "AND (project IS NULL OR project = ?) ";
  const head = project === undefined ? [scope, now] : [scope, project, now];
  // Pages are 1-based; a nonsensical page reads as the first one instead of a
  // negative OFFSET, which SQLite would reject.
  const page =
    query.page === undefined || !Number.isFinite(query.page) || query.page < 1
      ? 1
      : Math.trunc(query.page);
  const offset = (page - 1) * limit;

  return db.conn
    .all<Row>(
      `SELECT * FROM entries
       WHERE (scope = ? OR scope = 'global') ${projectFilter}
         AND (expires_at IS NULL OR expires_at > ?) ${kindFilter}
         AND status = 'current' AND ${LIVE}
       ORDER BY updated_at DESC, id ASC
       LIMIT ? OFFSET ?`,
      [...head, ...kindArgs, limit, offset],
    )
    .map(rowToEntry);
}

/** Every live row of one scope, superseded tombstones included, oldest first: the
 * portable export carries the full lifecycle, not the current-rows-only read view. */
export function allLive(db: MemoryDb, scope: string): Entry[] {
  return db.conn
    .all<Row>(`SELECT * FROM entries WHERE scope = ? AND ${LIVE} ORDER BY created_at ASC, id ASC`, [
      canonicalScope(scope),
    ])
    .map(rowToEntry);
}

/**
 * The live rows of one scope that carry at least one endorsement: the content side of
 * the cross-host sync. Two endorsement shapes qualify, and both are recorded the same
 * way in `endorsed_by`: a peer's endorsement (someone other than the author vouched),
 * and the author's own when the save published the entry with `shareable`. An entry
 * with no endorsement at all stays local. The SQL pre-filters the column and the JS
 * guard re-checks the parsed value, so a malformed `endorsed_by` blob can never leak
 * an unendorsed row into the shareable file.
 */
export function listShareable(db: MemoryDb, scope: string): Entry[] {
  return db.conn
    .all<Row>(
      `SELECT * FROM entries WHERE scope = ? AND status = 'current' AND ${LIVE}
       AND endorsed_by IS NOT NULL AND endorsed_by != '[]'
       ORDER BY created_at ASC, id ASC`,
      [canonicalScope(scope)],
    )
    .map(rowToEntry)
    .filter((entry) => (entry.endorsed_by ?? []).length > 0);
}

/** The machine-wide twin of `listShareable`: the same live endorsed rows of EVERY
 * scope. The mesh outbox is one file per machine, so the sync export must not let
 * the calling project's scope decide what the other projects get to share. */
export function listShareableAll(db: MemoryDb): Entry[] {
  return db.conn
    .all<Row>(
      `SELECT * FROM entries WHERE status = 'current' AND ${LIVE}
       AND endorsed_by IS NOT NULL AND endorsed_by != '[]'
       ORDER BY created_at ASC, id ASC`,
    )
    .map(rowToEntry)
    .filter((entry) => (entry.endorsed_by ?? []).length > 0);
}

/** One entry by id, machine-wide (ids are globally unique), whatever its scope or
 * lifecycle. The trashed flag lets the caller tell a recoverable delete from an
 * unknown id: both answer a memory_get, but with different guidance. */
export function getById(db: MemoryDb, id: string): { entry: Entry; trashed: boolean } | null {
  const row = db.conn.get<Row>("SELECT * FROM entries WHERE id = ?", [id]);
  if (row === null) {
    return null;
  }
  return { entry: rowToEntry(row), trashed: row.deleted_at !== null };
}

/**
 * Resolve an entry id given in full or as a leading prefix (the 8-char id8 the compact
 * search and list lines hand to the model). Exact-prefix match over every stored row:
 * trashed and superseded rows stay addressable, since memory_restore needs them too.
 * `null` when nothing matches; throws naming the full candidate ids when a prefix is
 * ambiguous, so the caller reports instead of guessing a row.
 */
export function resolveIdPrefix(db: MemoryDb, prefix: string): string | null {
  const wanted = prefix.trim();
  if (wanted.length === 0) {
    return null;
  }
  const matches = db.conn
    .all<{ id: string }>("SELECT id FROM entries")
    .map((row) => row.id)
    .filter((id) => id.startsWith(wanted));
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous id prefix ${wanted}: ${matches.join(", ")}`);
  }
  return matches[0] as string;
}

export type ForgetTarget = { scope: string } & ({ id: string } | { query: string });

/** Counts by kind for one scope plus `global`, expired entries excluded. */
export function stats(
  db: MemoryDb,
  query: { scope: string; now?: number },
): Array<{ kind: string; count: number }> {
  const scope = canonicalScope(query.scope);
  const now = query.now ?? Date.now();
  return db.conn.all<{ kind: string; count: number }>(
    `SELECT kind, COUNT(*) AS count FROM entries
     WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?) AND ${LIVE}
     GROUP BY kind ORDER BY count DESC, kind ASC`,
    [scope, now],
  );
}

/** Creation date of the oldest live entry in one scope plus `global`, or null when the
 * scope is empty: the store grows without bound, so age is the signal that knowledge is
 * rotting rather than accumulating. */
export function oldestCreated(db: MemoryDb, query: { scope: string; now?: number }): number | null {
  const scope = canonicalScope(query.scope);
  const now = query.now ?? Date.now();
  const row = db.conn.get<{ oldest: number | null }>(
    `SELECT MIN(created_at) AS oldest FROM entries
     WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?) AND ${LIVE}`,
    [scope, now],
  );
  return row?.oldest ?? null;
}

/** An entry counts as used once a read served it to the model: searches touch the hits
 * and the inventory injection touches the lines it kept under its character budget. */
export function touchUsage(db: MemoryDb, ids: string[], now: number): void {
  if (ids.length === 0) {
    return;
  }
  db.conn.run(
    `UPDATE entries SET use_count = use_count + 1, last_used = ?
     WHERE id IN (${ids.map(() => "?").join(", ")})`,
    [now, ...ids],
  );
}

/** How long an entry may sit unused before the stats report proposes forgetting it:
 * the same 30 days the trash keeps, so a proposal and its tombstone share one clock. */
export const NEVER_RECALLED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Default cap on a never-recalled report; the stats section reads at most this many. */
export const NEVER_RECALLED_DEFAULT_LIMIT = 20;

/**
 * Live entries of one scope plus `global` that were never served to the model and have
 * been sitting older than `olderThanMs` (default 30 days), oldest first: the purge-on-
 * proposal list. Unanchored `lesson` entries join the list once their last recall is
 * older than the window too (they never date out of the sweep, so this report is their
 * soft cap); anchored lessons stay the anchoring's business. The store deletes nothing
 * here — the caller decides, through memory_forget, which rows deserve the trash.
 */
export function neverRecalled(
  db: MemoryDb,
  query: { scope: string; now?: number },
  options: { olderThanMs?: number; limit?: number } = {},
): Entry[] {
  const scope = canonicalScope(query.scope);
  const now = query.now ?? Date.now();
  const olderThanMs = options.olderThanMs ?? NEVER_RECALLED_AGE_MS;
  const limit = clampLimit(options.limit, NEVER_RECALLED_DEFAULT_LIMIT);
  return db.conn
    .all<Row>(
      `SELECT * FROM entries
       WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?)
         AND status != 'superseded' AND ${LIVE} AND created_at <= ?
         AND (
           use_count = 0
           OR (kind = 'lesson' AND COALESCE(paths, '') IN ('', '[]')
                AND (last_used IS NULL OR last_used <= ?))
         )
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [scope, now, now - olderThanMs, now - olderThanMs, limit],
    )
    .map(rowToEntry);
}

/**
 * Query deletes stay inside one scope (plus the shared `global` scope): a fuzzy match
 * must never silently hit other projects' entries. Id deletes are machine-wide because
 * the id is globally unique: closed worktrees stay cleanable from any project.
 *
 * Both forms trash instead of dropping, so a wrong delete is recoverable, and both report
 * the entries they moved: a broad query can take many rows at once, and the caller has to
 * be able to say which ones. Only live rows count, so a second delete of the same target
 * is a no-op.
 */
export function forget(db: MemoryDb, target: ForgetTarget): Entry[] {
  const trashed =
    "id" in target
      ? db.conn.all<Row>(`SELECT * FROM entries WHERE id = ? AND ${LIVE}`, [target.id])
      : trashedByQuery(db, target);

  if (trashed.length === 0) {
    return [];
  }
  const now = Date.now();
  const ids = trashed.map((row) => row.id);
  db.conn.run(`UPDATE entries SET deleted_at = ? WHERE id IN (${ids.map(() => "?").join(", ")})`, [
    now,
    ...ids,
  ]);
  return trashed.map(rowToEntry);
}

/** Puts a trashed entry back into every read. Machine-wide by id, mirroring the delete it
 * undoes; `null` when the id is not in the trash. A superseded entry is restorable too:
 * it comes back as `current` and its replacement steps down to `superseded`, so the two
 * states stay coherent. */
export function restore(db: MemoryDb, target: { id: string }): Entry | null {
  const row = db.conn.get<Row>(
    `SELECT * FROM entries WHERE id = ? AND (deleted_at IS NOT NULL OR status = 'superseded')`,
    [target.id],
  );
  if (row === null) {
    return null;
  }
  const now = Date.now();
  if (row.deleted_at !== null) {
    db.conn.run("UPDATE entries SET deleted_at = NULL WHERE id = ?", [target.id]);
  }
  if (row.status === "superseded") {
    db.conn.run("UPDATE entries SET status = 'current', superseded_at = NULL WHERE id = ?", [
      target.id,
    ]);
    // Every current row that claims this one is its replacement loses the crown; a
    // single statement keeps the rare two-claimants case coherent too.
    db.conn.run(
      `UPDATE entries SET status = 'superseded', superseded_at = ? WHERE supersedes = ? AND status = 'current' AND ${LIVE}`,
      [now, target.id],
    );
  }
  return rowToEntry(row);
}

function trashedByQuery(db: MemoryDb, target: { query: string; scope: string }): Row[] {
  const scope = canonicalScope(target.scope);

  // Deleting is precision-first: only the strict all-token match, never the fuzzy
  // fallback. A wrong read costs the model a retry, a wrong delete used to be
  // unrecoverable; it now costs a restore.
  const match = strictMatch(target.query);
  if (match === null) {
    return [];
  }
  return db.conn.all<Row>(
    `SELECT e.* FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
     WHERE entries_fts MATCH ? AND (e.scope = ? OR e.scope = 'global') AND e.${LIVE}`,
    [match, scope],
  );
}

type Row = Omit<Entry, "tags" | "source" | "endorsed_by"> & {
  tags: string;
  source: string | null;
  endorsed_by: string | null;
  deleted_at: number | null;
};

function rowToEntry(row: Row): Entry {
  const endorsers =
    row.endorsed_by === null || row.endorsed_by === undefined
      ? []
      : parseStringArray(row.endorsed_by);
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseStringArray(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.paths !== null && row.paths !== undefined
      ? { paths: JSON.parse(String(row.paths)) as string[] }
      : {}),
    ...(row.commit_sha !== null && row.commit_sha !== undefined
      ? { commit_sha: String(row.commit_sha) }
      : {}),
    ...(row.content_hashes !== null && row.content_hashes !== undefined
      ? { content_hashes: parseHashes(String(row.content_hashes)) }
      : {}),
    ...(row.repo_root !== null && row.repo_root !== undefined
      ? { repo_root: String(row.repo_root) }
      : {}),
    ...(row.supersedes !== null && row.supersedes !== undefined
      ? { supersedes: row.supersedes }
      : {}),
    ...(row.status !== null && row.status !== undefined ? { status: row.status } : {}),
    ...(row.superseded_at !== null && row.superseded_at !== undefined
      ? { superseded_at: row.superseded_at }
      : {}),
    ...(row.heat !== null && row.heat !== undefined && row.heat > 0 ? { heat: row.heat } : {}),
    ...(endorsers.length > 0 ? { endorsed_by: endorsers } : {}),
    ...(row.project !== null && row.project !== undefined && row.project !== ""
      ? { project: row.project }
      : {}),
  };
}

/** JSON object column decoded leniently: a malformed payload or a non-string
 * value is dropped instead of crashing a read; an unreadable blob reads as an
 * empty stamp, which the freshness check treats as absent. */
function parseHashes(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const hashes: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && /^[0-9a-f]{40}$/.test(value)) {
        hashes[key] = value;
      }
    }
    return hashes;
  } catch {
    return {};
  }
}

/** JSON array column decoded leniently: a malformed or non-string payload reads as
 * empty instead of crashing a read. */
function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * FTS5 candidates, most precise first, each quoted so arbitrary model input stays a
 * literal search. The strict AND match is fused ahead of the looser prefix OR match:
 * precision leads, recall fills what is left of the limit.
 */
function searchCandidates(raw: string): string[] {
  const strict = strictMatch(raw);
  const loose = prefixMatch(raw);
  return [strict, loose].filter((candidate): candidate is string => candidate !== null);
}

/** Every token must appear. Used alone by destructive paths, where a false positive
 * cannot be undone. */
function strictMatch(raw: string): string | null {
  const tokens = tokenize(raw);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"`).join(" ");
}

/** Any token may match, each as a prefix. Read-only recall only. */
function prefixMatch(raw: string): string | null {
  const tokens = tokenize(raw);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}" *`).join(" OR ");
}

function tokenize(raw: string): string[] {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replaceAll('"', ""));
}
