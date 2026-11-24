# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.21.8] - 2026-11-24

### Added

- The expanded sidebar shows the store size on its own `⌗` line between kinds and sync.

## [0.21.7] - 2026-11-24

### Fixed

- **Footer size restored**: the footer reads "N Records · N MB" ("1 Record ·
  N kB") again — 0.21.4 dropped the size along with the glyph. `formatMemoryLine`
  returns tone segments now (count in qualifier, labels and separators in
  value); the footer slot renders them per segment, so the numbers get the
  qualifier tone instead of one flat muted string.
- **Tones on the numbers, footer and collapsed**: counts and the size value
  render in qualifier, the labels ("Records", "MB", "hot") and the " · "
  separators in value. The collapsed one-liner splits its size and hot
  segments the same way (`3.3` qualifier + ` MB` value, `● ` alert + `2`
  qualifier + ` hot` value).
- **"Records" spelled out in the collapsed one-liner**: "▶ Memory · 699
  Records · 3.0 MB · ● 2 hot" instead of "Rec" — there is room for it, and
  the footer already spelled it. "1 Record" singular.

## [0.21.6] - 2026-11-24

### Fixed

- **Content-based anchoring**: an entry saved right after editing files (before
  commit) was stale at creation — the 0.11.0 check compared the saved commit to
  the working tree, so a dirty path or an untracked file failed it immediately
  and the auto-anchoring cooled exactly the freshest lessons. The anchor now
  also stores the `git hash-object` of each path at save time
  (`content_hashes`): freshness is content equality (every path re-hashes to
  its saved blob), which works on dirty trees, untracked files and deleted
  paths alike. The commit stamp stays secondary; entries anchored by commit
  only keep the previous check (backward compatible). The freshness cache key
  carries the new stamp, so a probe still costs one bounded `hash-object`
  subprocess (two for commit-only entries) and zero on a hit.

## [0.21.5] - 2026-11-24

### Changed

- **Compact line output for `memory_search`, `memory_list` and `memory_get`**: the
  JSON dump is gone — one line per hit, `<id8> <kind> <title> — <body preview>`,
  under a single `scope <scope> · N hits` header (memory_list: `N entries`).
  Metadata rides as a suffix only when it says something: ` · hot`, ` · stale`
  (when the caller passes the checkout directory), the first anchored path, and
  ` · truncated:<length>`. The PO measured 73% metadata overhead on short hits;
  a 10-short-hit search shrank from 3563 to 1514 chars (÷2.35, ~94% payload).
- **8-char id prefixes accepted by every id tool**: `memory_get`,
  `memory_forget`, `memory_restore`, `memory_endorse` and `supersedes` resolve an
  id8 (or any exact prefix) against the store — ambiguity answers with the full
  candidate ids; full ids stay the truth in the db and remain accepted.
- **Scope shown once in the header**, not per hit; no dates, no empty fields.
- **`memory_list` accepts `page`** (1-based), header shows `(page N)` past the
  first page.
- **`DEFAULT_LIMIT` lowered: search 5, list 10** (explicit `limit` still wins).
- **`memory_get` returns the integral body plus a compact meta block** instead of
  JSON: `<body>\n—\nid <full-id> · <kind> · <human age> · heat <N>` plus
  `paths: <list>` when anchored and `supersedes <id>` when present.

## [0.21.4] - 2026-11-24

### Fixed

- **Collapsed sidebar lost its `▶` toggle in the v4 rewrite**: the one-liner
  reads "▶ Memory · N Rec · N MB · ● N hot" again — the toggle mirrors the
  expanded `▼` and stays bold and clickable.
- **Footer line format**: `formatMemoryLine` renders "N Records" ("1 Record"
  singular); the store size and the ▤ glyph leave the footer.

## [0.21.3] - 2026-11-24

### Changed

- **Collapsed sidebar, quota-style one-liner**: "Memory · 699 Rec · 3.0 MB" plus
  " · ● N hot" when hot (omitted at 0), built with the expanded panel's segment
  grammar: only the title stays bold, counts are qualifier/value toned, and
  "Rec" never pluralizes. The no-store fallback keeps "Memory (no store)".
- Hot expanded line reads " · sweep N ago" instead of the old "last sweep N ago" tail.

### Added

- **Commit anchoring at save**: a save with anchored paths and no explicit
  commit_sha captures `git rev-parse HEAD` from the project directory once per
  save, so the entry anchors complete (paths + commit) and the cooling can
  apply. Outside a repository, or without paths, the entry is unchanged.
- The never-recalled report (purge-on-proposal in memory_stats) also lists
  unanchored `lesson` entries not recalled for more than 30 days: the sweep
  never dates them out, so the report is their soft cap. Anchored lessons stay
  the anchoring's business, and nothing is deleted automatically.

## [0.21.2] - 2026-11-24

### Fixed

- **The collapsed header showed "NaN kB".** `store_bytes` was built into the sidebar
  snapshot but missing from the RPC wire schema: the host validated the payload and
  stripped the unknown field, so the sidebar received `undefined` and rendered NaN.
- Glyph placement: the store glyph follows the number — "▶ Memory 699▤ · 3.0 MB" and
  " · ● N hot" as its own separator-separated segment (hot line omitted at 0); the
  footer drops the redundant "memory:" prefix, the host already labels the slot.

## [0.21.1] - 2026-11-24

### Added

- **Sticky session inventory** (prompt-cache stability): the injected block is
  byte-identical on every request instead of vanishing from step 2 — provider and
  llama.cpp slot caches keep hitting. Optional `caveman: "auto" | true | false`:
  terse guidance when the upstream caveman mode is detected.
- Hot-only re-injection: a save reaching the heat threshold (a rare récidive)
  resets the injected inventory; ordinary lessons keep the prefix byte-stable and
  reach live sessions through memory_search.
- `docs/CONFIGURATION.md` caveman section.

## [0.21.0] - 2026-11-24

### Added

- **Collapsed sidebar and footer, one compact line each**: "▶ Memory ▤699 · 3.0 MB"
  (+" ● N hot" when hot) and footer "memory: ▤N · size" — the duplicated word, the
  kind breakdown and the stale/to-share segments leave the collapsed header (the
  kind breakdown lives in the expanded panel and memory_stats). store_bytes added
  to the sidebar snapshot.

## [0.20.9] - 2026-11-24

### Fixed

- Sidebar pools/kinds glyph `☰` (U+2624, East-Asian Ambiguous) drawn wide glued the
  next character — swapped for `≡` (U+2261, Neutral narrow).

## [0.20.7] - 2026-11-24

### Fixed

- Republish: 0.20.6's metadata landed on npm without its tarball (registry-side
  inconsistency, 404 on the blob despite a green publish). 0.20.7 = identical
  content, new version.

