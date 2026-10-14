# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

- `pnpm verify` (and therefore CI) now runs the suite with coverage, so the coverage gate
  the docs promise (90% lines/functions/statements, 80% branches) is actually enforced
  instead of only configured.

### Fixed

- The store database is created with restrictive permissions (file `0600`, directory
  `0700`) regardless of the process umask, as `SECURITY.md` already promised; databases
  created earlier with a permissive umask are tightened on the next open.
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
