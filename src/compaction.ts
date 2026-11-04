import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { TranscriptMeta, TranscriptMessage } from "./transcripts.js";
import { renderTranscript } from "./transcripts.js";

// Retrieval replaces the lossy compaction summary: the transcript is exported verbatim to a
// greppable file and the compaction result becomes a short pointer instead of a model-written
// summary. The model call for the summary is skipped entirely (event.result), which is the
// whole point: no re-tokenization of the full history, nothing paraphrased.

const EXCERPT_MAX = 200;
const POSIX = process.platform !== "win32";

export type CompactionInput = {
  sessionID: string;
  model?: string;
  messages?: ReadonlyArray<TranscriptMessage>;
};

export type RetrievalRuntime = {
  dir: string;
  scope: string;
};

/** The most recent user request, one line, capped: the anchor the compacted session starts from. */
export function lastUserExcerpt(
  messages: ReadonlyArray<TranscriptMessage>,
  max: number = EXCERPT_MAX,
): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  if (!last) {
    return "";
  }
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .filter((part) => part.type === "text")
          .map((part) => String(part.text ?? ""))
          .join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** One directory per project scope (percent-encoded: 1:1, filesystem-safe), one file per
 * session. The session id is percent-encoded too: real ids are unchanged by it, and a
 * hostile id cannot escape the transcripts directory. */
export function transcriptFilePath(dir: string, scope: string, sessionID: string): string {
  return join(dir, encodeURIComponent(scope), `${encodeURIComponent(sessionID)}.md`);
}

/** Atomic, idempotent write. Modes are enforced explicitly (not left to the umask): the
 * transcript holds the full session history, so 0700/0600 always. */
export function writeTranscriptFile(path: string, content: string): void {
  const scopeDir = dirname(path);
  mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
  if (POSIX) {
    chmodSync(scopeDir, 0o700);
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  if (POSIX) {
    chmodSync(tmp, 0o600);
  }
  renameSync(tmp, path);
}

/** The last user request as recorded in an exported transcript file: the first non-empty
 * line after the final "## user" heading, collapsed to one line. Used to anchor pointers
 * (compaction result, /memory-continue) without keeping messages in memory. */
export function transcriptExcerpt(path: string, max: number = 200): string {
  const lines = readFileSync(path, "utf8").split("\n");
  let heading = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index] === "## user") {
      heading = index;
      break;
    }
  }
  if (heading < 0) {
    return "";
  }
  for (let index = heading + 1; index < lines.length; index++) {
    const line = (lines[index] ?? "").trim();
    if (line.length > 0 && !line.startsWith("## ")) {
      return line.replace(/\s+/g, " ").slice(0, max);
    }
  }
  return "";
}

export function compactionSummary(path: string | null, excerpt: string): string {
  if (path === null) {
    return (
      "Context compacted; the full transcript is unavailable (no messages to export). " +
      "memory_session_search has no transcript for this session. " +
      "Save durable knowledge with memory_save (kind=decision, fact, or lesson)."
    );
  }
  return (
    `Context compacted. Full verbatim transcript of this session: ${path}.\n` +
    `Last user request: ${excerpt.length > 0 ? excerpt : "(none captured)"}.\n` +
    "Working rule: retrieve exact details (errors, paths, numbers, decisions) from the transcript " +
    "with memory_session_search and memory_session_read as you go. Never guess: retrieve.\n" +
    "Also save durable knowledge from before this point with memory_save (kind=decision, fact, or lesson) " +
    "so other sessions keep it."
  );
}

/** Export the transcript and return the pointer summary. Idempotent: the same messages always
 * produce the same file bytes and the same summary. Returns no path when there is nothing to
 * export (missing sessionID or empty message list), with a summary that still points forward. */
export function handleCompaction(
  input: CompactionInput,
  runtime: RetrievalRuntime,
  options?: { inlineOutputMaxBytes?: number },
): { summary: string; path: string | null } {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  if (
    typeof input.sessionID !== "string" ||
    input.sessionID.length === 0 ||
    messages.length === 0
  ) {
    return { summary: compactionSummary(null, ""), path: null };
  }
  const meta: TranscriptMeta = {
    sessionID: input.sessionID,
    scope: runtime.scope,
    ...(input.model ? { model: input.model } : {}),
  };
  const path = transcriptFilePath(runtime.dir, runtime.scope, input.sessionID);
  writeTranscriptFile(path, renderTranscript(messages, meta, options));
  return { summary: compactionSummary(path, lastUserExcerpt(messages)), path };
}
