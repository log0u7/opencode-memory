# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