## [0.20.6] - 2026-11-24

### Changed

- Sidebar kinds pack **two per line** instead of five-per-line with hard truncation:
  the panel width ate the labels ("300 fa · 1 les") — seen live. Each kind now
  reads in full, packed desc by count; the renderer wraps pathological cases.
  No truncation on this section.

## [0.20.5] - 2026-11-24

### Fixed

- **TUI snapshot git probes cached by (commit, paths, working-tree state)**: the
  staleness pass re-probed up to 200 anchored entries on every sidebar refresh
  (event gap or 30 s poll), 2 git subprocesses each (`diff --quiet` +
  `ls-files --others`) — an active session burst 200 entries × 2 subprocess per
  event gap. Identical snapshots now cost zero: verdicts are cached per process
  under a key that carries the observed state of every anchored path
  (mtimeMs + size, or "missing"), so a hit still reflects the current working
  tree (an edit moves mtime, a delete moves existence, a re-save moves the
  stamp). Measured: 10 identical snapshots over 3 anchored entries drop from 60
  to 6 git subprocesses (the first snapshot only). LRU bound at 10 000 entries.
  `isEntryFresh` stays a pure function in git.ts; the cache lives in
  tui-snapshot.ts.

## [0.20.4] - 2026-11-24

### Changed

- **Tool descriptions diet (−30 %)**: the 14 shared tool descriptions trimmed from
  3771 to 2637 chars (−1134) by cutting fluff while keeping every behavioral
  contract (30-day restore window, purge-proposal-only stats, dedup rules, mesh
  sync pass, credential refusal, JSONL idempotency). Implemented error verbatims
  untouched; each argument description stays a single line.
- **TUI sidebar v4 — quota-style emphasis**: the expanded panel now follows the
  three-tier quota grammar (entity = `theme.text` + bold, qualifier = `theme.text`,
  value = `theme.textMuted`) instead of all-muted lines, with the PO-validated
  single-width icon set (`●` hot attention glyph in the theme's warning/error
  color when hot > 0, `▤` counts, `☰` kinds packed five per line, `⇄` mesh sync).
  Zero blank lines: hot-at-0, sweep-without-metadata and mesh-less lines are
  omitted, not padded; `wrapMode="none"` everywhere. Collapsed shape and the
  `Memory (no store)` fallback are unchanged.

## [0.20.3] - 2026-11-24

### Fixed

- **Peer endorsements carry through supersede**: superseding an endorsed entry
  (explicit `supersedes`) used to insert the replacement with no endorsements, so
  refining a shared entry dropped it from the next outbox push. The replacement now
  carries the superseded row's endorsements, minus the new entry's own source (the
  author re-endorsing their own rewrite is exactly the anti-amplification guard, and
  their shareable-at-save marker stays the only self-endorsement). Replace-by-title
  already carried endorsements and is unchanged.

### Documentation

- New `docs/CONFIGURATION.md`: every plugin option with its default and effect,
  taken from the code (`reflection`, `housekeeping`/`sweepTtlDays`, `retrieval`),
  linked from the README.
