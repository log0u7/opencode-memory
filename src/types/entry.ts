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
   * author makes the entry shareable. Unset while nobody vouched. */
  endorsed_by?: string[];
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
  /** The entry this one replaces (saveEntry validates and marks the old row). */
  supersedes?: string;
  /** Publish without peer endorsement: the author vouches, and the save records the
   * author's own endorsement in `endorsed_by`. */
  shareable?: boolean;
  /** Reserved: saveEntry manages the lifecycle itself. */
  status?: "current" | "superseded";
};
