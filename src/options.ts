import { canonicalScope } from "./lib/store.js";
import { INLINE_OUTPUT_MAX_BYTES } from "./transcripts.js";

// Shared option plumbing and scope constants for both host generations. This
// module sits in the STATIC import graph of the package (the v2 adapter
// imports it directly), so it must never import a host-provided package: see
// scripts/smoke-dist.mjs.

export type RetrievalOptions = {
  enabled?: boolean;
  dir?: string;
  inlineOutputMaxBytes?: number;
  /** Delete transcripts older than this many days. 0 (default) disables age-based deletion. */
  retentionDays?: number;
  /** Always keep this many newest transcripts per scope, regardless of age. Default 10. */
  keepRecent?: number;
  /** Hard cap on transcripts per scope (newest kept). 0 (default) disables the cap. */
  maxSessions?: number;
  /** Run the retention sweep automatically when enabled. Default true. */
  autoSweep?: boolean;
};

export type PluginOptions = {
  dbPath?: string;
  reflection?: unknown;
  retrieval?: RetrievalOptions;
};

export const SYSTEM_GUIDANCE = `You have persistent working memory shared with all OpenCode sessions on this machine.
Recent entries are listed above when present; run memory_search for anything older or more specific.
When you make a durable decision or learn a lasting fact, call memory_save (kinds: decision, fact, preference, gotcha).
When a non-obvious approach clearly fails or succeeds, save the lesson (kind=lesson) as soon as it is confirmed, and check stored lessons before retrying a failed approach.
Never store credentials, tokens, or API keys in memory; the store refuses them.`;

export const COMPACTION_CONTEXT =
  "The session is being compacted. After compaction, call memory_save for every durable decision still relevant " +
  "(kind=decision), any newly learned facts (kind=fact), and every reusable lesson confirmed this session " +
  "(kind=lesson), so other sessions keep this knowledge.";

export function defaultDataHome(): string {
  return process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
}

export function defaultDbPath(options?: PluginOptions): string {
  if (typeof options?.dbPath === "string" && options.dbPath.length > 0) {
    return options.dbPath;
  }
  return `${defaultDataHome()}/opencode-memory/memory.db`;
}

export function defaultTranscriptsDir(options?: PluginOptions): string {
  const configured = options?.retrieval?.dir;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return `${defaultDataHome()}/opencode-memory/transcripts`;
}

export type RetrievalConfig = {
  enabled: boolean;
  dir: string;
  inlineOutputMaxBytes: number;
  retentionDays: number;
  keepRecent: number;
  maxSessions: number;
  autoSweep: boolean;
};

export function parseRetrievalConfig(options?: PluginOptions): RetrievalConfig {
  const bytes = options?.retrieval?.inlineOutputMaxBytes;
  const retentionDays =
    typeof options?.retrieval?.retentionDays === "number" &&
    Number.isFinite(options.retrieval.retentionDays) &&
    options.retrieval.retentionDays > 0
      ? Math.floor(options.retrieval.retentionDays)
      : 0;
  const keepRecentRaw = options?.retrieval?.keepRecent;
  const keepRecent =
    typeof keepRecentRaw === "number" && Number.isFinite(keepRecentRaw) && keepRecentRaw > 0
      ? Math.max(1, Math.floor(keepRecentRaw))
      : 10;
  const maxSessionsRaw = options?.retrieval?.maxSessions;
  const maxSessions =
    typeof maxSessionsRaw === "number" && Number.isFinite(maxSessionsRaw) && maxSessionsRaw > 0
      ? Math.floor(maxSessionsRaw)
      : 0;
  const autoSweep = options?.retrieval?.autoSweep !== false;
  return {
    enabled: options?.retrieval?.enabled !== false,
    dir: defaultTranscriptsDir(options),
    // 128 keeps the truncation marker smaller than the cap for degenerate configs.
    inlineOutputMaxBytes:
      typeof bytes === "number" && bytes > 0 ? Math.max(128, bytes) : INLINE_OUTPUT_MAX_BYTES,
    retentionDays,
    keepRecent,
    maxSessions,
    autoSweep,
  };
}

/**
 * Scope of a session: the v1 tool context carries a worktree, so that is the canonical
 * key. `directory` is the fallback so the same project does not get two scopes.
 */
export function defaultScope(worktree?: string, directory?: string): string {
  return canonicalScope(worktree, directory);
}