- README: `source` carries the mechanism — only the legacy LLM-distilled lessons
  carry `reflection`, directive-saved lessons carry the saving agent.

## [0.20.2] - 2026-11-23

### Fixed

- **Cross-host sync entries are actually recalled**: an imported peer entry kept its
  original scope — a project path that exists on the peer, never on this machine — so
  search, list, inventory and sweep silently hid every received entry. Imports whose
  lines carry the new `origin_host` provenance marker (added by the outbox export)
  are remapped to the `global` scope, which every scope's reads include. The trust
  model is assumed and documented: transport runs between TLS-pinned paired hosts,
  exports are secret-scanned, and only endorsed entries travel — cross-host knowledge
  is machine-wide by nature. Same-machine export/import round-trips (0.13.0 usage,
  no `origin_host`) keep the verbatim behavior.
- **The mesh outbox export is machine-wide**: `syncExport` wrote only the calling
  project's shareables, so every other project's endorsed entries were dropped from
  each push (one `shareable.jsonl`, rewritten per pass). The export now covers every
  scope (`listShareableAll`), stamped with the host's name as `origin_host`.

### Security

- **Import trust boundary caps** (portable import): entries stamped more than 5
  minutes in the future (`created_at` / `updated_at`, clock skew) are rejected with
  the field named; `expires_at` more than 10 years ahead is rejected; `scope` is
  capped at 512 characters and `source` at 256, with a clear rejection message.
  Inbox files over 1 MiB are refused before being read, warned about once, and
  renamed to `.oversized` so a runaway peer export can never pin the import pass
  in an endless re-parse loop.

## [0.20.1] - 2026-11-23

### Removed

- **The daily lesson budget** (`maxLessons` / 3 lessons per day per project): it
  blocked legitimate bursts twice in one day — a subagent's lesson during a
  0.15.0 session, and a same-title refinement whose re-save was refused because
  the guard ran before the replace-by-title lookup. A fresh install or a new
  model legitimately produces many lessons at once, and a blocked lesson is
  never re-learned. The remaining guards carry the anti-spam: the quality bar
  in the reflection directive, replace-by-title dedup (with heat), the supersede
  suggestion at save, the sweep's housekeeping, and the secret guard. A config
  that still carries `maxLessons` is accepted and silently ignored.

### Fixed

- **`memory_sweep` runs the full housekeeping pass**, the exact sequence of the
  automatic boot/daily pass: sweep plus the mesh sync twins (inbox import,
  shareable export to the outbox). Both entry points share one
  `runHousekeepingPass`, so a manual sweep can no longer leave the outbox empty
  until the next daily tick.

## [0.20.0] - 2026-11-23

### Added

- **TUI sidebar**: a Memory slot in the sidebar (`sidebar.content`), beside the
  existing footer, showing the memory state at a glance. Collapsed: a header
  (`▶ Memory`, with `● N hot` when hot lessons — the priority signal — exist)
  and one muted counts line (`N entries · N stale · N to share`; the stale
  segment is dropped when zero). Expanded (`▼ Memory (machine-wide)`): live /
  trashed / in-scope counts, the kind breakdown, the last housekeeping sweep
  with its age and cooled count, and the mesh sync line (pending inbox files,
  shareable outgoing; omitted on a mesh-less machine). Click the header or run
  `/memory`-group "Toggle memory sidebar" to switch; the collapsed state
  persists across restarts (raw storage domain, the same scoped-plugin-id
  workaround as the mesh sidebar). No store yet: a single `Memory (no store)`
  line. The snapshot is one aggregated SQL read (`buildSidebarSnapshot`) with
  the staleness probe bounded to 200 anchored entries per tick, and the
  formatter (`formatMemorySidebar`) is pure and unit-tested without a renderer.

## [0.19.1] - 2026-11-23

### Added

- **Automatic outbox export**: the housekeeping pass now also exports the scope's
  shareable entries to the mesh outbox (`<mesh dataDir>/memory-sync/outbox/shareable.jsonl`),
  the outbound twin of the inbox import (0.19.0). Gated on the mesh's data dir
  existing — a machine without opencode-mesh grows nothing — and rewritten atomically
  each pass, so un-endorsing or superseding an entry removes it from the next push.
  The mesh pusher (0.12.0) transports the file to every paired peer; the cross-host
  loop now runs without a manual `memory_export`.

### Fixed

- `listShareable` (and therefore `memory_export --shareable` and the outbox) excluded
  tombstoned rows but kept **superseded** ones: a superseded endorsed entry would
  have kept travelling cross-host. The shareable list is now `status = 'current'`
  only.

## [0.19.0] - 2026-11-23

### Added

