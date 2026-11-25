import { existsSync } from "node:fs";

import { databaseSizeBytes, type MemoryDb } from "./db.js";
import { contentHashes, currentCommitHash, isEntryFresh } from "./git.js";
import { exportPortable, importPortable, resolvePortablePath } from "./portable.js";
import {
  endorseEntry,
  forget,
  getById,
  HOT_THRESHOLD,
  list,
  neverRecalled,
  oldestCreated,
  renderEntries,
  resolveIdPrefix,
  restore,
  saveEntry,
  search,
  SecretDetectedError,
  stats,
  suggestReplacements,
  touchUsage,
} from "./store.js";
import { runHousekeepingPass, type HousekeepingReport } from "./housekeeping.js";
import type { Entry } from "../types/entry.js";

// Optional properties accept undefined explicitly: the two SDK dialects hand raw
// tool arguments straight through, and the build enables exactOptionalPropertyTypes.
export type SaveArgs = {
  kind: string;
  title: string;
  body: string;
  tags?: string[] | undefined;
  expires_at?: number | null | undefined;
  source?: string | undefined;
  /** Files the entry documents (relative project paths): the entry is stale
   * when any of them changes after the save commit. */
  paths?: string[] | undefined;
  /** Repository commit the entry was written against (auto-captured at save
   * from the project directory when paths are anchored). */
  commit_sha?: string | undefined;
  /** Id of the entry this one replaces: the old row is kept as a superseded
   * tombstone instead of stacking a near-duplicate. */
  supersedes?: string | undefined;
  /** Publish without peer endorsement: the author vouches, and the save records the
   * author's own endorsement in `endorsed_by`. */
  shareable?: boolean | undefined;
  /** Explicit project scope override. When absent the CALLER deduces the entry's
   * project from the session (and passes it here); `undefined` = global. */
  project?: string | undefined;
};
export type SearchArgs = {
  query: string;
  project?: string | undefined;
  limit?: number | undefined;
};
export type ListArgs = { limit?: number | undefined; page?: number | undefined };
export type GetArgs = { id: string };
export type ForgetArgs = { id?: string | undefined; query?: string | undefined };
export type RestoreArgs = { id: string };
export type EndorseArgs = { id: string; endorser?: string | undefined };
export type ExportArgs = {
  scope?: string | undefined;
  path?: string | undefined;
  /** Export only entries worth sharing cross-host: at least one endorsement. */
  shareable?: boolean | undefined;
};
export type ImportArgs = { path?: string | undefined };
export type SweepArgs = { scope?: string | undefined; ttl_days?: number | undefined };

/** One shared behaviour behind both plugin entry points. Every operation returns the
 * model-facing text directly, so a caller cannot bypass caps or error handling. */
export type MemoryOps = {
  save: (
    args: SaveArgs,
    scope: string,
    source?: string,
    options?: { directory?: string },
  ) => string;
  search: (args: SearchArgs, scope: string, options?: { directory?: string }) => string;
  list: (args: ListArgs, scope: string, options?: { directory?: string }) => string;
  get: (args: GetArgs) => string;
  forget: (args: ForgetArgs, scope: string) => string;
  stats: (scope: string) => string;
  restore: (args: RestoreArgs) => string;
  endorse: (args: EndorseArgs, contextAgent?: string) => string;
  exportEntries: (args: ExportArgs, scope: string) => string;
  importEntries: (args: ImportArgs, scope: string) => string;
  sweep: (args: SweepArgs, scope: string, options?: { directory?: string }) => string;
};

