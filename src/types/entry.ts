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
};