- **Shareable export filter**: `memory_export` accepts `shareable: true` and writes only
  the entries worth sharing cross-host — those carrying at least one endorsement (a
  peer's, or the author's own when the save published them with `shareable`). The JSONL
  format itself is unchanged (0.13.0), the filter only selects which entries travel.
- **Import report counts**: `memory_import` now reports how many entries were imported
  and how many valid lines were skipped (ids already present, rejects, orphan superseded
  rows): `imported N entries (M skipped) from <path>`.
- **Mesh inbox import pass (sync-import)**: the housekeeping pass (plugin boot + every
  24h, both entry points) now also imports the JSONL files the opencode-mesh plugin
  collects from paired hosts under `<mesh dataDir>/memory-sync/inbox/*.jsonl`, then
  renames each to `<name>.jsonl.imported`. The path convention is the only coupling
  between the two plugins (transport and content stay decoupled); a missing inbox is an
  empty one, a broken file stays in place for the next pass, and per-entry idempotence
  makes a re-import a no-op. A store must already exist (the boot guard is unchanged).

## [0.18.0] - 2026-11-23

### Added

- **Endorsement + shareable flag (light quorum)**: an entry becomes worth sharing across
  hosts once one agent other than its author vouches for it. `memory_endorse` appends the
  endorser to `endorsed_by` (idempotent per endorser) and any endorser different from the
  author flips the entry to shareable. The author's own endorsement alone never qualifies.
- **Publish at save**: `memory_save` accepts `shareable: true` — the author vouches for
  the entry themselves, the save records the author's endorsement in `endorsed_by`, and
  existing endorsements (author or peers) survive a rewrite under the same title.
- **Reflection activation (the inference-only RL loop)**: a standing directive injected
  next to the memory guidance — when corrected or after a failed approach, the current
  model distills the lesson itself (`memory_save(kind=lesson, paths=[...])`), no separate
  model call. On by default; `reflection: false` (or an object config without
  `enabled: true`) switches it off, and an object config's `maxLessons` doubles as the
  per-day fresh-lesson budget that gates new lessons (refining an existing lesson under
  the same title is never blocked). The loop closes inference-only: error → lesson →
  heat → priority injection.

## [0.17.0] - 2026-11-23

### Added

- **Token economy — truncated search results**: `memory_search` and `memory_list` serve
  each hit with a body preview capped at 500 characters, cut on the last word boundary
  (a `…` suffix marks the cut). A truncated hit carries its real body length in a
  `truncated` field, so the model knows how much text it did not see.
- **memory_get**: full entry by id — the complete body plus `paths`, `commit_sha`,
  `heat` and every other field the previews leave out. An unknown id answers
  "no entry with that id"; a trashed entry points to `memory_restore` (restorable
  30 days). Reading an entry in full counts it as used, like any served hit.

## [0.16.0] - 2026-11-23

### Added

- **Hot lessons (heat counter)**: a lesson saved under a title that already exists in
  the same scope gains one point of heat instead of stacking a duplicate (a brand-new
  lesson starts at heat 1). At or above `HOT_THRESHOLD` (2) the entry is **hot**: the
  same lesson angle taken again is the signal that the mistake it documents keeps
  happening.
- **Priority injection**: hot entries (any kind, not only lessons) are injected first
  in the session inventory, with a `[HOT]` marker, **outside the 1200-character
  budget** — the budget applies to the remaining (non-hot) lines only. A recurring
  lesson now reaches the model even when the budget is saturated by newer entries.
- **Re-injection on save**: saving a lesson (or any entry that is hot) invalidates the
  once-per-session injection cache through a new `onLessonSaved` callback that both
  plugin entry points wire to the cache reset. The next turn re-injects the full
  inventory with the hot lesson up front — no more "recorded but never re-injected at
  the right time".
- **Cooling at sweep**: at each automatic housekeeping sweep (boot + every 24h), an
  anchored entry whose files are unchanged since its anchored commit loses one point
  of heat, down to a floor of 0 (one step per sweep). Discipline that lives in the
  code lets its lesson cool off and give the priority slot back.

## [0.15.0] - 2026-11-23

### Added

- **Usage tracking**: every entry now counts how many times it was served to
  the model — `memory_search` touches its hits, and the inventory injection
  touches only the lines that made it under the character budget (cut entries
  stay unused). New columns `use_count` / `last_used` are backfilled on open.
- **Never-recalled report in `memory_stats`**: entries stored for 30+ days that
  were never served to the model are listed (oldest first, first 10 named) as
  `never-recalled: N (...)`. This is a purge **on proposal only** — nothing is
  deleted automatically; the agent or the user decides and acts through
  `memory_forget`.

### Notes

- Usage tracking adds one small write per served read (search hits, injected
  inventory lines). The store now runs `synchronous=NORMAL` with WAL (SQLite's
  recommended posture): same crash safety for the process, only a power cut
  could drop the last un-checkpointed commits.

## [0.14.0] - 2026-11-23

### Added

