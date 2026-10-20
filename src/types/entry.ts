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
};

export type EntryInput = {
  scope: string;
  kind: EntryKind;
  title: string;
  body: string;
  tags: string[];
  expires_at: number | null;
  source?: string;
};
