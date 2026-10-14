import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import {
  TOOL_DESCRIPTIONS,
  createMemoryOps,
  memoryInventory,
  oncePerSession,
} from "./lib/memory-ops.js";
import {
  parseReflectionConfig,
  type ReflectionConfig,
  createReflection,
} from "./lib/reflection.js";
import { canonicalScope } from "./lib/store.js";

export type PluginOptions = {
  dbPath?: string;
  reflection?: unknown;
};

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

export const SYSTEM_GUIDANCE = `You have persistent working memory shared with all OpenCode sessions on this machine.
Recent entries are listed above when present; run memory_search for anything older or more specific.
When you make a durable decision or learn a lasting fact, call memory_save (kinds: decision, fact, preference, gotcha).
When a non-obvious approach clearly fails or succeeds, save the lesson (kind=lesson) as soon as it is confirmed, and check stored lessons before retrying a failed approach.
Never store credentials, tokens, or API keys in memory; the store refuses them.`;

export const COMPACTION_CONTEXT =
  "The session is being compacted. After compaction, call memory_save for every durable decision still relevant " +
  "(kind=decision), any newly learned facts (kind=fact), and every reusable lesson confirmed this session " +
  "(kind=lesson), so other sessions keep this knowledge.";

export function defaultDbPath(options?: PluginOptions): string {
  if (typeof options?.dbPath === "string" && options.dbPath.length > 0) {
    return options.dbPath;
  }
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
  return `${dataHome}/opencode-memory/memory.db`;
}

/**
 * Scope of a session: the v1 tool context carries a worktree, so that is the canonical
 * key. `directory` is the fallback so the same project does not get two scopes.
 */
export function defaultScope(worktree?: string, directory?: string): string {
  return canonicalScope(worktree, directory);
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
      ops.save({ kind: "lesson", title, body }, projectScope);
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
  const ops = createMemoryOps(getDb);
  // Request and compaction hooks carry no directory: the instance scope is the project.
  const projectScope = defaultScope(input.worktree, input.directory);
  const injected = oncePerSession();
  const reflection = parseReflectionConfig(options?.reflection);

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
        },
        execute: async (args, context) =>
          ops.save(args, defaultScope(args.scope ?? context.worktree ?? context.directory)),
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
      output.system.push(SYSTEM_GUIDANCE);
      if (disposed) {
        return;
      }
      const inventory = injected.inject(input.sessionID, () =>
        memoryInventory(getDb, dbPath, projectScope),
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
      const inventory = memoryInventory(getDb, dbPath, projectScope);
      if (inventory !== null) {
        output.context.push(inventory);
      }
    },
    dispose: async () => {
      disposed = true;
      injected.reset();
      db?.close();
      db = null;
    },
  };
};