- **Automatic housekeeping** (conservative): at plugin boot and every 24 hours
  the project scope (plus `global`) is swept. An entry whose content carries a
  dated-state marker (ISO dates, `état:`, `état au`, `state as of`, `en cours`,
  `en vol`, `attente`, `pending`, `ETA`) and has not been updated for 7 days is
  tombstoned — it follows the standard 30-day trash and stays restorable
  through `memory_restore`.
- **Duplicate collapse**: two live entries of the same scope with the same
  normalized title and body, and the same anchoring, collapse to the newest
  copy; the older ones are deleted for good (an exact duplicate adds nothing
  to the trash).
- **Exemptions**: `lesson` entries are never dated-swept (an anchored lesson's
  freshness is decided by the anchoring at read time), `epic`/`task` entries
  (orchestrator steering) are exempt from both rules, and anchored entries
  (paths + commit) are left to the anchoring.
- **`memory_sweep` tool** (`scope?`, `ttl_days?`): runs the same sweep on
  demand and reports what moved (`swept: N tombstoned (dated), M deleted
  (duplicate), K kept`, with the moved entries named).
- Options: `housekeeping` (default `true`) and `sweepTtlDays` (default `7`).

### Notes

- Inspired by workflow-guard's storage maintenance.

## [0.13.0] - 2026-11-23

### Added

- **Portable export/import**: `memory_export` writes the live entries of a scope
  (superseded tombstones included) to a JSONL file — one full entry per line,
  ascending `created_at` order so a re-export mostly appends in git diffs. Default
  path `.opencode/memory/memory-export.jsonl` inside the project (derived from an
  absolute scope; a named scope needs an explicit `path`). The file is versionable
  in git and shareable across machines.
- The export is atomic (tmp file + rename) and mode `0600`, matching the store's
  permission promises. `memory_export` reports `exported <n> entries to <path>`.
- **Secret-scan on both directions**: credential-like content is never exported
  (a secret that survived an old save must not gain a second life in a
  git-versionable file) and is skipped on import. Callers can add a stricter
  `rejectContent` filter; the built-in credential scan cannot be bypassed.
- **Idempotent import**: `memory_import` reads the JSONL back with the original
  ids, so re-importing the same file imports nothing and cross-machine copies
  stay the same entries. Invalid lines abort with their line number before
  anything is written.
- **Workflow-guard import rule**: an import never supersedes local entries. A
  `superseded` entry imports only when its own `supersedes` target travels in
  the same file; a current entry whose `supersedes` target stays outside the
  file imports without the link.

## [0.12.0] - 2026-11-22

### Added

- **Supersede**: `memory_save` gains `supersedes` (entry id) to replace an entry
  instead of stacking a near-duplicate. The named entry must be live and in
  the same scope; it is kept as a `superseded` tombstone (hidden from
  `memory_list`, `memory_search` and the inventory) while the fresh entry
  carries the link, and the save result reports `; replaced <old-id>`.
- Without `supersedes`, the save result names up to two similar current
  entries of the same kind and scope (`similar entries: <id> ("<title>") - use
  supersedes=<id> to replace`). The store never replaces on its own: the
  answer only arms the agent.
- `memory_restore` on a superseded entry brings it back as `current` and
  marks its replacement `superseded`, so the pair stays coherent.

### Notes

- Inspired by workflow-guard's supersedes pattern.

## [0.11.0] - 2026-11-22

### Added

- **Code anchoring**: a memory entry can be anchored to the files it documents
  and the commit it was written against. `memory_save` gains `paths`
  (relative project paths, validated: max 20, no absolute, no `..`) and the
  plugin auto-resolves the current HEAD commit at save time
  (`commit_sha`).
- **Staleness**: an anchored entry is stale when any of its paths changed
  since the anchored commit, is untracked, or is missing (documenting a
  deleted file). Stale entries are filtered OUT of the session inventory
  injection — a decision true on Monday stops being asserted after a refactor
  broke its files. `memory_search` / `memory_list` keep showing them (with
  the store untouched); only the automatic context injection stops claiming
  them. Inspired by workflow-guard's project-memory.
- New tool arg on `memory_save`: `paths`.

### Notes

- Freshness checks are synchronous `git diff`/`ls-files` calls, bounded at
  2 s each, on the first inventory of a session — the same pattern
  workflow-guard ships.
- Schema: `entries.paths` / `entries.commit_sha`, backfilled on open
  (existing stores keep working).

## [0.10.0] - 2026-11-06

### Added

- Themed memory footer: bold "Memory" label and muted stats using the active
  theme's text colors.
- Event refresh: the footer refreshes immediately (debounced) on server
  events, with the 30s polling as fallback.
- `/memory` now opens a dialog with the full kind breakdown (all kinds, not
  just the top 3) via the new `all_kinds` snapshot field.

## [0.9.0] - 2026-11-06

### Added

