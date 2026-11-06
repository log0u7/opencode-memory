import { existsSync, unlinkSync } from "node:fs";

import { Plugin } from "@opencode/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import { databaseSizeBytes } from "./lib/db.js";
import {
  TOOL_DESCRIPTIONS,
  createMemoryOps,
  memoryInventory,
  oncePerSession,
} from "./lib/memory-ops.js";
import { createReflection, parseReflectionConfig } from "./lib/reflection.js";
import {
  SYSTEM_GUIDANCE,
  COMPACTION_CONTEXT,
  defaultScope,
  defaultDbPath,
  parseRetrievalConfig,
  type PluginOptions,
} from "./options.js";
import { canonicalScope, stats as statsEntries } from "./lib/store.js";
import { MemoryRpc, snapshotFromStats } from "./rpc.js";
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
    const ops = createMemoryOps(getDb);

    // Request and compaction hooks carry no directory: the instance scope is the project.
    const projectScope = defaultScope(undefined, ctx.location.directory);
    const retrieval = parseRetrievalConfig(options);
    const injected = oncePerSession();

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

    if (retrieval.enabled) {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "memory-continue",
          description:
            "Continue a past session in this one: export its transcript if needed and inject the retrieval pointer",
          execute: async ({ sessionID, prompt, delivery }) => {
            const target = prompt.text.trim();
            if (target.length === 0) {
              await ctx.session.prompt({
                sessionID,
                text: "Pass the session id to continue: /memory-continue <sessionID>. The session's transcript is exported on demand and the retrieval pointer lands here.",
                delivery,
              });
              return;
            }
            const scope = await ensureTranscript(target);
            let text: string;
            if (scope === null) {
              text = unexportable(target);
            } else {
              const path = transcriptFilePath(retrieval.dir, scope, target);
              text = compactionSummary(path, transcriptExcerpt(path));
            }
            await ctx.session.prompt({ sessionID, text, delivery });
          },
        });
        editor.add({
          name: "memory-cleanup",
          description:
            "Sweep exported session transcripts per the retention policy (dry run by default): " +
            "report eligible files, then remove when confirmed.",
          execute: async ({ sessionID, prompt, delivery }) => {
            const arg = prompt.text.trim().toLowerCase();
            const dryRun = arg !== "apply" && arg !== "run" && arg !== "yes";
            const result = sweepTranscripts(retrieval.dir, {
              retentionDays: retrieval.retentionDays,
              keepRecent: retrieval.keepRecent,
              maxSessions: retrieval.maxSessions,
              scope: projectScope,
              protectedSessionID: sessionID,
              dryRun,
              now: Date.now(),
            });
            const text =
              `${dryRun ? "dry run (pass 'apply' to delete)" : "applied"}\n` +
              formatSweepResult(result, dryRun);
            await ctx.session.prompt({ sessionID, text, delivery });
          },
        });
      });
    }

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
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
            expires_at: { type: "number", description: "Optional epoch ms expiry" },
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
          };
          return {
            content: ops.save(
              a,
              defaultScope(undefined, a.scope ?? ctx.location.directory),
              context.agent,
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
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { query: string; scope?: string; limit?: number };
          return {
            content: ops.search(
              { query: a.query, ...(a.limit !== undefined ? { limit: a.limit } : {}) },
              defaultScope(undefined, a.scope ?? ctx.location.directory),
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
            limit: { type: "number", description: "Max results (default 20)" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { scope?: string; limit?: number };
          return {
            content: ops.list(
              a.limit !== undefined ? { limit: a.limit } : {},
              defaultScope(undefined, a.scope ?? ctx.location.directory),
            ),
          };
        },
      });

      editor.add({
        name: "memory_forget",
        description: TOOL_DESCRIPTIONS.forget,
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Entry id to delete" },
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
            id: { type: "string", description: "Id of a trashed entry to put back" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { id: string };
          return { content: ops.restore(a) };
        },
      });

      if (!retrieval.enabled) {
        return;
      }

      editor.add({
        name: "memory_session_search",
        description:
          "Search past session transcripts (verbatim compaction exports) for exact lines: " +
          "errors, paths, numbers, decisions. Returns matching lines with line numbers and " +
          "surrounding context. After a compaction, retrieve facts here instead of guessing.",
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
          "Read a numbered window of a past session transcript by 1-based line number. Use it " +
          "after memory_session_search to pull the exact block around a match.",
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
          "so storage usage is visible before any cleanup.",
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
          "Sweep exported session transcripts per the retention policy. Defaults to a dry run " +
          "(report only). Pass apply:true to actually remove. retentionDays/keepRecent/maxSessions " +
          "override the configured policy for this call; sessionIDs limits the sweep to those sessions.",
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
    // once-per-session inventory.
    await ctx.session.hook("context", (event) => {
      event.system.push(textPart(SYSTEM_GUIDANCE));
      if (disposed) {
        return;
      }
      const inventory = injected.inject(event.sessionID, () =>
        memoryInventory(getDb, dbPath, projectScope),
      );
      if (inventory !== null) {
        event.system.push(textPart(inventory));
      }
    });

    // experimental.session.compacting -> compaction hook. When retrieval is enabled the
    // transcript is exported verbatim and event.result replaces the model-written summary:
    // the summary model call is skipped entirely.
    await ctx.session.hook("compaction", (event) => {
      event.system.push(textPart(COMPACTION_CONTEXT));
      if (disposed) {
        return;
      }
      const inventory = memoryInventory(getDb, dbPath, projectScope);
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

    // Live snapshot for the TUI footer: one compact read over the store. Guarded:
    // after dispose the store is closed, and a late RPC call must not reopen it.
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
    });

    const cleanup = async () => {
      disposed = true;
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
        ops.save({ kind: "lesson", title, body }, projectScope, "reflection");
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
