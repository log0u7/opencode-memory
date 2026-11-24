import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import type { Entry } from "../types/entry.js";

// Code anchoring for memory entries: the commit a save was made against and the
// files it documents. Since 0.21.6 the anchor stamp also carries the git blob
// hash of each path's content at save time: freshness is then content equality,
// so a save made on a dirty tree (agent edited files, not committed yet) or on
// an untracked file is fresh at creation and stale only when a file really
// changes. Entries without content hashes keep the 0.11.0 commit-vs-worktree
// check. All checks are synchronous and bounded (2 s timeout, a handful of
// entries): the inventory builder runs inside sync host hooks.

/** The repository HEAD commit, or undefined outside a repository / on failure. */
export function currentCommitHash(directory: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const sha = result.stdout.trim();
    return result.status === 0 && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function gitStatus(root: string, args: string[]): { status: number; stdout: string } {
  try {
    const result = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return { status: 0, stdout: result };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return {
      status: typeof err.status === "number" ? err.status : -1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

/** Git blob hashes of the given paths' current content, keyed by path. One
 * bounded subprocess for all paths (`git hash-object -- <p1..pN>`, order kept).
 * Undefined when any path is missing (hash-object fails as a whole) or the
 * directory is not a repository: content anchoring then falls back to the
 * commit stamp, whose own check treats a missing path as stale. */
export function contentHashes(
  directory: string,
  paths: string[],
): Record<string, string> | undefined {
  if (paths.length === 0) return undefined;
  const result = gitStatus(resolve(directory), ["hash-object", "--", ...paths]);
  if (result.status !== 0) return undefined;
  const lines = result.stdout.split("\n").filter((line) => /^[0-9a-f]{40}$/.test(line));
  if (lines.length !== paths.length) return undefined;
  const hashes: Record<string, string> = {};
  for (const [index, path] of paths.entries()) {
    const hash = lines[index];
    if (hash === undefined) return undefined;
    hashes[path] = hash;
  }
  return hashes;
}

/** Fresh when the anchored paths still hold the content the entry was saved
 * against (content_hashes present: every path re-hashes to its saved blob) —
 * the working tree may be dirty and the paths untracked, only the bytes count,
 * and a missing path is stale. Without content hashes, the 0.11.0 check rules:
 * fresh when the anchored paths are unchanged since the anchored commit — none
 * of them is untracked, and none of them is missing. Unanchored entries (no
 * paths) are always fresh: nothing observable contradicts them. */
export function isEntryFresh(
  entry: {
    commit_sha?: string | undefined;
    paths?: string[] | undefined;
    content_hashes?: Record<string, string> | undefined;
  },
  directory: string,
): boolean {
  if (!entry.paths || entry.paths.length === 0) return true;
  const saved = entry.content_hashes;
  if (saved !== undefined && Object.keys(saved).length > 0) {
    const current = contentHashes(directory, entry.paths);
    if (current === undefined) return false;
    return entry.paths.every((path) => current[path] === saved[path]);
  }
  if (!entry.commit_sha) return true;
  if (!/^[0-9a-f]{7,64}$/i.test(entry.commit_sha)) return false;
  const root = resolve(directory);
  // A missing anchored path is stale: the entry documents a deleted file.
  for (const path of entry.paths) {
    try {
      statSync(resolve(root, path));
    } catch {
      return false;
    }
  }
  const diff = gitStatus(root, ["diff", "--quiet", entry.commit_sha, "--", ...entry.paths]);
  const untracked = gitStatus(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...entry.paths,
  ]);
  return diff.status === 0 && untracked.status === 0 && untracked.stdout.trim() === "";
}