export function createMemoryOps(
  getDb: () => MemoryDb,
  options: { onLessonSaved?: () => void; fingerprint?: () => string | undefined } = {},
): MemoryOps {
  return {
    save: (args, scope, source, saveOptions = {}) =>
      run(() => {
        // Auto-anchor: with anchored paths and no explicit commit, one git call
        // captures the HEAD the entry was written against: the save is then
        // fully anchored (paths + commit) and the cooling can apply. Outside a
        // repository, or without paths, the entry keeps its previous shape.
        const autoCommit =
          args.paths !== undefined && args.paths.length > 0 && saveOptions.directory !== undefined
            ? currentCommitHash(saveOptions.directory)
            : undefined;
        const commit_sha = args.commit_sha ?? autoCommit;
        // Content stamp: the git blob hash of each anchored path at save time,
        // captured when the directory is a repository (the commit capture
        // succeeded). A save made on a dirty tree (agent edited files, not
        // committed yet) or on an untracked file anchors by content, so the
        // entry is fresh at creation and stale only when a file really changes.
        // A missing path (or a non-repository directory) leaves the entry on
        // the commit-only check, which already treats a missing path as stale.
        const content_hashes =
          autoCommit !== undefined &&
          args.paths !== undefined &&
          args.paths.length > 0 &&
          saveOptions.directory !== undefined
            ? contentHashes(saveOptions.directory, args.paths)
            : undefined;
        // An 8-char id prefix is accepted wherever a full id is; an unresolvable
        // prefix keeps its original text so the store names the mistake itself.
        const supersedes =
          args.supersedes === undefined
            ? undefined
            : (resolveIdPrefix(getDb(), args.supersedes) ?? args.supersedes);
        const { entry, created, superseded } = saveEntry(getDb(), {
          scope,
          kind: args.kind,
          title: args.title,
          body: args.body,
          tags: args.tags ?? [],
          expires_at: args.expires_at ?? null,
          ...(source !== undefined ? { source } : {}),
          ...(args.paths !== undefined ? { paths: args.paths } : {}),
          ...(commit_sha !== undefined ? { commit_sha: commit_sha } : {}),
          ...(content_hashes !== undefined ? { content_hashes: content_hashes } : {}),
          ...(supersedes !== undefined ? { supersedes: supersedes } : {}),
          ...(args.shareable !== undefined ? { shareable: args.shareable } : {}),
          ...(args.project !== undefined ? { project: args.project } : {}),
        });
        // Only a row that reached HOT re-injects: rebuilding the inventory changes
        // the system prefix and misses the prompt cache, so ordinary lessons reach
        // live sessions through memory_search — a hot récidive is rare enough to
        // pay the miss for its next-turn injection.
        if ((entry.heat ?? 0) >= HOT_THRESHOLD) {
          options.onLessonSaved?.();
        }
        let text = `saved ${entry.id} (${entry.scope}, ${created ? "created" : "updated"})`;
        if (superseded !== undefined) {
          text += `; replaced ${superseded}`;
        } else if (args.supersedes === undefined) {
          // The store stays pure: without an explicit supersedes the answer only names
          // the current entries worth replacing, and the agent decides.
          const similar = suggestReplacements(
            getDb(),
            {
              scope: entry.scope,
              kind: entry.kind,
              title: entry.title,
              excludeId: entry.id,
            },
            SIMILAR_REPORT_MAX,
          );
          if (similar.length > 0) {
            const listed = similar
              .map((candidate) => `${candidate.id} (${JSON.stringify(candidate.title)})`)
              .join(", ");
            text += `\nsimilar entries: ${listed} - use supersedes=${similar[0]?.id} to replace`;
          }
        }
        return text;
      }),
    search: (args, scope, renderOptions = {}) =>
      run(() => {
        const hits = search(getDb(), {
          query: args.query,
          scope,
          ...(args.project !== undefined ? { project: args.project } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        // Entries served to the model count as used: this is what keeps them off the
        // never-recalled purge proposal.
        if (hits.length > 0) {
          touchUsage(
            getDb(),
            hits.map((hit) => hit.id),
            Date.now(),
          );
        }
        return hits.length === 0
          ? "no matching memory entries"
          : `scope ${scope} · ${hits.length} hits\n${renderEntries(hits, renderOptions)}`;
      }),
    list: (args, scope, renderOptions = {}) =>
      run(() => {
        const entries = list(getDb(), {
          scope,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.page !== undefined ? { page: args.page } : {}),
        });
        if (entries.length === 0) {
          return "no memory entries";
        }
        const page =
          args.page !== undefined && args.page > 1 ? ` (page ${Math.trunc(args.page)})` : "";
        return `scope ${scope} · ${entries.length} entries${page}\n${renderEntries(entries, renderOptions)}`;
      }),
    get: (args) =>
      run(() => {
        const id = resolveIdPrefix(getDb(), args.id) ?? args.id;
        const found = getById(getDb(), id);
        if (found === null) {
          return "no entry with that id";
        }
        if (found.trashed) {
          return "entry is in the trash (restorable for 30 days): use memory_restore to put it back";
        }
        // A full read serves the entry to the model, same as a search hit does.
        touchUsage(getDb(), [id], Date.now());
        return renderFullEntry(found.entry);
      }),
    forget: (args, scope) =>
      run(() => {
        const removed =
          args.id !== undefined
            ? forget(getDb(), { id: resolveIdPrefix(getDb(), args.id) ?? args.id, scope })
            : args.query !== undefined
              ? forget(getDb(), { query: args.query, scope })
              : null;
        if (removed === null) {
          return "provide id or query";
        }
        if (removed.length === 0) {
          return "deleted 0 entries";
        }
        const plural = removed.length === 1 ? "y" : "ies";
        return `deleted ${removed.length} entr${plural}: ${renderRemoved(removed)}`;
      }),
    stats: (scope) =>
      run(() => {
        const counts = stats(getDb(), { scope });
        if (counts.length === 0) {
          return "no memory entries";
        }
        const total = counts.reduce((sum, row) => sum + row.count, 0);
        const oldest = oldestCreated(getDb(), { scope });
        const size = formatBytes(databaseSizeBytes(getDb()));
        const age = oldest === null ? "" : `, oldest: ${dayOf(oldest)}`;
        let text = `store: ${size}${age}, ${counts
          .map((row) => `${row.kind}: ${row.count}`)
          .join(", ")}, total: ${total}`;
        // Purge on proposal only: the store never deletes on its own, the agent or the
        // user decides which never-recalled entries deserve memory_forget.
        const never = neverRecalled(getDb(), { scope });
        if (never.length > 0) {
          text += `\nnever-recalled: ${never.length} (${renderRemoved(never)}) - no recall in 30 days or more; propose memory_forget for the ones that are no longer useful`;
        }
        return text;
      }),
    restore: (args) =>
      run(() => {
        const entry = restore(getDb(), { id: resolveIdPrefix(getDb(), args.id) ?? args.id });
        return entry === null
          ? "no entry with that id"
          : `restored ${JSON.stringify(entry.title)} (${entry.id})`;
      }),
    endorse: (args, contextAgent) =>
      run(() => {
        const endorser = args.endorser ?? contextAgent;
        if (endorser === undefined || endorser.trim().length === 0) {
          return "error: endorser required (no agent in this context)";
        }
        // The node identity stamp (0.24.0): wired by the plugin from the mesh's
        // node.json, absent in tests and on machines without the mesh — the
        // plain legacy form stays, valid locally, never shareable cross-host.
        const fingerprint = options.fingerprint?.();
        const result = endorseEntry(getDb(), {
          id: resolveIdPrefix(getDb(), args.id) ?? args.id,
          endorser,
          ...(fingerprint !== undefined ? { fingerprint } : {}),
        });
        if (result === null) {
          return "error: entry not found";
        }
        if (!result.created) {
          return "error: already endorsed by you";
        }
        return result.shareable
          ? `endorsed ${args.id} (shareable)`
          : `endorsed ${args.id} (not shareable: the endorser is the author)`;
      }),
    exportEntries: (args, scope) =>
      run(() => {
        const filePath = resolvePortablePath(args.path, scope);
        const shareable = args.shareable === true;
        const count = exportPortable(getDb(), scope, filePath, shareable ? { shareable } : {});
        return shareable
          ? `exported ${count} shareable entries to ${filePath}`
          : `exported ${count} entries to ${filePath}`;
      }),
    importEntries: (args, scope) =>
      run(() => {
        const filePath = resolvePortablePath(args.path, scope);
        const result = importPortable(getDb(), filePath);
        return `imported ${result.imported} entries (${result.skipped} skipped) from ${filePath}`;
      }),
    sweep: (args, scope, options = {}) =>
      run(() => {
        // A non-positive ttl_days would sweep fresh entries; it falls back to the default.
        const days =
          typeof args.ttl_days === "number" && Number.isFinite(args.ttl_days) && args.ttl_days > 0
            ? Math.floor(args.ttl_days)
            : undefined;
        // The same full pass the automatic boot/daily cadence runs: sweep plus the
        // mesh sync twins, so a manual sweep never leaves the outbox behind.
        const report = runHousekeepingPass(getDb(), {
          scope,
          ...(days !== undefined ? { ttlMs: days * DAY_MS } : {}),
          ...(options.directory !== undefined ? { directory: options.directory } : {}),
        });
        return renderSweep(report);
      }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function renderSweep(report: HousekeepingReport): string {
  let text =
    `swept: ${report.tombstoned.length} tombstoned (dated), ` +
    `${report.deleted.length} deleted (duplicate), ${report.kept} kept`;
  // Cooled is printed only when it moved: the zero case is the old shape, and
  // callers without a directory never cool anything.
  if (report.cooled > 0) {
    text += `, ${report.cooled} cooled (anchored fresh)`;
  }
  for (const [label, rows] of [
    ["tombstoned", report.tombstoned],
    ["deleted", report.deleted],
  ] as const) {
    if (rows.length === 0) {
      continue;
    }
    // Tombstones stay restorable and deletions stay reviewable: name what moved.
    const listed = rows
      .slice(0, REMOVED_REPORT_MAX)
      .map((row) => `${JSON.stringify(row.title)} (${row.id}) [${row.rule}]`);
    const rest = rows.length - REMOVED_REPORT_MAX;
    text += `\n${label}: ${rest > 0 ? `${listed.join(", ")}, and ${rest} more` : listed.join(", ")}`;
  }
  return text;
}

/** How many removed entries a delete report names before it summarizes the rest, so a
 * broad query delete stays a bounded tool result. */
const REMOVED_REPORT_MAX = 10;

/** How many similar entries a save without `supersedes` may name as replacement
 * candidates, so the hint stays a one-line nudge instead of a search result. */
const SIMILAR_REPORT_MAX = 2;

function renderRemoved(entries: Entry[]): string {
  const listed = entries
    .slice(0, REMOVED_REPORT_MAX)
    .map((entry) => `${JSON.stringify(entry.title)} (${entry.id})`);
  const rest = entries.length - REMOVED_REPORT_MAX;
  return rest > 0 ? `${listed.join(", ")}, and ${rest} more` : listed.join(", ");
}

/**
 * Full-read rendering: the body integral, then one compact metadata block. The model
 * reads the content first; the id it will answer with, the kind, the age and the
 * anchoring ride underneath. Fields that carry nothing (no heat, no anchoring, no
 * supersede) take no space at all.
 */
function renderFullEntry(entry: Entry): string {
  const heat = entry.heat ?? 0;
  let text = `${entry.body}\n—\nid ${entry.id} · ${entry.kind} · ${humanAge(Date.now() - entry.updated_at)}`;
  if (heat > 0) {
    text += ` · heat ${heat}`;
  }
  if (entry.paths !== undefined && entry.paths.length > 0) {
    text += `\npaths: ${entry.paths.join(", ")}`;
  }
  if (entry.supersedes !== undefined) {
    text += `\nsupersedes ${entry.supersedes}`;
  }
  return text;
}

/** Compact human age: the recency signal a date string buries in digits. */
function humanAge(ms: number): string {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 30 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms < 365 * DAY) return `${Math.floor(ms / (30 * DAY))}mo`;
  return `${Math.floor(ms / (365 * DAY))}y`;
}

function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** How much of the store is summarised into a prompt, worst case. Hot lines
 * ride outside this budget: only their characters extend the ceiling the
 * remaining lines are cut against. */
export const INVENTORY_MAX_CHARS = 4000;

/** A non-lesson body longer than this injects only its first sentence, plus a
 * pointer to memory_search; the store keeps the full text either way. */
export const FACT_BODY_INJECT_MAX = 280;

const INVENTORY_HEADER = "Memory already stored for this project (lessons first, then newest):";

/** The project value a save stores from the tool's explicit `scope` argument:
 * 'global' means the machine-wide marker (no project, injected everywhere). */
export function projectFromScopeArg(scope: string | undefined): string | undefined {
  if (scope === undefined || scope.trim().toLowerCase() === "global") {
    return undefined;
  }
  return scope;
}

/** Tool descriptions shared by both entry points so the two hosts cannot drift. */
export const TOOL_DESCRIPTIONS = {
  save: "Save a durable entry to shared working memory. Never store credentials. supersedes=<id> replaces a known entry (8-char id prefix accepted); else the result lists similar entries to replace. scope=<project> overrides the entry's project scope ('global' = injected in every project); without it the entry carries the session's project.",
  search:
    "Search shared working memory machine-wide: this project's scope plus global. Entries matching every query token come first, then prefix matches fill the rest. One line per hit: <id8> <kind> <title> — <body preview>; pass the id8 (or full id) to memory_get. The search crosses project scopes by default; scope=<project> limits hits to that project.",
  list: "List recent memory entries for a scope (default: this project), newest first. Same one-line-per-entry format as search, id8 first.",
  get: "Full entry by id (8-char prefix accepted; search results truncate to 500 chars; this returns the complete entry).",
  forget:
    "Delete entries by id (globally unique, any scope; 8-char prefix accepted) or by query. Query deletes stay in this project's scope plus global; entries under another scope need their id or scope.",
  stats:
    "Count entries by kind for this project plus global, with a total. Also names never-recalled entries (30+ days, never served): a purge proposal only, forget the unneeded ones with memory_forget.",
  restore:
    "Put a trashed entry back, by id (8-char prefix accepted). memory_forget reports the ids it trashed; entries stay restorable for 30 days.",
  endorse:
    "Mark an entry as worth sharing across hosts (8-char id prefix accepted) — one endorsement from an agent other than the author makes it shareable.",
  exportEntries:
    "Export a scope's entries to a portable JSONL file: versionable in git, machine-shareable, credential-like content never exported. shareable=true exports only endorsed entries (peer endorsement, or the author's own shareable:true save).",
  importEntries:
    "Import entries from a portable JSONL file. Idempotent: existing ids skipped, secrets rejected, local entries never superseded (dangling supersedes links are dropped).",
  sweep:
    "Run the housekeeping sweep now (also runs at boot and every 24h): entries with a dated-state marker (ISO dates, 'état:', 'state as of', 'pending', 'ETA'...) stale past the TTL are tombstoned (restorable via memory_restore, 30 days); exact duplicates (same title, body and anchoring) keep only the newest copy. The same pass syncs the mesh: imports inbox files, exports shareable entries to the outbox. Lessons and epic/task entries are protected; anchored entries follow the anchoring rule.",
} as const;

/**
 * Sticky per-session injection: the first request where the producer has something
 * computes the text, every later request of the same session gets the SAME string
 * back. The host rebuilds the system prompt on every LLM call (each tool-loop step
 * included), so a block injected only once vanishes from step 2 on and the changed
 * prefix defeats the provider's prompt cache (and llama.cpp's slot cache) — the
 * whole context is re-prefilled. A byte-identical block stays cached, so repeating
 * it is nearly free, while dropping it is not. Keys are capped by evicting the
 * oldest session only, so live sessions never see their prefix rebuilt; an absent
 * sessionID (v1 marks it optional) degrades to one sticky entry per plugin instance.
 */
export function stickyPerSession() {
  const cache = new Map<string, string>();
  const MAX_KEYS = 512;
  const inject = (key: string | undefined, produce: () => string | null): string | null => {
    const k = key ?? "__instance__";
    const cached = cache.get(k);
    if (cached !== undefined) {
      return cached;
    }
    const produced = produce();
    if (produced === null) {
      return null;
    }
    cache.set(k, produced);
    if (cache.size > MAX_KEYS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    return produced;
  };
  return { inject, reset: () => cache.clear() };
}

/**
 * Bounded summary of recent entries, injected into the first request of a session and
 * into the compaction context. Hot entries (heat >= HOT_THRESHOLD, any kind) are
 * promoted above everything and injected outside the character budget: a recurring
 * lesson must reach the model even when the budget is saturated. Lessons follow
 * (their lines stay verbatim, title-only), then recency noise, whose bodies are
 * compressed: a long one injects only its first sentence with a pointer to
 * memory_search. `null` when there is nothing worth injecting, so a caller pushes
 * nothing at all.
 */
export function memoryInventory(
  getDb: () => MemoryDb,
  dbPath: string,
  scope: string,
  options: { directory?: string | undefined; project?: string | undefined } = {},
): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  // Per-project scoping: only global (unscoped) rows and rows of the session's
  // project are candidates; the store-level filter keeps the cap honest.
  const project = options.project;
  const lessons = list(getDb(), {
    scope,
    limit: 50,
    kind: "lesson",
    ...(project !== undefined ? { project } : {}),
  });
  const others = list(getDb(), { scope, limit: 50, ...(project !== undefined ? { project } : {}) });
  if (lessons.length === 0 && others.length === 0) {
    return null;
  }

  const seen = new Set(lessons.map((entry) => entry.id));
  const ordered = [...lessons, ...others.filter((entry) => !seen.has(entry.id))];

  // Anchored entries whose files changed since the save are stale: nothing
  // observable contradicts an unanchored entry, so only those are filtered.
  const directory = options.directory;
  const fresh =
    directory === undefined ? ordered : ordered.filter((entry) => isEntryFresh(entry, directory));
  if (fresh.length === 0) {
    return null;
  }

  const hot = fresh.filter((entry) => (entry.heat ?? 0) >= HOT_THRESHOLD);
  const hotIds = new Set(hot.map((entry) => entry.id));
  const rest = fresh.filter((entry) => !hotIds.has(entry.id));

  const lines = [INVENTORY_HEADER];
  let size = INVENTORY_HEADER.length;
  const injected: string[] = [];
  // Hot lines pass before everything and do not count against the budget: only
  // their characters extend the ceiling the remaining lines are cut against.
  let hotChars = 0;
  for (const entry of hot) {
    const line = inventoryLine(entry, true);
    lines.push(line);
    injected.push(entry.id);
    size += line.length + 1;
    hotChars += line.length + 1;
  }
  const ceiling = INVENTORY_MAX_CHARS + hotChars;
  for (const entry of rest) {
    const line = inventoryLine(entry, false);
    if (size + line.length + 1 > ceiling) {
      break;
    }
    lines.push(line);
    injected.push(entry.id);
    size += line.length + 1;
  }
  // Only the lines that made it under the character budget were actually served to the
  // model, so only those count as used; the cut entries stay never-recalled candidates.
  if (injected.length > 0) {
    touchUsage(getDb(), injected, Date.now());
  }
  return lines.join("\n");
}

function inventoryLine(entry: Entry, hot: boolean): string {
  const by = entry.source === undefined ? "" : `, by ${entry.source}`;
  const base = `- [${entry.kind}]${hot ? "[HOT]" : ""} ${entry.title} (updated ${dayOf(entry.updated_at)}${by})`;
  // Lesson lines stay title-only and verbatim (they are the active rules, and
  // their bodies live in the store); every other kind carries a bounded body
  // gist, so a long body cannot burn tokens on every turn.
  if (entry.kind === "lesson") {
    return base;
  }
  const body = flatten(entry.body);
  if (body.length === 0) {
    return base;
  }
  return `${base} — ${truncateFactBody(body)}`;
}

/** The injected half of a non-lesson body: the whole thing when it is short
 * enough, else its first sentence (hard-cut inside the budget when even that
 * sentence overruns) plus the pointer to the full text. */
function truncateFactBody(body: string): string {
  if (body.length <= FACT_BODY_INJECT_MAX) {
    return body;
  }
  const dot = body.search(/[.!?](\s|$)/);
  const sentence = dot === -1 ? body : body.slice(0, dot + 1);
  const head =
    sentence.length <= FACT_BODY_INJECT_MAX
      ? sentence
      : sentence.slice(0, FACT_BODY_INJECT_MAX).trimEnd();
  return `${head}… (body complet via memory_search)`;
}

/** Newlines collapse to spaces: an inventory entry must stay one line. */
function flatten(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function dayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

// Tool results are shown to the model: caught errors become readable text, so a
// rejected save is guidance instead of a crashed tool call.
function run(fn: () => string): string {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SecretDetectedError) {
      return "refused: the content looks like a credential; secrets must never be stored in memory";
    }
    if (error instanceof Error) {
      return `error: ${error.message}`;
    }
    throw error;
  }
}