- Live memory footer: the TUI part polls a `memory.snapshot` RPC (registered
  server-side) every 30s and renders the entry count, store size and top kinds
  in the home footer status. Hidden on v1 hosts and for an empty store.

## [0.8.1] - 2026-11-06

### Fixed

- Peer dependencies aligned with the dual-export pattern: `@opencode-ai/plugin`
  pinned to `^1.18.32` and `@opencode/plugin` to `^2.0.26`, both optional.
  The previous `>=2.0.0` range blocked installation because no matching
  version exists on npm.

## [0.8.0] - 2026-11-05

### Added

- TUI plugin (phase 0+1): toast on load, `/memory` slash command, status slot.

## [0.7.0] - 2026-11-04

### Added

- Transcript retention: opt-in policy (off by default) to sweep exported
  session transcripts. `retrieval.retentionDays` (age threshold),
  `retrieval.keepRecent` (safety floor, default 10), `retrieval.maxSessions`
  (hard cap), `retrieval.autoSweep` (default true). Age is based on the most
  recent of access/modification time, so a transcript still being read is kept.
- `memory_transcript_list` tool: storage visibility (scope, size, age, last touch).
- `memory_transcript_cleanup` tool: dry run by default; `apply:true` removes
  eligible files. Override policy per call or target specific session ids.
- `/memory-cleanup` command: runs the sweep (dry run unless `apply`).
- Auto-sweep 30s after startup and after each compaction, when enabled.

## [0.6.2] - 2026-11-04

### Fixed

- `memory_session_search` and `memory_session_read` no longer follow symlinks
  planted in the transcripts directory: only regular files are read.
- Tool output cap lowered from 1 MB to 100 KB per call (default still 20000).
- README note: if the transcript export fails, compaction falls back to the
  model-written summary silently; the cause is environmental, check disk space
  and write access on the transcripts directory.

## [0.6.0] - 2026-11-04

### Added

- Context retrieval: compaction no longer pays for a model-written summary. A
  compaction hook exports the exact transcript being summarized to
  `~/.local/share/opencode-memory/transcripts/<scope>/<sessionID>.md`
  (append-only markdown, `0700`/`0600`) and records a short pointer as the
  compaction result, which skips the summary model call entirely. Two bounded
  retrieval tools, `memory_session_search` and `memory_session_read`, let the
  agent pull exact lines (errors, paths, numbers, decisions) from any exported
  transcript of the project, when it needs them.
- Cross-scope search: `memory_session_search` accepts `all: true` to search
  every project's exported transcripts on the machine.
- On-demand export: naming a session that has no transcript yet (in
  `memory_session_search` or `memory_session_read`) exports it from the host's
  session store first, under that session's own scope.
- `/memory-continue <sessionID>` command: exports the session's transcript if
  needed and injects the retrieval pointer into the current session.
