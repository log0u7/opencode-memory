# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
