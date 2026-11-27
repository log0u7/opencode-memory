# Conventions

Convention blocks ready to paste into an `AGENTS.md`. Each block is autonomous:
copy what a host needs, drop the rest. Rules are one line, one example each.

## Todo discipline

```markdown
- Todo list = single truth for "where are we": read before acting, update the moment state shifts.
- Every item opens with an epic tag: `[MESH]`, `[MEMORY]`, `[DOCS]`. One tag, CAPS, short.
- Item = one outcome + exact state: `[MESH] 0.11.0 TLS - builder DER + pinning - in flight`. Not `TLS stuff`.
- WIP = 1. Waiting on someone = `pending - BLOCKED on <what>`. Backlog = one `[BACKLOG]` item.
- Done = verified outcome, never a claim. Tick `completed` the moment the step passes, never in batch.
- Todo live at every pass: add on arrival, `in_progress` at start, `completed` at finish. Refresh the board BEFORE working.
```

## Session protocol

```markdown
- State before action: check every status claim against git/API/real files first. Memory is a hint, never the truth source.
- Run finished = committed: a result exists only once committed, before the next run starts.
- Cleanup never in bulk: one worktree at a time, check untracked data first, `--force` only after showing what dies.
- Ambiguous go = smallest named action: say what will run and what will be skipped before running, or ask.
- Verify beats guess: reproduce before announcing a root cause.
```

## Mesh communication

```markdown
- Pools are announce-only: `status:`, `decision:`, `alert:`. No discussion in pools.
- Direct DM (`mesh_send(to=...)`) for questions and tasks; answer with `reply_to=<id>`, both directions. Sender does not wait by default.
- Question needing an answer: `mesh_ask(...)` - never blocks, the reply arrives as a wake; answer with `mesh_reply(task_id, result)`.
- Status = the board, not a DM: `mesh_board_set(key, value)` is your one shared line; the board wakes nobody.
- Drain the whole inbox first (`mesh_inbox(ack=true)`), process the set in one pass, re-check before a decisive reply.
```

## Release ritual

```markdown
- Fix commit(s) green in CI, then one release commit: version bump + dated CHANGELOG heading.
- Annotated signed tag on the merged main commit, pushed alone: never chained behind an uncertain merge.
- After publish: pin the new version in the host config, restart the session, verify the panel serves it.
- 0.x minor may break; say so in a `Removed`/`Changed` CHANGELOG section and rewrite the README the same day.
```

## UI grammar (this repo's panels)

```markdown
- One tone grammar everywhere: `entity` = bold clickable title, `qualifier` = the numbers, `value` = labels and separators, `alert` = the attention glyph.
- No blank lines: an inapplicable line is omitted entirely.
- Sidebar width budget (32 columns): pack, then split, then truncate at the last word boundary - never mid-word, never a hard glyph cut (`300 fa` stays the anti-pattern).
- Panel headers carry the identity: `▼ Mesh: <name>`, `▼ Memory: <size>`.
```

## Style

```markdown
- Fragments over ceremony: one idea per sentence, active voice, no filler ("just", "basically", "actually").
- Code, paths, numbers, error strings stay verbatim. Dropped negations are bugs: never drop not/never/no/only.
- Example of a micro-convention: dash choice (em dash vs `-`) is a per-host style call - pick one, write it down, move on.
```