- Approach inspired by Mainplane's context retrieval
  (https://github.com/mainplane-ai/mainplane).
- Plugin options `retrieval.enabled` (default `true`), `retrieval.dir`,
  `retrieval.inlineOutputMaxBytes` (default 50000). Disabling restores the
  plain summary flow and hides the retrieval tools.

## [0.5.1] - 2026-10-24

### Fixed

- The package loads under OpenCode 2 again. The v1 implementation imports
  `@opencode-ai/plugin`, which only v1 hosts resolve, and it sat in the static
  import graph, so v2 hosts rejected the whole plugin at load time
  (`Cannot find package '@opencode-ai/plugin'`). The v1 entry is now loaded
  lazily from `server()`: a v2 host never calls `server()` and therefore never
  resolves the v1-only packages. The named `MemoryPlugin` export is type-only.
- Shared option plumbing and the system-guidance/compaction constants moved
  from `plugin.ts` to `options.ts` so the v2 adapter no longer imports the v1
  module statically.
- New `smoke:dist` script audits the static import graph of `dist/`: no
  `@opencode-ai/*` import may be reachable statically, `plugin.js` must only
  be reached through a dynamic `import()`, and every other bare import must
  be `@opencode/plugin`, a Node builtin, or a declared runtime dependency.

## [0.5.0] - 2026-10-20

### Fixed

- The plugin opened its SQLite store through the `Bun.sqlite` global, which Bun 1.3
  removed: the first `openMemoryDb` threw on every Bun 1.3 runtime, which is what the
  installed OpenCode embeds. It now reads `process.versions.bun` and loads the `bun:sqlite`
  module through the same `createRequire` seam as `node:sqlite`, so one path covers old and
  new Bun. Verified against the built output under Bun 1.3.14 (open, save, search, stats,
  trash and restore).

### Added

- `memory_restore` puts a trashed entry back by id, wherever it lived. `memory_forget` now
  trashes instead of dropping, so a wrong delete is recoverable; a sweep hard-deletes trash
  older than 30 days so the trash cannot grow without bound.
- Entries record the agent that wrote them (`source`; distilled lessons carry
  `reflection`), the session inventory names the writer, and a store created by an earlier
  release gains the column on open instead of failing to read.

### Security

- The secret guard now refuses the token formats released since it was written: GitHub
  fine-grained PATs (`github_pat_`), the GitHub OAuth and server-to-server classes
  (`gho_`, `ghs_`, `ghu_`, `ghr_`), GitLab rotate tokens (`glrt-`), npm granular tokens
  (`npm_`), AWS temporary key ids (`ASIA`), Google OAuth access tokens (`ya29.`) and Slack
  incoming webhook URLs. The existing `sk-` pattern already covered Anthropic `sk-ant-`
  keys. The three patterns whose tail class allows `_` or `-` (`github_pat_`, `gl(?:pat|rt)-`
  and `ya29.`) additionally require a digit or an uppercase letter in the tail, so a sentence
  written as one long lowercase snake_case or hyphenated token right after a prefix is saved
  instead of being refused as a credential. A run carrying a digit or an uppercase anywhere
  inside the run of the pattern's tail class is still refused: the guard forgives lowercase
  prose only. The older `sk-`, `AIza` and `xox[ap]-` patterns keep their original shape.

### Changed

- `memory_search` fuses its two rankings instead of discarding one: entries matching
  every query token come first, then prefix matches fill the remaining slots. A query
  where two entries hold every token used to answer a limit of ten with two results.
- `memory_save` reports whether it created an entry or rewrote the one already holding that
  scope and title, instead of one undifferentiated receipt: the in-place dedup rewrite is
  no longer silent.
- `memory_forget` lists the titles and ids it removed (ten named, then a count of the
  rest) instead of only a count, so a broad query delete is auditable. `store.forget`
  now returns the removed entries rather than a number.
- `memory_stats` reports the store size on disk and the oldest live entry beside the kind
  counts. The store has no size cap and no eviction, so this is the only signal that it is
  growing.
- Dev-dependency bumps from the Dependabot minor-and-patch group: `@biomejs/biome`
  2.5.15, `@opencode-ai/plugin` 1.18.35 (with the transitive `@opencode-ai/sdk` 1.18.35),
  `lefthook` 2.1.17, and in-range lockfile refreshes (vitest 5.0.3, `@types/node` 26.6.4).

## [0.4.0] - 2026-10-14

### Added

- Lesson feedback loop: the system guidance and the compaction prompt now nudge the agent
  to save reusable lessons (`kind=lesson`), and lessons are injected first in later
  sessions' inventory, ahead of recency noise (`store.list` gained an optional `kind`
  filter).
- Optional LLM reflection at `session.idle`, off by default: with
  `reflection.enabled: true` in the plugin options, the plugin distills at most
  `maxLessons` durable lessons from the bounded session tail with one LLM call per
  session and saves them as lessons. Options: `model` (`"provider/model"`), `maxLessons`
  (3), `transcriptChars` (8000), `timeoutMs` (60000). Subagent sessions are skipped and the
  run is best-effort: failures are silent.

- New `memory_stats` tool (both hosts): counts entries by kind for the project scope
  (plus global) with a total, so the model can see how much memory exists, including
  how many lessons reflection has written, without paging through `memory_list`.

### Changed

- `pnpm verify` (and therefore CI) now runs the suite with coverage, so the coverage gate
  the docs promise (90% lines/functions/statements, 80% branches) is actually enforced
  instead of only configured.

### Fixed

- The store database is created with restrictive permissions: the file is `0600`
  (enforced on every open, regardless of the process umask, so databases created earlier
  with a permissive umask are tightened too) and the directory is `0700` when the plugin
  creates it, as `SECURITY.md` already promised.
- Secret detection now also refuses JWTs, PEM private key blocks, AWS access key ids,
  GitLab personal access tokens, Google API keys, and Slack user/app tokens, in addition
  to the existing OpenAI, GitHub, and Slack bot formats.
- `memory_forget` by id now deletes across scopes: ids are globally unique, so an exact
  id match is precise anywhere, and closed worktrees stay cleanable from any project.
  Query deletes keep the scope lock (a fuzzy match must never silently hit other
  projects).
- Reflection no longer permanently skips a session whose first `session.idle` arrived
  before the transcript reached the distillation floor: the session is marked reflected
  only once a run is actually attempted, so a later, longer turn still gets exactly one
  reflection.
- The README safety-limits note on `memory_forget` now matches the code: query deletes
  stay in scope, id deletes are global.
- Reflection's LLM call is now bounded by a timeout (`reflection.timeoutMs`, default 60s):
  a hung provider no longer wedges a session forever, and the abort reaches the SDK so the
  v1 host still deletes its ephemeral child session.
- The v2 event stream now reconnects with a capped backoff after an error instead of
  silently ending the reflection loop for good.
- After `dispose` (v1) or `cleanup` (v2), memory operations no longer reopen the SQLite
  connection: a late tool call or in-flight reflection returns a readable error instead of
  leaking a connection that nobody closes again.

