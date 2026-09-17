# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Trunk-based workflow: `main` is the only branch (PRs required, protected by rulesets); `dev` removed.
- GitHub Copilot reviews pull requests.

### Added

- Coverage gate in CI: 90% lines/functions, 80% branches (`pnpm test:coverage` locally).
- Dependabot group coupling vitest with @vitest/* (coverage provider) so major bumps arrive together.
- CONTRIBUTING.md documents the mandatory test-first flow and the solo-maintainer merge preference.
- Project scaffold: Apache-2.0 license, CI (biome + typecheck + vitest + gitleaks, Node 22/24 matrix), npm publish via trusted publishing, issue and PR templates, Dependabot, lefthook pre-commit.

### Fixed

- CI gitleaks job no longer fails on Dependabot pull requests (push-only).
