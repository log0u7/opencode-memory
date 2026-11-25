// Entry kind is free-form; common conventions: decision, fact, preference, gotcha, lesson, compaction.
export type EntryKind = string;

export type Entry = {
  id: string;
  scope: string;
  kind: EntryKind;
  title: string;
  body: string;
  tags: string[];
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  /** Agent that wrote the entry, or `reflection` for distilled lessons. Unset on rows
   * written before the column existed, and never on a save that does not name a writer. */
  source?: string;
  /** Files the entry documents (relative to the project root). An entry with paths and
   * a commit is stale when any of them changed since that commit. */
  paths?: string[];
  /** The repository commit the entry was written against (auto-resolved at save). */
  commit_sha?: string;
  /** Git blob hashes (git hash-object) of the anchored paths at save time. Present
   * = freshness is content equality: every path must still hash to its saved blob,
   * whatever the commit or index state (works on dirty trees and untracked files).
   * Absent = the 0.11.0 commit-vs-worktree check. */
  content_hashes?: Record<string, string>;
  /** The git repository root the anchored paths resolve from, captured at save.
   * Paths are stored root-relative, so a later check from any sub-directory of
   * the same repo — or a view of a global entry from another project — hashes
   * the same bytes instead of failing on a path that does not exist there.
   * Unset on rows written before 0.25.0 and on saves outside a repository. */
  repo_root?: string;
  /** Id of the entry this one replaces. The replaced row stays as a superseded
   * tombstone, hidden from every read, restorable through memory_restore. */
  supersedes?: string;
  /** Lifecycle of the row: `current` entries are the live knowledge, a `superseded`
   * row was replaced by the entry whose supersedes points at it. Unset on rows
   * written before the column existed. */
  status?: "current" | "superseded";
  /** When the row was superseded (epoch ms). */
  superseded_at?: number;
  /** Recurrence counter on lessons: +1 each time the knowledge is created or
   * re-recorded under the same title. At or above HOT_THRESHOLD the entry is
   * hot: the inventory injects it outside the character budget. Unset when 0. */
  heat?: number;
  /** Agents that vouched for the entry, author included when the author published
   * it with `shareable` at save time. One endorsement from an agent other than the
   * author makes the entry shareable. Since 0.24.0 a tool endorsement is stamped in
   * the rich `agent@<fingerprint>` form, binding the endorser to the node identity
   * the mesh's TLS pairing proves; the plain legacy form stays valid locally and is
   * never shareable cross-host. Unset while nobody vouched. */
  endorsed_by?: string[];
  /** The project the entry belongs to: the injection filters by the session's
   * project, so the entry is only injected there. Unset = global: the row is
   * injected in every project (the backward-compatible default, and the shape of
   * every row written before 0.23.0). */
  project?: string | undefined;
  /** Provenance marker on exported lines only: the hostname of the machine the
   * export was written on. It labels cross-host knowledge in the JSONL format and
   * tells importPortable to trust-and-remap the entry to the `global` scope; the
   * store never persists it (an imported row carries no origin_host). */
  origin_host?: string;
};

export type EntryInput = {
  scope: string;
  kind: EntryKind;
  title: string;
  body: string;
  tags: string[];
  expires_at: number | null;
  source?: string;
  paths?: string[];
  commit_sha?: string;
  /** Anchor stamp captured at save: git blob hash of each anchored path's content. */
  content_hashes?: Record<string, string>;
  /** The git repository root the anchored paths resolve from (auto-captured at
   * save; the paths are stored relative to it). */
  repo_root?: string;
  /** The entry this one replaces (saveEntry validates and marks the old row). */
  supersedes?: string;
  /** Publish without peer endorsement: the author vouches, and the save records the
   * author's own endorsement in `endorsed_by`. */
  shareable?: boolean;
  /** The project the entry belongs to (absent/undefined = global, injected in
   * every project). The plugin deduces it from the session's project. */
  project?: string | undefined;
  /** Reserved: saveEntry manages the lifecycle itself. */
  status?: "current" | "superseded";
};
