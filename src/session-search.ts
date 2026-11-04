import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Bounded retrieval over exported session transcripts. Everything returns plain text with
// line numbers so the agent can cite `file:line` back into the transcript and read a wider
// window with readTranscript. Output is byte-capped: a retrieval tool that dumps 2 MB into
// the context defeats its own purpose.

const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 10;
const DEFAULT_MAX_BYTES = 20_000;
const MAX_MAX_BYTES = 100_000;
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 500;

export type SearchInput = {
  query: string;
  sessionID?: string;
  /** Search every project's transcripts on this machine, not just this scope's. */
  all?: boolean;
  contextLines?: number;
  maxBytes?: number;
};

export type ReadInput = {
  sessionID: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
};

type SessionFile = { name: string; path: string; mtime: number; scope?: string };

function scopeDir(dir: string, scope: string): string {
  return join(dir, encodeURIComponent(scope));
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function filesInDir(scopeDirPath: string, scope?: string): SessionFile[] {
  return readdirSync(scopeDirPath)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => {
      const path = join(scopeDirPath, name);
      if (!isRegularFile(path)) {
        return [];
      }
      return [
        {
          name,
          path,
          mtime: statSync(path).mtimeMs,
          ...(scope !== undefined ? { scope } : {}),
        },
      ];
    });
}

/** Newest first, so the sessions the agent most likely continues from come first. */
function listSessionFiles(dir: string, scope: string, all = false): SessionFile[] {
  if (all) {
    let scopeDirs: string[];
    try {
      scopeDirs = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return scopeDirs
      .flatMap((encoded) => {
        try {
          return filesInDir(join(dir, encoded), decodeURIComponent(encoded));
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
  try {
    return filesInDir(scopeDir(dir, scope));
  } catch {
    return [];
  }
}

function availableList(files: SessionFile[]): string {
  return files.length > 0 ? files.map((file) => file.name).join(", ") : "none";
}

function missingSession(sessionID: string, files: SessionFile[]): string {
  return `no transcript for session ${sessionID}; available: ${availableList(files)}`;
}

function clampInt(value: number | undefined, fallback: number, max: number, min = 1): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function searchTranscripts(dir: string, scope: string, input: SearchInput): string {
  const needle = input.query.toLowerCase();
  const context = clampInt(input.contextLines, DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES, 0);
  const budget = clampInt(input.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES, 200);

  const files = listSessionFiles(dir, scope, input.all === true);
  if (files.length === 0) {
    return "no transcript for this scope yet: compaction exports land here";
  }
  const wanted = input.sessionID;
  const targets =
    typeof wanted === "string" && wanted.length > 0
      ? files.filter((file) => file.name === `${encodeURIComponent(wanted)}.md`)
      : files;
  if (targets.length === 0) {
    return missingSession(String(input.sessionID), files);
  }

  const blocks: string[] = [];
  let size = 0;
  let hits = 0;
  for (const file of targets) {
    const lines = readFileSync(file.path, "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!line.toLowerCase().includes(needle)) {
        continue;
      }
      hits++;
      const label = file.scope !== undefined ? `${file.scope}/${file.name}` : file.name;
      const numbered = [`  ${index + 1}: ${line}`];
      for (
        let j = Math.max(0, index - context);
        j <= Math.min(lines.length - 1, index + context);
        j++
      ) {
        if (j !== index) {
          numbered.push(`  ${j + 1}: ${lines[j] ?? ""}`);
        }
      }
      let block = `${label}:${index + 1}: ${line}\n${numbered.join("\n")}\n`;
      if (block.length > budget) {
        block = `${block.slice(0, budget)}\n[output capped at ${budget} bytes]\n`;
      }
      if (size + block.length > budget) {
        blocks.push(`[output capped at ${budget} bytes]`);
        return blocks.join("\n");
      }
      blocks.push(block);
      size += block.length;
    }
  }
  if (hits === 0) {
    return `no match for ${JSON.stringify(input.query)} in ${targets.length} transcript(s)`;
  }
  return blocks.join("\n");
}

export function readTranscript(dir: string, scope: string, input: ReadInput): string {
  const files = listSessionFiles(dir, scope);
  const file = files.find((entry) => entry.name === `${encodeURIComponent(input.sessionID)}.md`);
  if (!file) {
    return missingSession(input.sessionID, files);
  }
  const lines = readFileSync(file.path, "utf8").split("\n");
  const total = lines.length;
  const offset =
    typeof input.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(1, Math.floor(input.offset))
      : 1;
  const requestedLimit = input.limit;
  const limit = clampInt(requestedLimit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  const budget = clampInt(input.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES, 200);

  if (offset > total) {
    return `offset ${offset} is past the end of transcript (${total} lines)`;
  }
  const window: string[] = [];
  let size = 0;
  for (let index = offset - 1; index < Math.min(offset - 1 + limit, total); index++) {
    const rendered = `${index + 1}: ${lines[index] ?? ""}`;
    if (size + rendered.length + 1 > budget) {
      window.push(`[output capped at ${budget} bytes]`);
      break;
    }
    window.push(rendered);
    size += rendered.length + 1;
  }
  if (typeof requestedLimit === "number" && requestedLimit > MAX_READ_LIMIT) {
    window.push(`[window capped at ${MAX_READ_LIMIT} lines]`);
  }
  return window.join("\n");
}
