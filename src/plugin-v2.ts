import { existsSync, unlinkSync } from "node:fs";

import { Plugin } from "@opencode/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import { databaseSizeBytes } from "./lib/db.js";
import {
  HOUSEKEEPING_INTERVAL_MS,
  runHousekeepingPass,
  type HousekeepingReport,
} from "./lib/housekeeping.js";
import {
  TOOL_DESCRIPTIONS,
  createMemoryOps,
  memoryInventory,
  projectFromScopeArg,
  stickyPerSession,
} from "./lib/memory-ops.js";
import { resolveCaveman } from "./lib/caveman.js";
import { createDurableStore } from "./lib/persist.js";
import { defaultMeshDataDir, defaultMeshInboxDir, nodeFingerprint } from "./lib/sync.js";
import { buildSidebarSnapshot } from "./lib/tui-snapshot.js";
import { createReflection, parseReflectionConfig } from "./lib/reflection.js";
import { parseReflectionActivation, reflectionGuidance } from "./lib/reflection.js";
import {
  SYSTEM_GUIDANCE,
  SYSTEM_GUIDANCE_CAVEMAN,
  COMPACTION_CONTEXT,
  COMPACTION_CONTEXT_CAVEMAN,
  defaultScope,
  defaultDbPath,
  parseHousekeepingConfig,
  parseRetrievalConfig,
  type PluginOptions,
} from "./options.js";
import {
  canonicalProject,
  canonicalScope,
  scopeBreakdown,
  stats as statsEntries,
  topEntries,
} from "./lib/store.js";
import { MemoryRpc, noStoreSidebar, snapshotFromStats } from "./rpc.js";
import {
  compactionSummary,
  handleCompaction,
  transcriptExcerpt,
  transcriptFilePath,
  writeTranscriptFile,
} from "./compaction.js";
import type { TranscriptMessage } from "./transcripts.js";
import { renderTranscript, sessionInfoToMessages } from "./transcripts.js";
import { readTranscript, searchTranscripts } from "./session-search.js";
import {
  collectTranscripts,
  effectiveLastTouch,
  formatSweepResult,
  sweepTranscripts,
} from "./transcript-retention.js";

const textPart = (text: string) => ({ type: "text" as const, text });

/** Reconnect backoff for the v2 event stream: short first retry, capped growth. */
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

/** Session tail as plain text: user messages verbatim, assistant text parts joined. */
async function transcriptV2(ctx: Plugin.Context, sessionID: string): Promise<string> {
  const messages = await ctx.session.context({ sessionID });
  const lines: string[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      lines.push(`user: ${message.text}`);
    } else if (message.type === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ")
        .trim();
      if (text) {
        lines.push(`assistant: ${text}`);
      }
    }
  }
  return lines.join("\n");
}

