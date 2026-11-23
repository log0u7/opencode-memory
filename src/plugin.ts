import { existsSync } from "node:fs";

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import {
  HOUSEKEEPING_INTERVAL_MS,
  sweepHousekeeping,
  type HousekeepingReport,
} from "./lib/housekeeping.js";
import {
  TOOL_DESCRIPTIONS,
  createMemoryOps,
  memoryInventory,
  oncePerSession,
} from "./lib/memory-ops.js";
import { currentCommitHash } from "./lib/git.js";
import {
  parseReflectionActivation,
  parseReflectionConfig,
  reflectionGuidance,
  type ReflectionConfig,
  createReflection,
} from "./lib/reflection.js";
import {
  COMPACTION_CONTEXT,
  defaultDbPath,
  defaultScope,
  parseHousekeepingConfig,
  SYSTEM_GUIDANCE,
  type PluginOptions,
} from "./options.js";

export const REFLECTION_SESSION_TITLE = "[memory-reflect] lessons";
const REFLECTION_SYSTEM =
  "You extract durable lessons for a memory store. Reply with the JSON array only; do not call any tool.";

type V1SessionMessage = { info: { role: string }; parts: Array<{ type: string; text?: string }> };

function transcriptText(messages: V1SessionMessage[], chars: number): string {
  const lines: string[] = [];
  for (const { info, parts } of messages) {
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" ")
      .trim();
    if (text) {
      lines.push(`${info.role}: ${text}`);
    }
  }
  return lines.join("\n").slice(-chars);
}

/** One ephemeral child session per reflection: the transcript tail is distilled with a
 * synchronous prompt on that child (system pins the model to JSON-only, no tools), the
 * reply is parsed here, and the child is deleted. Fire-and-forget: the host event loop
 * never waits on the LLM. */
function reflectionDeps(
  client: PluginInput["client"],
  config: ReflectionConfig,
  ops: ReturnType<typeof createMemoryOps>,
  projectScope: string,
) {
  const model = modelRef(config.model);
  return {
    isSubagent: async (sessionID: string) => {
      const session = await client.session.get({ path: { id: sessionID } });
      return !!session.data?.parentID;
    },
    transcript: async (sessionID: string) => {
      const result = await client.session.messages({ path: { id: sessionID } });
      return transcriptText(result.data ?? [], config.transcriptChars);
    },
    generate: async (prompt: string, sessionID: string, signal: AbortSignal) => {
      const child = await client.session.create({
        body: { parentID: sessionID, title: REFLECTION_SESSION_TITLE },
      });
      const id = child.data?.id;
      if (!id) {
        throw new Error("reflection session could not be created");
      }
      try {
        const reply = await client.session.prompt({
          path: { id },
          body: {
            parts: [{ type: "text", text: prompt }],
            system: REFLECTION_SYSTEM,
            ...(model ? { model } : {}),
          },
          signal,
        });
        return (reply.data?.parts ?? [])
          .filter((part) => part.type === "text")
          .map((part) => (part as { text?: string }).text ?? "")
          .join("\n");
      } finally {
        await client.session.delete({ path: { id } }).catch(() => {});
      }
    },
    saveLesson: (title: string, body: string) => {
      ops.save({ kind: "lesson", title, body }, projectScope, "reflection");
    },
  };
}

function modelRef(model?: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) {
    return undefined;
  }
  const [providerID, modelID] = model.split("/", 2);
  return providerID && modelID ? { providerID, modelID } : undefined;
}

