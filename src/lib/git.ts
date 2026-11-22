import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import type { Entry } from "../types/entry.js";

// Code anchoring for memory entries: the commit a save was made against and the
// files it documents. An anchored entry is stale when any of its paths changed
// since that commit (or is untracked) — the same rule workflow-guard applies.
// All checks are synchronous and bounded (2 s timeout, a handful of entries):
// the inventory builder runs inside sync host hooks.

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

/** Fresh when the anchored paths are unchanged since the anchored commit — none
 * of them is untracked, and none of them is missing (an entry documenting a
 * deleted file is stale). Unanchored entries (no paths or no commit) are always
 * fresh: nothing observable contradicts them. */
export function isEntryFresh(entry: Entry, directory: string): boolean {
  if (!entry.commit_sha || !entry.paths || entry.paths.length === 0) return true;
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
