import { existsSync } from "node:fs";

import { databaseSizeBytes, type MemoryDb } from "./db.js";
import { isEntryFresh } from "./git.js";
import { exportPortable, importPortable, resolvePortablePath } from "./portable.js";
import {
  endorseEntry,
  forget,
  getById,
  HOT_THRESHOLD,
  LessonBudgetError,
  list,
  neverRecalled,
  oldestCreated,
  renderEntries,
  restore,
  saveEntry,
  search,
  SecretDetectedError,
  stats,
  suggestReplacements,
  touchUsage,
} from "./store.js";
import { sweepHousekeeping, type HousekeepingReport } from "./housekeeping.js";
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
  /** Repository commit the entry was written against (auto-resolved by the
   * plugin from the project directory). */
  commit_sha?: string | undefined;
  /** Id of the entry this one replaces: the old row is kept as a superseded
   * tombstone instead of stacking a near-duplicate. */
  supersedes?: string | undefined;
  /** Publish without peer endorsement: the author vouches, and the save records the
   * author's own endorsement in `endorsed_by`. */
  shareable?: boolean | undefined;
};
export type SearchArgs = { query: string; limit?: number | undefined };
export type ListArgs = { limit?: number | undefined };
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
  save: (args: SaveArgs, scope: string, source?: string) => string;
  search: (args: SearchArgs, scope: string) => string;
  list: (args: ListArgs, scope: string) => string;
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
  options: { onLessonSaved?: () => void; lessonBudgetPerDay?: number } = {},
): MemoryOps {
  return {
    save: (args, scope, source) =>
      run(() => {
        const { entry, created, superseded } = saveEntry(
          getDb(),
          {
            scope,
            kind: args.kind,
            title: args.title,
            body: args.body,
            tags: args.tags ?? [],
            expires_at: args.expires_at ?? null,
            ...(source !== undefined ? { source } : {}),
            ...(args.paths !== undefined ? { paths: args.paths } : {}),
            ...(args.commit_sha !== undefined ? { commit_sha: args.commit_sha } : {}),
            ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
            ...(args.shareable !== undefined ? { shareable: args.shareable } : {}),
          },
          options.lessonBudgetPerDay !== undefined
            ? { lessonBudgetPerDay: options.lessonBudgetPerDay }
            : {},
        );
        // A lesson save (or any row that reached hot) is new priority knowledge:
        // dropping the once-per-session injection cache makes the next turn
        // re-inject the inventory with the hot entry up front.
        if (entry.kind === "lesson" || (entry.heat ?? 0) >= HOT_THRESHOLD) {
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
    search: (args, scope) =>
      run(() => {
        const hits = search(getDb(), {
          query: args.query,
          scope,
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
        return hits.length === 0 ? "no matching memory entries" : renderEntries(hits);
      }),
    list: (args, scope) =>
      run(() => {
        const entries = list(getDb(), {
          scope,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return entries.length === 0 ? "no memory entries" : renderEntries(entries);
      }),
    get: (args) =>
      run(() => {
        const found = getById(getDb(), args.id);
        if (found === null) {
          return "no entry with that id";
        }
        if (found.trashed) {
          return "entry is in the trash (restorable for 30 days): use memory_restore to put it back";
        }
        // A full read serves the entry to the model, same as a search hit does.
        touchUsage(getDb(), [args.id], Date.now());
        return JSON.stringify(found.entry);
      }),
    forget: (args, scope) =>
      run(() => {
        const removed =
          args.id !== undefined
            ? forget(getDb(), { id: args.id, scope })
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
          text += `\nnever-recalled: ${never.length} (${renderRemoved(never)}) - forgotten by no one so far; propose memory_forget for the ones that are no longer useful`;
        }
        return text;
      }),
    restore: (args) =>
      run(() => {
        const entry = restore(getDb(), { id: args.id });
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
        const result = endorseEntry(getDb(), { id: args.id, endorser });
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
        const report = sweepHousekeeping(getDb(), {
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

function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** How much of the store is summarised into a prompt, worst case. */
export const INVENTORY_MAX_CHARS = 1200;

const INVENTORY_HEADER = "Memory already stored for this project (lessons first, then newest):";

/** Tool descriptions shared by both entry points so the two hosts cannot drift. */
export const TOOL_DESCRIPTIONS = {
  save: "Save a durable entry to shared working memory (decisions, facts, preferences, gotchas, lessons). Never store credentials. Pass supersedes=<id> to replace a known entry instead of stacking a near-duplicate; without it, the result lists similar entries worth replacing.",
  search:
    "Search shared working memory (all sessions on this machine). Results include this project's scope and global entries: entries matching every query token come first, then entries matching some token as a prefix fill the remaining slots.",
  list: "List recent memory entries for a scope (default: this project), newest first.",
  get: "Full entry by id — the search results are truncated to 500 chars; memory_get gives the complete entry.",
  forget:
    "Delete memory entries by id (any scope: ids are globally unique), or all entries matching a query. Query deletes stay inside this project's scope (plus global entries); an entry saved under another scope needs its id, or that scope, to be removed.",
  stats:
    "Count memory entries by kind for this project (plus global entries), with a total. Use it to see how much memory already exists, for example how many lessons reflection has written. The result also names never-recalled entries (stored 30+ days, never served to the model): a purge proposal only, forget the ones you no longer need with memory_forget.",
  restore:
    "Put a trashed entry back, by id. Deletes are recoverable: memory_forget reports the ids it trashed, and memory_restore brings one of them back. An entry stays restorable for 30 days.",
  endorse:
    "Mark an entry as worth sharing across hosts — one endorsement from an agent other than the author makes it shareable.",
  exportEntries:
    "Export memory entries for a scope to a portable JSONL file (default .opencode/memory/memory-export.jsonl in the project). The file is versionable in git and shareable across machines; credential-like content is never exported. With shareable=true, export only the entries worth sharing cross-host: those carrying at least one endorsement (a peer's, or the author's own when the save published them with shareable).",
  importEntries:
    "Import memory entries from a portable JSONL file (default .opencode/memory/memory-export.jsonl). Idempotent: entries whose id already exists are skipped, secrets are rejected, and the import never supersedes local entries (a supersedes link pointing outside the file is dropped). The report names how many entries were imported and how many were skipped.",
  sweep:
    "Run the conservative housekeeping sweep now (it also runs automatically at plugin boot and every 24h): entries carrying a dated-state marker (ISO dates, 'état:', 'state as of', 'pending', 'ETA'...) that were not updated within the TTL are tombstoned (recoverable via memory_restore for 30 days), and exact duplicates of a scope (same normalized title and body, same anchoring) are removed keeping the newest copy. Lessons, epic/task entries are protected; anchored entries are left to the anchoring rule.",
} as const;

/**
 * Produces at most one injection per session key, and only on the first request where
 * the producer has something: a session that starts before any entry exists still gets
 * its inventory as soon as one is available. Keys are capped so a long-lived host
 * cannot grow the set forever; an absent sessionID (v1 marks it optional) degrades to
 * one injection per plugin instance, never per request.
 */
export function oncePerSession() {
  const seen = new Set<string>();
  const MAX_KEYS = 512;
  const inject = (key: string | undefined, produce: () => string | null): string | null => {
    const k = key ?? "__instance__";
    if (seen.has(k)) {
      return null;
    }
    const produced = produce();
    if (produced === null) {
      return null;
    }
    seen.add(k);
    if (seen.size > MAX_KEYS) {
      seen.clear();
    }
    return produced;
  };
  return { inject, reset: () => seen.clear() };
}

/**
 * Bounded summary of recent entries, injected into the first request of a session and
 * into the compaction context. Hot entries (heat >= HOT_THRESHOLD, any kind) are
 * promoted above everything and injected outside the character budget: a recurring
 * lesson must reach the model even when the budget is saturated. Lessons follow, then
 * recency noise. `null` when there is nothing worth injecting, so a caller pushes
 * nothing at all.
 */
export function memoryInventory(
  getDb: () => MemoryDb,
  dbPath: string,
  scope: string,
  options: { directory?: string } = {},
): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  const lessons = list(getDb(), { scope, limit: 50, kind: "lesson" });
  const others = list(getDb(), { scope, limit: 50 });
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
  return `- [${entry.kind}]${hot ? "[HOT]" : ""} ${entry.title} (updated ${dayOf(entry.updated_at)}${by})`;
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
    if (error instanceof LessonBudgetError) {
      return (
        `refused: ${error.message}; improve an existing lesson (re-save with the same title) ` +
        "instead of stacking a new one"
      );
    }
    if (error instanceof Error) {
      return `error: ${error.message}`;
    }
    throw error;
  }
}