export const MemoryPlugin: Plugin = async (input, options?: PluginOptions) => {
  const dbPath = defaultDbPath(options);
  let db: MemoryDb | null = null;
  let disposed = false;
  // After dispose the store is closed for good: a late path (tool call, in-flight
  // reflection) must not silently reopen a connection that nobody closes again.
  const getDb = (): MemoryDb => {
    if (disposed) {
      throw new Error("memory store is closed");
    }
    db ??= openMemoryDb(dbPath);
    return db;
  };
  const injected = oncePerSession();
  // The inference-only reflection loop: the standing directive plus a per-day lesson
  // budget (the deep-reflection config's maxLessons doubles as the budget).
  const reflectionLoop = parseReflectionActivation(options?.reflection);
  const ops = createMemoryOps(getDb, {
    onLessonSaved: () => injected.reset(),
    ...(reflectionLoop.enabled ? { lessonBudgetPerDay: reflectionLoop.maxPerDay } : {}),
  });
  // Request and compaction hooks carry no directory: the instance scope is the project.
  const projectScope = defaultScope(input.worktree, input.directory);
  const reflection = parseReflectionConfig(options?.reflection);
  const guidance = reflectionLoop.enabled
    ? `${SYSTEM_GUIDANCE}\n${reflectionGuidance(reflectionLoop.maxPerDay)}`
    : SYSTEM_GUIDANCE;
  const inventoryDir = input.directory ?? input.worktree ?? process.cwd();

  // Conservative automatic housekeeping: once at boot, then daily. A missing store
  // has nothing to sweep and must not be created for the sweep's sake; a failed
  // sweep (locked db, full disk) is environmental and must not break the host.
  const housekeeping = parseHousekeepingConfig(options);
  const runHousekeeping = (): HousekeepingReport | null => {
    if (disposed || !housekeeping.enabled || !existsSync(dbPath)) {
      return null;
    }
    try {
      return sweepHousekeeping(getDb(), {
        scope: projectScope,
        ttlMs: housekeeping.ttlMs,
        now: Date.now(),
        directory: inventoryDir,
      });
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

  const hooks: Hooks = {
    tool: {
      memory_save: tool({
        description: TOOL_DESCRIPTIONS.save,
        args: {
          kind: tool.schema
            .string()
            .describe("Entry type, e.g. decision, fact, preference, gotcha, lesson"),
          title: tool.schema.string().describe("Short title (max 120 chars)"),
          body: tool.schema.string().describe("Entry content (max 8000 chars)"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags"),
          expires_at: tool.schema.number().optional().describe("Optional epoch ms expiry"),
          paths: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "Files the entry documents (relative project paths): the entry is stale when any of them changes",
            ),
          supersedes: tool.schema.string().optional().describe("Id of the entry this one replaces"),
          shareable: tool.schema
            .boolean()
            .optional()
            .describe(
              "Publish without peer endorsement: the author vouches for the entry (default false)",
            ),
        },
        execute: async (args, context) =>
          ops.save(
            {
              ...args,
              commit_sha: currentCommitHash(context.directory ?? context.worktree ?? process.cwd()),
            },
            defaultScope(args.scope ?? context.worktree ?? context.directory),
            context.agent,
          ),
      }),

      memory_search: tool({
        description: TOOL_DESCRIPTIONS.search,
        args: {
          query: tool.schema.string().describe("Free-text query"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          limit: tool.schema.number().optional().describe("Max results (default 10)"),
        },
        execute: async (args, context) =>
          ops.search(
            { query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) },
            defaultScope(args.scope ?? context.worktree ?? context.directory),
          ),
      }),

      memory_list: tool({
        description: TOOL_DESCRIPTIONS.list,
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          limit: tool.schema.number().optional().describe("Max results (default 20)"),
        },
        execute: async (args, context) =>
          ops.list(
            args.limit !== undefined ? { limit: args.limit } : {},
            defaultScope(args.scope ?? context.worktree ?? context.directory),
          ),
      }),

      memory_get: tool({
        description: TOOL_DESCRIPTIONS.get,
        args: {
          id: tool.schema.string().describe("Entry id to fetch in full"),
        },
        execute: async (args) => ops.get(args),
      }),

      memory_forget: tool({
        description: TOOL_DESCRIPTIONS.forget,
        args: {
          id: tool.schema.string().optional().describe("Entry id to delete"),
          query: tool.schema.string().optional().describe("Delete every entry matching a query"),
        },
        execute: async (args, context) =>
          ops.forget(args, defaultScope(context.worktree, context.directory)),
      }),

      memory_stats: tool({
        description: TOOL_DESCRIPTIONS.stats,
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
        },
        execute: async (args, context) =>
          ops.stats(defaultScope(args.scope ?? context.worktree ?? context.directory)),
      }),

      memory_restore: tool({
        description: TOOL_DESCRIPTIONS.restore,
        args: {
          id: tool.schema.string().describe("Id of a trashed entry to put back"),
        },
        execute: async (args) => ops.restore(args),
      }),

      memory_endorse: tool({
        description: TOOL_DESCRIPTIONS.endorse,
        args: {
          id: tool.schema.string().describe("Entry id to endorse"),
          endorser: tool.schema
            .string()
            .optional()
            .describe("Endorsing agent; defaults to the calling agent"),
        },
        execute: async (args, context) => ops.endorse(args, context.agent),
      }),

      memory_sweep: tool({
        description: TOOL_DESCRIPTIONS.sweep,
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          ttl_days: tool.schema
            .number()
            .optional()
            .describe("Override the dated-rule staleness TTL in days (default 7)"),
        },
        execute: async (args, context) =>
          ops.sweep(args, defaultScope(args.scope ?? context.worktree ?? context.directory), {
            directory: context.directory ?? context.worktree ?? process.cwd(),
          }),
      }),

      memory_export: tool({
        description: TOOL_DESCRIPTIONS.exportEntries,
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          path: tool.schema
            .string()
            .optional()
            .describe(
              "JSONL file path; default .opencode/memory/memory-export.jsonl in the project",
            ),
        },
        execute: async (args, context) =>
          ops.exportEntries(
            args,
            defaultScope(args.scope ?? context.worktree ?? context.directory),
          ),
      }),

      memory_import: tool({
        description: TOOL_DESCRIPTIONS.importEntries,
        args: {
          path: tool.schema
            .string()
            .optional()
            .describe(
              "JSONL file path; default .opencode/memory/memory-export.jsonl in the project",
            ),
        },
        execute: async (args, context) =>
          ops.importEntries(args, defaultScope(context.worktree, context.directory)),
      }),
    },
  };

  if (reflection) {
    const onIdle = createReflection(
      reflection,
      reflectionDeps(input.client, reflection, ops, projectScope),
    );
    hooks.event = async ({ event }) => {
      if (event.type === "session.idle") {
        onIdle(event.properties.sessionID);
      }
    };
  }

  return {
    ...hooks,
    "experimental.chat.system.transform": async (input, output) => {
      output.system.push(guidance);
      if (disposed) {
        return;
      }
      const inventory = injected.inject(input.sessionID, () =>
        memoryInventory(getDb, dbPath, projectScope, { directory: inventoryDir }),
      );
      if (inventory !== null) {
        output.system.push(inventory);
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(COMPACTION_CONTEXT);
      if (disposed) {
        return;
      }
      const inventory = memoryInventory(getDb, dbPath, projectScope, { directory: inventoryDir });
      if (inventory !== null) {
        output.context.push(inventory);
      }
    },
    dispose: async () => {
      disposed = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      injected.reset();
      db?.close();
      db = null;
    },
  };
};
