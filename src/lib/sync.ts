import { readdirSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryDb } from "./db.js";
import { importPortable } from "./portable.js";

/**
 * Directory convention shared with opencode-mesh >= 0.12, and the ONLY contract between
 * the two plugins: the mesh (the transport) writes every peer's pushed JSONL under
 * `<mesh dataDir>/memory-sync/inbox/<from-node>.jsonl`, where the mesh dataDir is
 * `$XDG_DATA_HOME/opencode-mesh` (default `~/.local/share/opencode-mesh`). The memory
 * plugin (the content) imports those files during its housekeeping pass and never
 * imports anything from the mesh itself.
 */
export function defaultMeshInboxDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homeDir(), ".local", "share");
  return join(dataHome, "opencode-mesh", "memory-sync", "inbox");
}

// Same fallback chain as the mesh's defaultDataDir(): a blank HOME must never produce
// a path at the filesystem root.
function homeDir(): string {
  return process.env.HOME || homedir() || tmpdir();
}

export type SyncImportReport = {
  /** Inbox files seen this pass. */
  files: number;
  /** Entries inserted across all files. */
  imported: number;
  /** Valid lines skipped (already present, rejected, orphan superseded rows). */
  skipped: number;
  /** Files that could not be read or imported; they stay in place for the next pass. */
  failed: number;
};

/**
 * Import every JSONL file the mesh collected from paired hosts, then rename it to
 * `<name>.jsonl.imported` so the next pass never re-reads it. Per-entry idempotence is
 * importPortable's (receiving the same entries twice inserts nothing), so the rename is
 * bookkeeping, not correctness. A missing inbox means nothing was pushed yet, not an
 * error; a file that fails to parse stays in place (its bytes are the peer's, so the
 * mesh side decides their fate) and only bumps `failed`.
 */
export function syncImport(db: MemoryDb, options: { inboxDir: string }): SyncImportReport {
  const report: SyncImportReport = { files: 0, imported: 0, skipped: 0, failed: 0 };
  let names: string[];
  try {
    names = readdirSync(options.inboxDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return report;
  }
  for (const name of names) {
    const path = join(options.inboxDir, name);
    report.files += 1;
    try {
      const result = importPortable(db, path);
      report.imported += result.imported;
      report.skipped += result.skipped;
      renameSync(path, `${path}.imported`);
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