export const MemoryV2 = Plugin.define({
  id: "@log0u7/opencode-memory",
  async setup(ctx) {
    const options = ctx.options as PluginOptions;
    const dbPath = defaultDbPath(options);
    let db: MemoryDb | null = null;
    let disposed = false;
    // After cleanup the store is closed for good: a late path (tool call, in-flight
    // reflection) must not silently reopen a connection that nobody closes again.
    const getDb = (): MemoryDb => {
      if (disposed) {
        throw new Error("memory store is closed");
      }
      db ??= openMemoryDb(dbPath);
      return db;
    };
    const injected = stickyPerSession();
    // The inference-only reflection loop: the standing directive (the current model
    // distills lessons itself, no separate call).
    const reflectionLoop = parseReflectionActivation(options.reflection);
    // Read once at boot so the guidance, part of the cached prefix, never flips mid-session.
    const caveman = resolveCaveman(options.caveman, ctx.location.directory);
    const baseGuidance = caveman ? SYSTEM_GUIDANCE_CAVEMAN : SYSTEM_GUIDANCE;
    const compactionContext = caveman ? COMPACTION_CONTEXT_CAVEMAN : COMPACTION_CONTEXT;
    const guidance = reflectionLoop.enabled
      ? `${baseGuidance}\n${reflectionGuidance()}`
      : baseGuidance;
    const ops = createMemoryOps(getDb, {
      // Only a HOT save (heat >= threshold, a rare récidive) resets the injected
      // inventory: the next turn re-injects with the hot entry up front. Ordinary
      // lessons keep the system prefix byte-stable (prompt-cache hits) and reach
      // live sessions through memory_search.
      onLessonSaved: () => injected.reset(),
      // Endorsements bind to the node identity (0.24.0): the mesh's node.json is
      // the same identity the TLS pairing pins, so peers can verify the stamp.
      fingerprint: nodeFingerprint,
    });

    // Request and compaction hooks carry no directory: the instance scope is the project.
    const projectScope = defaultScope(undefined, ctx.location.directory);
    // The project the injected inventory filters by: the host's project context when
    // it carries one, else the plugin directory. A context without a project (an
    // older host) degrades to the directory, so the filter still holds one value.
    const project = projectOf(ctx.location);
    const retrieval = parseRetrievalConfig(options);

    // Conservative automatic housekeeping: once at boot, then daily. A missing
    // store has nothing to sweep and must not be created for the sweep's sake; a
    // failed sweep (locked db, full disk) is environmental and must not break setup.
    const housekeeping = parseHousekeepingConfig(options);
    // The latest report of this process, kept for the TUI sidebar's cooled count
    // (the sweep timestamp itself is stamped into the db metadata by the sweep).
    let lastSweepReport: HousekeepingReport | null = null;
    const runHousekeeping = (): HousekeepingReport | null => {
      if (disposed || !housekeeping.enabled || !existsSync(dbPath)) {
        return null;
      }
      try {
        // The same full pass the manual memory_sweep tool runs: sweep plus the mesh
        // sync twins, so both entry points stay in lockstep by construction.
        const report = runHousekeepingPass(getDb(), {
          scope: projectScope,
          ttlMs: housekeeping.ttlMs,
          now: Date.now(),
          directory: ctx.location.directory,
        });
        lastSweepReport = report;
        return report;
      } catch {
        return null;
      }
    };
    runHousekeeping();
    let sweepTimer: ReturnType<typeof setInterval> | undefined;
    if (housekeeping.enabled) {
      sweepTimer = setInterval(runHousekeeping, HOUSEKEEPING_INTERVAL_MS);
      if (typeof sweepTimer.unref === "function") {
        sweepTimer.unref();
      }
    }

    /** Scope that holds the transcript for `sessionID`: the project scope when the file is
     * already there, otherwise the session's own scope after an on-demand export (lazy, so
     * old sessions work without pre-exporting everything). Null: unknown session or empty
     * history. */
    const ensureTranscript = async (sessionID: string): Promise<string | null> => {
      if (disposed) {
        return null;
      }
      if (existsSync(transcriptFilePath(retrieval.dir, projectScope, sessionID))) {
        return projectScope;
      }
      // An unknown session id is an expected miss here, not an exceptional failure.
      let info: unknown;
      try {
        info = await ctx.session.get({ sessionID });
      } catch {
        return null;
      }
      const directory = (info as { location?: { directory?: string } } | undefined)?.location
        ?.directory;
      if (typeof directory !== "string" || directory.length === 0) {
        return null;
      }
      const scope = canonicalScope(undefined, directory);
      if (existsSync(transcriptFilePath(retrieval.dir, scope, sessionID))) {
        return scope;
      }
      const context = await ctx.session.context({ sessionID });
      const messages = sessionInfoToMessages(context);
      if (messages.length === 0) {
        return null;
      }
      const path = transcriptFilePath(retrieval.dir, scope, sessionID);
      writeTranscriptFile(
        path,
        renderTranscript(
          messages,
          { sessionID, scope },
          {
            inlineOutputMaxBytes: retrieval.inlineOutputMaxBytes,
          },
        ),
      );
      return scope;
    };
    const unexportable = (sessionID: string): string =>
      `no transcript for session ${sessionID}; it could not be exported (unknown session or empty history)`;

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_save",
        description: TOOL_DESCRIPTIONS.save,
        input: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              description: "Entry type, e.g. decision, fact, preference, gotcha, lesson",
            },
            title: { type: "string", description: "Short title (max 120 chars)" },
            body: { type: "string", description: "Entry content (max 8000 chars)" },
            scope: {
              type: "string",
              description:
                "Explicit project scope; defaults to the session's project. 'global' = injected in every project",
            },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
            expires_at: { type: "number", description: "Optional epoch ms expiry" },
            paths: {
              type: "array",
              items: { type: "string" },
              description:
                "Files the entry documents (relative project paths): the entry is stale when any of them changes",
            },
            supersedes: {
              type: "string",
              description: "Id of the entry this one replaces (8-char prefix accepted)",
            },
            shareable: {
              type: "boolean",
              description:
                "Publish without peer endorsement: the author vouches for the entry (default false)",
            },
          },
          required: ["kind", "title", "body"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const a = args as {
            kind: string;
            title: string;
            body: string;
            scope?: string;
            tags?: string[];
            expires_at?: number;
            paths?: string[];
            supersedes?: string;
            shareable?: boolean;
          };
          // The project scope: the explicit argument when given (the 'global'
          // marker clears it), else the session's project.
          const explicitProject = a.scope === undefined ? project : projectFromScopeArg(a.scope);
          return {
            content: ops.save(
              { ...a, project: explicitProject },
              defaultScope(undefined, ctx.location.directory),
              context.agent,
              // The lib auto-captures HEAD when the save anchors paths.
              { directory: ctx.location.directory },
            ),
          };
        },
      });

      editor.add({
        name: "memory_search",
        description: TOOL_DESCRIPTIONS.search,
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free-text query" },
            scope: {
              type: "string",
              description: "Optional project filter; default searches across projects",
            },
            limit: { type: "number", description: "Max results (default 5)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { query: string; scope?: string; limit?: number };
          return {
            content: ops.search(
              {
                query: a.query,
                ...(a.limit !== undefined ? { limit: a.limit } : {}),
                ...(a.scope !== undefined ? { project: a.scope } : {}),
              },
              defaultScope(undefined, ctx.location.directory),
              // The lib marks stale anchoring per hit when it knows the checkout.
              { directory: ctx.location.directory },
            ),
          };
        },
      });

      editor.add({
        name: "memory_list",
        description: TOOL_DESCRIPTIONS.list,
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
            limit: { type: "number", description: "Max results (default 10)" },
            page: { type: "number", description: "1-based page of results (default 1)" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { scope?: string; limit?: number; page?: number };
          return {
            content: ops.list(
              {
                ...(a.limit !== undefined ? { limit: a.limit } : {}),
                ...(a.page !== undefined ? { page: a.page } : {}),
              },
              defaultScope(undefined, a.scope ?? ctx.location.directory),
              { directory: ctx.location.directory },
            ),
          };
        },
      });

      editor.add({
        name: "memory_get",
        description: TOOL_DESCRIPTIONS.get,
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Entry id to fetch in full (8-char prefix accepted)",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { id: string };
          return { content: ops.get(a) };
        },
      });

      editor.add({
        name: "memory_forget",
        description: TOOL_DESCRIPTIONS.forget,
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Entry id to delete (8-char prefix accepted)",
            },
            query: { type: "string", description: "Delete every entry matching this query" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { id?: string; query?: string };
          return { content: ops.forget(a, defaultScope(undefined, ctx.location.directory)) };
        },
      });

      editor.add({
        name: "memory_stats",
        description: TOOL_DESCRIPTIONS.stats,
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { scope?: string };
          return { content: ops.stats(defaultScope(undefined, a.scope ?? ctx.location.directory)) };
        },
      });

      editor.add({
        name: "memory_restore",
        description: TOOL_DESCRIPTIONS.restore,
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Id of a trashed entry to put back (8-char prefix accepted)",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { id: string };
          return { content: ops.restore(a) };
        },
      });

      editor.add({
        name: "memory_sweep",
        description: TOOL_DESCRIPTIONS.sweep,
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
            ttl_days: {
              type: "number",
              description: "Override the dated-rule staleness TTL in days (default 7)",
            },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { scope?: string; ttl_days?: number };
          return {
            content: ops.sweep(a, defaultScope(undefined, a.scope ?? ctx.location.directory), {
              directory: ctx.location.directory,
            }),
          };
        },
      });

      editor.add({
        name: "memory_export",
        description: TOOL_DESCRIPTIONS.exportEntries,
        input: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              description: "Scope key; defaults to the project directory",
            },
            path: {
              type: "string",
              description:
                "JSONL file path; default .opencode/memory/memory-export.jsonl in the project",
            },
            shareable: {
              type: "boolean",
              description:
                "Export only entries worth sharing cross-host: those carrying at least one endorsement",
            },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { scope?: string; path?: string; shareable?: boolean };
          return {
            content: ops.exportEntries(
              a,
              defaultScope(undefined, a.scope ?? ctx.location.directory),
            ),
          };
        },
      });

      editor.add({
        name: "memory_endorse",
        description: TOOL_DESCRIPTIONS.endorse,
        input: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Entry id to endorse (8-char prefix accepted)",
            },
            endorser: {
              type: "string",
              description: "Endorsing agent; defaults to the calling agent",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const a = args as { id: string; endorser?: string };
          return {
            content: ops.endorse({ id: a.id, endorser: a.endorser ?? context.agent }),
          };
        },
      });

      editor.add({
        name: "memory_import",
        description: TOOL_DESCRIPTIONS.importEntries,
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "JSONL file path; default .opencode/memory/memory-export.jsonl in the project",
            },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { path?: string };
          return {
            content: ops.importEntries(a, defaultScope(undefined, ctx.location.directory)),
          };
        },
      });

      if (!retrieval.enabled) {
        return;
      }

      editor.add({
        name: "memory_session_search",
        description:
          "Search past session transcripts (verbatim compaction exports) for exact lines: " +
          "errors, paths, numbers, decisions. Returns matches with line numbers and context. " +
          "After a compaction, retrieve facts here, not by guessing.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Exact text to find, case-insensitive" },
            sessionID: {
              type: "string",
              description: "Limit to one session; it is exported on demand if not on disk yet",
            },
            all: {
              type: "boolean",
              description:
                "Search every project's transcripts on this machine, not just this project's",
            },
            contextLines: {
              type: "number",
              description: "Context lines around each match (default 3, max 10)",
            },
            maxBytes: { type: "number", description: "Output byte cap (default 20000)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as {
            query: string;
            sessionID?: string;
            all?: boolean;
            contextLines?: number;
            maxBytes?: number;
          };
          if (a.sessionID !== undefined) {
            const scope = await ensureTranscript(a.sessionID);
            if (scope === null) {
              return { content: unexportable(a.sessionID) };
            }
            return {
              content: searchTranscripts(retrieval.dir, scope, {
                query: a.query,
                sessionID: a.sessionID,
                ...(a.contextLines !== undefined ? { contextLines: a.contextLines } : {}),
                ...(a.maxBytes !== undefined ? { maxBytes: a.maxBytes } : {}),
              }),
            };
          }
          return {
            content: searchTranscripts(retrieval.dir, projectScope, {
              query: a.query,
              all: a.all === true,
              ...(a.contextLines !== undefined ? { contextLines: a.contextLines } : {}),
              ...(a.maxBytes !== undefined ? { maxBytes: a.maxBytes } : {}),
            }),
          };
        },
      });

      editor.add({
        name: "memory_session_read",
        description:
          "Read a numbered window of a past session transcript by 1-based line number, " +
          "after memory_session_search, to pull the exact block around a match.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Session whose transcript to read" },
            offset: { type: "number", description: "1-based starting line (default 1)" },
            limit: { type: "number", description: "Max lines (default 200, max 500)" },
            maxBytes: { type: "number", description: "Output byte cap (default 20000)" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as {
            sessionID: string;
            offset?: number;
            limit?: number;
            maxBytes?: number;
          };
          const scope = await ensureTranscript(a.sessionID);
          if (scope === null) {
            return { content: unexportable(a.sessionID) };
          }
          return {
            content: readTranscript(retrieval.dir, scope, {
              sessionID: a.sessionID,
              ...(a.offset !== undefined ? { offset: a.offset } : {}),
              ...(a.limit !== undefined ? { limit: a.limit } : {}),
              ...(a.maxBytes !== undefined ? { maxBytes: a.maxBytes } : {}),
            }),
          };
        },
      });

      editor.add({
        name: "memory_transcript_list",
        description:
          "List exported session transcripts with scope, size, age and last-touch time, " +
          "so storage usage is visible before cleanup.",
        input: {
          type: "object",
          properties: {
            all: {
              type: "boolean",
              description:
                "List every project's transcripts on this machine, not just this project's",
            },
            scope: { type: "string", description: "Limit to one scope key" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { all?: boolean; scope?: string };
          const entries = collectTranscripts(retrieval.dir);
          const filtered =
            a.all === true
              ? entries
              : a.scope
                ? entries.filter((e) => e.scope === a.scope)
                : entries.filter((e) => e.scope === projectScope);
          const now = Date.now();
          const rows = filtered
            .map((e) => ({
              scope: e.scope,
              sessionID: e.sessionID,
              bytes: e.size,
              ageDays: Math.max(
                0,
                Math.floor((now - effectiveLastTouch(e)) / (24 * 60 * 60 * 1000)),
              ),
              lastTouch: new Date(effectiveLastTouch(e)).toISOString(),
            }))
            .sort((x, y) => y.ageDays - x.ageDays || x.sessionID.localeCompare(y.sessionID));
          // Keep output bounded.
          const capped = rows.slice(0, 200);
          return {
            content: JSON.stringify(
              {
                total: rows.length,
                shown: capped.length,
                transcripts: capped,
              },
              null,
              2,
            ),
          };
        },
      });

      editor.add({
        name: "memory_transcript_cleanup",
        description:
          "Sweep exported session transcripts per the retention policy (dry run by default; " +
          "apply:true removes). retentionDays/keepRecent/maxSessions override the policy; " +
          "sessionIDs limits the sweep.",
        input: {
          type: "object",
          properties: {
            dryRun: { type: "boolean", description: "Report only, do not delete (default true)" },
            apply: { type: "boolean", description: "Actually remove eligible transcripts" },
            allScopes: {
              type: "boolean",
              description: "Sweep every project's transcripts, not just this project's",
            },
            sessionIDs: {
              type: "array",
              items: { type: "string" },
              description: "Limit the sweep to these session ids",
            },
            retentionDays: { type: "number", description: "Override configured retention days" },
            keepRecent: { type: "number", description: "Override configured keepRecent floor" },
            maxSessions: { type: "number", description: "Override configured maxSessions cap" },
          },
          additionalProperties: false,
        },
        async execute(args, context) {
          const a = args as {
            dryRun?: boolean;
            apply?: boolean;
            allScopes?: boolean;
            sessionIDs?: string[];
            retentionDays?: number;
            keepRecent?: number;
            maxSessions?: number;
          };
          const dryRun = a.apply === true ? false : a.dryRun !== false;
          // When sessionIDs provided, treat as targeted: disable age/cap triggers by setting
          // retentionDays 0 and maxSessions 0, but force those specific ids as candidates by
          // a separate path. Simpler: sweep all then filter candidates to the requested ids.
          const targeted = !!(a.sessionIDs && a.sessionIDs.length > 0);
          // Targeted mode must never let the policy sweep delete unrelated transcripts:
          // run the policy pass as a dry run, then delete only the explicitly requested ids.
          const sweepDryRun = dryRun || targeted;
          const result = sweepTranscripts(retrieval.dir, {
            retentionDays:
              a.retentionDays !== undefined
                ? a.retentionDays
                : targeted
                  ? 1
                  : retrieval.retentionDays,
            keepRecent:
              a.keepRecent !== undefined ? a.keepRecent : targeted ? 0 : retrieval.keepRecent,
            maxSessions:
              a.maxSessions !== undefined ? a.maxSessions : targeted ? 0 : retrieval.maxSessions,
            scope: a.allScopes === true ? undefined : projectScope,
            protectedSessionID: context.sessionID,
            dryRun: sweepDryRun,
            now: Date.now(),
          });
          // Targeted filter.
          let filtered = result;
          if (a.sessionIDs && a.sessionIDs.length > 0) {
            const wanted = new Set(a.sessionIDs);
            const cand = result.candidates.filter((c) => wanted.has(c.sessionID));
            // If targeted, mark all requested (existing) as candidates regardless of age.
            // Rebuild candidates from collected entries for requested ids not already eligible.
            let entries = collectTranscripts(retrieval.dir);
            if (a.allScopes !== true) {
              entries = entries.filter((e) => e.scope === projectScope);
            }
            const extra: typeof result.candidates = [];
            for (const e of entries) {
              if (!wanted.has(e.sessionID)) continue;
              if (cand.some((c) => c.path === e.path)) continue;
              if (e.sessionID === context.sessionID) continue;
              extra.push({
                path: e.path,
                scope: e.scope,
                sessionID: e.sessionID,
                reason: "targeted",
                bytes: e.size,
                ageDays: Math.max(
                  0,
                  Math.floor((Date.now() - effectiveLastTouch(e)) / (24 * 60 * 60 * 1000)),
                ),
              });
            }
            const allCand = [...cand, ...extra];
            // Apply deletion for targeted if not dryRun.
            const removed: typeof allCand = [];
            const errors: string[] = [];
            let bytesFreed = 0;
            if (!dryRun) {
              for (const c of allCand) {
                try {
                  unlinkSync(c.path);
                  removed.push(c);
                  bytesFreed += c.bytes;
                } catch (err) {
                  errors.push(`${c.path}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
            filtered = {
              candidates: allCand,
              removed: dryRun ? [] : removed,
              kept: result.kept,
              bytesFreed: dryRun ? 0 : bytesFreed,
              errors,
            };
          }
          // Scope filtering for allScopes=false (default): only current project scope.
          if (!a.allScopes && !(a.sessionIDs && a.sessionIDs.length > 0)) {
            // Already swept all scopes in sweepTranscripts (it walks all). Restrict results to projectScope.
            filtered = {
              ...filtered,
              candidates: filtered.candidates.filter((c) => c.scope === projectScope),
              removed: filtered.removed.filter((c) => c.scope === projectScope),
            };
          }
          return { content: formatSweepResult(filtered, dryRun) };
        },
      });
    });

    // The v1 system transform maps to the v2 context hook: guidance first, then the
    // sticky per-session inventory (stale anchored entries filtered out).
    await ctx.session.hook("context", (event) => {
      event.system.push(textPart(guidance));
      if (disposed) {
        return;
      }
      const inventory = injected.inject(event.sessionID, () =>
        memoryInventory(getDb, dbPath, projectScope, {
          directory: ctx.location.directory,
          project,
        }),
      );
      if (inventory !== null) {
        event.system.push(textPart(inventory));
      }
    });

    // experimental.session.compacting -> compaction hook. When retrieval is enabled the
    // transcript is exported verbatim and event.result replaces the model-written summary:
    // the summary model call is skipped entirely.
    await ctx.session.hook("compaction", (event) => {
      event.system.push(textPart(compactionContext));
      if (disposed) {
        return;
      }
      const inventory = memoryInventory(getDb, dbPath, projectScope, {
        directory: ctx.location.directory,
        project,
      });
      if (inventory !== null) {
        event.system.push(textPart(inventory));
      }
      if (!retrieval.enabled) {
        return;
      }
      // Host Message instances viewed structurally here: this hook is the boundary where
      // the host's shape is parsed once into the renderer's input type.
      const messages = (event.messages ?? []) as unknown as ReadonlyArray<TranscriptMessage>;
      const model = event.model;
      // An export failure must not kill compaction: leave event.result unset and the host
      // falls back to the model-written summary. Expected failures are environmental
      // (ENOSPC, EACCES on the data dir), not logic bugs.
      try {
        const { summary } = handleCompaction(
          {
            sessionID: event.sessionID,
            ...(model ? { model: `${model.providerID}/${model.id}` } : {}),
            messages,
          },
          { dir: retrieval.dir, scope: projectScope },
          { inlineOutputMaxBytes: retrieval.inlineOutputMaxBytes },
        );
        event.result = { summary };
      } catch {
        // Silent fallback to the documented summary flow.
      }
      // Opportunistic retention sweep after an export: cheap, local, never blocks compaction.
      if (retrieval.retentionDays > 0 || retrieval.maxSessions > 0) {
        try {
          sweepTranscripts(retrieval.dir, {
            retentionDays: retrieval.retentionDays,
            keepRecent: retrieval.keepRecent,
            maxSessions: retrieval.maxSessions,
            scope: projectScope,
            protectedSessionID: event.sessionID,
            dryRun: false,
            now: Date.now(),
          });
        } catch {
          // Sweep failures are environmental; never affect compaction.
        }
      }
    });

    // Optional, delayed retention sweep: opt-in (retentionDays > 0), never blocks startup,
    // and never runs during the first 30s so it does not compete with session init.
    if (
      retrieval.enabled &&
      retrieval.autoSweep &&
      (retrieval.retentionDays > 0 || retrieval.maxSessions > 0)
    ) {
      const timer = setTimeout(() => {
        if (disposed) {
          return;
        }
        try {
          sweepTranscripts(retrieval.dir, {
            retentionDays: retrieval.retentionDays,
            keepRecent: retrieval.keepRecent,
            maxSessions: retrieval.maxSessions,
            scope: projectScope,
            dryRun: false,
            now: Date.now(),
          });
        } catch {
          // Environmental; ignore.
        }
      }, 30_000);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }

    // Live snapshots for the TUI footer and sidebar: one compact read over the
    // store each. Guarded: after dispose the store is closed, and a late RPC
    // call must not reopen it. Sidebar collapse state is persisted HERE (raw
    // storage domain, escaped key) because the TUI-side storage.store() throws
    // for scoped plugin ids (anomalyco/opencode#62634) — same workaround as the
    // mesh sidebar.
    const sidebarPersist = createDurableStore(
      ctx.storage,
      "@log0u7/opencode-memory",
      "memory-sidebar",
    );
    const rpc = await ctx.rpc.register(MemoryRpc, {
      snapshot: async () => {
        if (disposed) {
          return { total: 0, store_bytes: 0, top_kinds: [], all_kinds: [] };
        }
        return snapshotFromStats(
          statsEntries(getDb(), { scope: projectScope }),
          databaseSizeBytes(getDb()),
        );
      },
      sidebar: async () => {
        // No store file yet: report the fallback instead of creating a db for
        // the sidebar's sake.
        if (disposed || !existsSync(dbPath)) {
          return noStoreSidebar();
        }
        return buildSidebarSnapshot(getDb(), {
          scope: projectScope,
          now: Date.now(),
          directory: ctx.location.directory,
          cooled: lastSweepReport?.cooled ?? 0,
          inboxDir: defaultMeshInboxDir(),
          meshDataDir: defaultMeshDataDir(),
        });
      },
      sidebar_state: async () => {
        const state = await sidebarPersist.load<{ collapsed: boolean }>();
        return { collapsed: state?.collapsed === true };
      },
      set_sidebar_state: async (input: unknown) => {
        const collapsed =
          typeof input === "object" && input !== null && "collapsed" in input
            ? (input as { collapsed: unknown }).collapsed === true
            : false;
        await sidebarPersist.save({ collapsed });
        return { collapsed };
      },
      stats: async () => {
        if (disposed) {
          return { total: 0, store_bytes: 0, scopes: [], top: [] };
        }
        const db = getDb();
        const scopes = scopeBreakdown(db, { now: Date.now() });
        return {
          total: scopes.reduce((sum, row) => sum + row.count, 0),
          store_bytes: databaseSizeBytes(db),
          scopes,
          top: topEntries(db, { limit: 3, now: Date.now() }),
        };
      },
      continue: async (input: unknown) => {
        const { sessionID, target } = (input ?? {}) as { sessionID?: string; target?: string };
        if (disposed) {
          return { ok: false, message: "the memory plugin is disposed: restart the session" };
        }
        if (!retrieval.enabled) {
          return { ok: false, message: "retrieval is disabled: no transcript to continue" };
        }
        if (typeof target !== "string" || target.length === 0 || typeof sessionID !== "string") {
          return { ok: false, message: "usage: /memory continue <sessionID>" };
        }
        const scope = await ensureTranscript(target);
        if (scope === null) {
          // The failure rides the toast (the TUI shows it): no prompt, no LLM
          // turn for an error the operator already sees.
          return { ok: false, message: unexportable(target) };
        }
        const path = transcriptFilePath(retrieval.dir, scope, target);
        const text = compactionSummary(path, transcriptExcerpt(path));
        // The pointer attaches to the NEXT run without starting a turn and
        // without posing as a user message (the 2.4 synthetic path); the plain
        // prompt is the pre-2.4 fallback.
        if (typeof ctx.session.synthetic === "function") {
          await ctx.session.synthetic({ sessionID, text, resume: false });
        } else {
          await ctx.session.prompt({ sessionID, text });
        }
        return { ok: true, message: `pointer injected from ${path}` };
      },
      cleanup: async (input: unknown) => {
        const { sessionID, apply } = (input ?? {}) as { sessionID?: string; apply?: boolean };
        if (!retrieval.enabled) {
          return { report: "retrieval is disabled: nothing to sweep" };
        }
        const dryRun = apply !== true;
        const result = sweepTranscripts(retrieval.dir, {
          retentionDays: retrieval.retentionDays,
          keepRecent: retrieval.keepRecent,
          maxSessions: retrieval.maxSessions,
          scope: projectScope,
          ...(typeof sessionID === "string" ? { protectedSessionID: sessionID } : {}),
          dryRun,
          now: Date.now(),
        });
        const report =
          `${dryRun ? "dry run (pass 'apply' to delete)" : "applied"}\n` +
          formatSweepResult(result, dryRun);
        // The dialog shows the report: no prompt injection, no LLM turn for a
        // text the operator already has on screen.
        return { report };
      },
    });

    const cleanup = async () => {
      disposed = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      injected.reset();
      rpc.dispose();
      db?.close();
      db = null;
    };

    const reflection = parseReflectionConfig(options.reflection);
    if (!reflection) {
      return cleanup;
    }
    const onIdle = createReflection(reflection, {
      isSubagent: async (sessionID) => {
        const session = await ctx.session.get({ sessionID });
        return !!session.parentID;
      },
      transcript: (sessionID) => transcriptV2(ctx, sessionID),
      generate: async (prompt, _sessionID, signal) => {
        const model = modelRefV2(reflection.model);
        const result = await ctx.generate.text({ prompt, ...(model ? { model } : {}) }, { signal });
        return result.text;
      },
      saveLesson: (title, body) => {
        ops.save({ kind: "lesson", title, body, project }, projectScope, "reflection");
      },
    });
    // The host keeps the event stream alive through this controller; aborting it stops
    // the idle loop without touching the tool or session hooks. A stream that errors is
    // retried with a capped backoff instead of ending the loop for good.
    const controller = new AbortController();
    void (async () => {
      let delay = RECONNECT_MIN_MS;
      while (!controller.signal.aborted) {
        let failed = false;
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type === "session.idle") {
              onIdle(event.data.sessionID);
            }
          }
        } catch {
          failed = true;
        }
        if (!failed || controller.signal.aborted) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    })();
    return async () => {
      controller.abort();
      await cleanup();
    };
  },
});

function modelRefV2(model?: string | undefined): { providerID: string; id: string } | undefined {
  if (!model) {
    return undefined;
  }
  const [providerID, id] = model.split("/", 2);
  return providerID && id ? { providerID, id } : undefined;
}

/** The project directory a session belongs to: the host's project context when it
 * carries one, else the plugin directory. */
function projectOf(location: {
  directory: string;
  project?: { directory?: string; canonical?: string };
}): string {
  return (
    canonicalProject(location.project?.canonical ?? location.project?.directory) ??
    canonicalScope(undefined, location.directory)
  );
}
