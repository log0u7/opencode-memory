import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Code anchoring for memory entries: the commit a save was made against and the
// files it documents. Since 0.21.6 the anchor stamp also carries the git blob
// hash of each path's content at save time: freshness is then content equality,
// so a save made on a dirty tree (agent edited files, not committed yet) or on
// an untracked file is fresh at creation and stale only when a file really
// changes. Since 0.25.0 the paths are stored relative to the repository ROOT
// (the entry carries the root), so a check from any sub-directory — or of a
// global entry viewed from another project — hashes the same bytes. All checks
// are synchronous and bounded (2 s timeout): the inventory builder runs inside
// sync host hooks, and batches its probes (one `hash-object` per root) so a
// full inventory costs one subprocess per root, not one per entry.

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

/** Memoized repository root per directory: rev-parse is a subprocess, and the
 * same session directory is resolved on every inventory, sidebar probe and
 * sweep. shortcut: the memo never expires — a directory's repo root is stable
 * for the life of the process (re-cloning under a live session is not a
 * supported flow), and the cache is capped, not TTL'd. */
const GIT_ROOT_MEMO_MAX = 512;
const gitRoots = new Map<string, string | undefined>();

/** The working-tree root of the repository containing directory, or undefined
 * outside a repository / on failure. */
export function gitRoot(directory: string): string | undefined {
  const key = resolve(directory);
  const hit = gitRoots.get(key);
  if (hit !== undefined || gitRoots.has(key)) {
    return hit;
  }
  let root: string | undefined;
  try {
    const result = spawnSync("git", ["-C", key, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const out = result.stdout.trim();
    root = result.status === 0 && out.length > 0 ? out : undefined;
  } catch {
    root = undefined;
  }
  if (gitRoots.size >= GIT_ROOT_MEMO_MAX) {
    gitRoots.delete(gitRoots.keys().next().value as string);
  }
  gitRoots.set(key, root);
  return root;
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

/** What a freshness probe needs from an entry. `repo_root` is the git root the
 * paths resolve from, stamped at save (undefined on pre-0.25.0 rows). */
export type FreshnessProbe = {
  commit_sha?: string | undefined;
  paths?: string[] | undefined;
  content_hashes?: Record<string, string> | undefined;
  repo_root?: string | undefined;
};

/** The root an entry's anchored paths resolve from: the repo the entry was
 * saved in when it still exists there (a global entry viewed from another
 * project anchors to its own files, not to whatever sits at the same relative
 * path in the observer's repo), else the observing session's root. The
 * session root is resolved lazily, so a batch of root-stamped entries never
 * pays the rev-parse at all. */
export function probeRoot(entry: FreshnessProbe, sessionRoot: string | (() => string)): string {
  if (entry.repo_root !== undefined && existsSync(entry.repo_root)) {
    return entry.repo_root;
  }
  return typeof sessionRoot === "function" ? sessionRoot() : sessionRoot;
}

/** Freshness verdicts for a batch of entries, aligned with the input order.
 * Unanchored entries are fresh with no probe at all. Content-stamped entries
 * are grouped by their probe root and re-hashed with ONE `hash-object` per
 * root; per-path misses are caught by stat first, because hash-object fails as
 * a whole on one missing file while a missing path is stale only for its own
 * entry. Entries without content stamps keep the 0.11.0 commit-vs-worktree
 * check (diff + ls-files, per entry). */
export function areEntriesFresh(entries: FreshnessProbe[], directory: string): boolean[] {
  const sessionRoot = (): string => gitRoot(directory) ?? resolve(directory);
  const verdicts = new Array<boolean>(entries.length);
  const byRoot = new Map<string, { index: number; entry: FreshnessProbe }[]>();
  for (const [index, entry] of entries.entries()) {
    if (!entry.paths || entry.paths.length === 0) {
      verdicts[index] = true;
      continue;
    }
    const saved = entry.content_hashes;
    if (saved !== undefined && Object.keys(saved).length > 0) {
      const root = probeRoot(entry, sessionRoot);
      const group = byRoot.get(root);
      if (group === undefined) {
        byRoot.set(root, [{ index, entry }]);
      } else {
        group.push({ index, entry });
      }
      continue;
    }
    verdicts[index] = commitAnchoredFresh(entry, sessionRoot);
  }
  for (const [root, group] of byRoot) {
    const unique = new Set<string>();
    for (const { entry } of group) {
      for (const path of entry.paths ?? []) {
        unique.add(path);
      }
    }
    const missing = new Set<string>();
    for (const path of unique) {
      if (!existsSync(resolve(root, path))) {
        missing.add(path);
      }
    }
    const hashable = [...unique].filter((path) => !missing.has(path));
    const hashes = hashable.length > 0 ? contentHashes(root, hashable) : undefined;
    for (const { index, entry } of group) {
      verdicts[index] = (entry.paths ?? []).every(
        (path) => !missing.has(path) && hashes?.[path] === entry.content_hashes?.[path],
      );
    }
  }
  return verdicts;
}

/** The 0.11.0 commit-vs-worktree check for one entry without content stamps:
 * fresh when the anchored paths are unchanged since the anchored commit — none
 * of them untracked, none of them missing. Without a commit, always fresh. */
function commitAnchoredFresh(entry: FreshnessProbe, sessionRoot: () => string): boolean {
  if (!entry.commit_sha) return true;
  if (!/^[0-9a-f]{7,64}$/i.test(entry.commit_sha)) return false;
  const root = probeRoot(entry, sessionRoot);
  const paths = entry.paths ?? [];
  // A missing anchored path is stale: the entry documents a deleted file.
  for (const path of paths) {
    try {
      statSync(resolve(root, path));
    } catch {
      return false;
    }
  }
  const diff = gitStatus(root, ["diff", "--quiet", entry.commit_sha, "--", ...paths]);
  const untracked = gitStatus(root, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  return diff.status === 0 && untracked.status === 0 && untracked.stdout.trim() === "";
}

/** Fresh when the anchored paths still hold the content the entry was saved
 * against (content_hashes present: every path re-hashes to its saved blob) —
 * the working tree may be dirty and the paths untracked, only the bytes count,
 * and a missing path is stale. Without content hashes, the 0.11.0 check rules.
 * Unanchored entries (no paths) are always fresh: nothing observable
 * contradicts them. */
export function isEntryFresh(entry: FreshnessProbe, directory: string): boolean {
  return areEntriesFresh([entry], directory)[0] ?? true;
}
