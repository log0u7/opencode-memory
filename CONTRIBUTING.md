# Contributing to opencode-memory

Thanks for contributing. This document covers the workflow, quality bar, and conventions.

## Workflow (simple gitflow)

- `main` : protected, releases only (tag `vX.Y.Z` triggers npm publish).
- `dev` : integration branch, PR target for all work.
- Branch from `dev`, name it `feat/...`, `fix/...`, or `docs/...` (max three words, hyphenated).
- Merges are `--no-ff`. Releases: merge `dev` into `main`, date-stamp the changelog, tag.
- Hotfixes branch from `main`, merge back into `main` AND `dev`.

## Commits

Conventional Commits: `type(scope): summary`. Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. Optional scopes: `store`, `tools`, `hooks`, `ci`.

## Quality bar

Every PR must pass, and you must have run locally:

```sh
pnpm verify       # biome check + typecheck + vitest
pnpm build:check  # tsc build + pack dry-run
```

## TDD

Changes follow red-green-refactor: write the failing test first, make it pass with the minimal code, refactor with tests green. Unit tests use real filesystem (temp dirs) and real SQLite: no mocks. Mocks are allowed only at true network/tool boundaries (mDNS, external CLIs).

## Conventions

- TypeScript strict; no `any`, no non-null assertions, no enums (use const objects), no star or aliased imports.
- Prefer functional array methods over loops; early returns over `else`.
- Secrets never appear in code, tests, fixtures, logs, or the memory store.
- Every PR updates `CHANGELOG.md` under `[Unreleased]` (Keep a Changelog format).

## Release process (maintainers)

1. Confirm CI green on `dev` and changelog accurate.
2. `git checkout main && git merge --no-ff dev`.
3. Move `[Unreleased]` to a dated `## [X.Y.Z] - YYYY-MM-DD` section; bump `package.json` version; commit `chore(release): X.Y.Z`.
4. `git tag vX.Y.Z && git push origin main --tags` : the publish workflow publishes to npm via trusted publishing.

## Security

Never open public issues for vulnerabilities: see [SECURITY.md](SECURITY.md).