## [0.3.0] - 2026-10-14

### Added

- Deterministic injection: the first request of each session carries a bounded list of the
  project's most recent entries (titles, kinds, dates, no bodies, ~1200 characters worst
  case), so using memory no longer depends on the model remembering to call
  `memory_search`. The tool stays for deeper lookups.
- Compaction inventory: the compaction context now lists the stored entries next to the
  save instruction, so the model summarises from an inventory instead of recall and stops
  re-saving what is already stored.

### Changed

- Both plugin entry points (`server` for OpenCode 1, `setup` for OpenCode 2) now delegate
  to one shared core (`src/lib/memory-ops.ts`): tool behaviour, error-to-text mapping,
  caps and rendering live in a single place, and each host is thin SDK glue. No
  behavioural change.
- The system guidance no longer tells the model to search at task start (the injection
  covers it); the credential warning and both tool mentions stay.
- CONTRIBUTING.md states the merge-policy rationale instead of a solo-maintainer
  preference: `--no-ff` keeps one merge commit per PR, which reads as the PR list via
  `git log --merges --first-parent main` and is a single atomic revert unit, with a
  five-commit PR ceiling bounding the cost. Documentation only, no package change.
- `memory_save` rewrites an entry that repeats a scope and title instead of adding a
  duplicate, which stopped the store from growing with every compaction.
- Saving purges rows past their `expires_at` instead of only hiding them at query time.

### Fixed

- `memory_forget` by query or id could delete entries of other projects: deletes are now
  scoped to the caller's scope (plus `global`), like `memory_search` and `memory_list`.
- A model-supplied `limit` crashed `memory_search`/`memory_list` (fractional, `NaN`) or
  returned the whole store (`-1`, which SQLite reads as unbounded). Limits are clamped to
  1..50, and tool results are bounded: bodies render as 500-character previews.
- A credential in an entry `title` or `kind` bypassed the secret guard; the scan now covers
  title, kind, body and tags, and `kind` has a length cap.
- Search returned nothing for partial queries (`"migration strategy"` found no entry
  containing "migration", and `"migrat"` found nothing): a strict AND match is now retried
  as a prefix OR match, and an empty query returns no results instead of failing.
- The two plugin entry points defaulted to different scopes for the same project (v1 used
  the session worktree, v2 the plugin directory) and disagreed about trailing slashes.
  Both now derive one canonical scope key.
- The published package could not be loaded by a Node host: `src/lib/sqlite.ts` called a
  bare `require("node:sqlite")`, which is undefined in an ES module. The Node branch now
  uses `createRequire(import.meta.url)`.

### Removed

- README advertised an FTS5 "recency boost" that the code never implemented; the actual
  ranking (BM25, newest first on ties) is documented instead.

## [0.2.0] - 2026-10-12

### Added

- Dual-export plugin entry for OpenCode 2: one published package runs on both
  OpenCode 1.18 and 2.x (official migration pattern, "Support V1 and V2 from
  one package"). v1 hosts call `server()` (unchanged); v2 hosts call `setup()`
  (`Plugin.define`). Both entries drive the same engine.

## [0.1.2] - 2026-09-23

### Removed

- Over-engineering audit cuts: duplicated `Row` type reused via `Omit<Entry, "tags">`, `dbPath`/`defaultDbPath` merged into one function, `V1PluginModule` alias inlined, `EntryKind` fake union replaced with plain `string` (kind is free-form by design), `validateEntry` unexported (internal-only).

### Changed

- Install docs describe opencode auto-install into its plugin cache; global npm/pnpm/mise installs are not used for plugin loading.

## [0.1.1] - 2026-09-23

### Changed

- No functional changes: first release shipped through the tag-driven trusted-publishing pipeline (GitHub Actions OIDC, npm provenance attestation).

## [0.1.0] - 2026-09-18

### Changed

- Trunk-based workflow: `main` is the only branch (PRs required, protected by rulesets); `dev` removed.

### Added

- Coverage gate in CI: 90% lines/functions, 80% branches (`pnpm test:coverage` locally).
- Dependabot group coupling vitest with @vitest/* (coverage provider) so major bumps arrive together.
- CONTRIBUTING.md documents the mandatory test-first flow and the solo-maintainer merge preference.
- CONTRIBUTING.md documents the Dependabot dependency PR routine (criteria, maintainer approval, workflow-file merge options).
- Project scaffold: Apache-2.0 license, CI (biome + typecheck + vitest + gitleaks, Node 22/24 matrix), npm publish via trusted publishing, issue and PR templates, Dependabot, lefthook pre-commit.

### Fixed

- Install docs register the scoped plugin name in `opencode.json` (an unscoped spec would attempt to install a nonexistent npm package).
- CI gitleaks job no longer fails on Dependabot pull requests (push-only).
