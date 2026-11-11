# 0004 — Retire through the persistence layout, not by forking the roster

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

ADR 0001 decided this plugin owns the roster. v0.2 could retire a member in its own record and hide it in
the workspace archive, but two facts remained visible to users:

- the built-in top subagent picker and team panel kept rendering the member, because the shipped
  `subagentCatalog` and `agentTeam` projections are append-only and still contain it;
- the shipped roster's `maxMembers` budget stayed consumed, so retirement never bought back a slot.

A peer plugin (`dsh-team-admin`) solves both by working *around* the append-only log rather than through
it: move the member's persisted session directory into a trash folder (a move, not a delete), strip the
retired ids at the host's session-list exits, and credit the retired count back to the roster budget for
the duration of a spawn. It also does this from a human-facing HTTP admin panel rather than model tools.

Those mechanisms are orthogonal to this plugin's model-facing lifecycle, so they were adopted rather than
reinvented. What was *not* adopted: its HTTP admin surface, its own tombstone file, and its assumptions
about exact version numbers — this plugin already has a durable roster, so the roster record is the
tombstone.

## Decision

Retirement becomes four ordered steps, each independently fallible and each reported:

1. drain the child (releases activation and capacity);
2. move its persisted session into `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`;
3. tombstone the roster record, with `trashPath` when a move happened;
4. refresh two host-side effects: the projection filter's id cache and the roster slot credit.

Both host effects are **capability-probed and reversible**. They wrap `sessionController.list` /
`projections` / `control` / `follow` and patch the legacy roster's `maxMembers` getter plus `spawn`;
each returns a disposer that restores exactly what it replaced, and a host without those shapes degrades
the feature instead of failing the plugin.

## Rationale

- Moving the artifact is what makes the member disappear from the host's own discovery, because
  session-query drops a file that no longer exists. Nothing in the shipped contracts offers that.
- Stripping at the exit is the smallest surface that reaches every client: the Web app does not need to
  change, and the model's own tool results never contained the retired member anyway.
- The budget credit is a bookkeeping trick, and it is treated as one: it is scoped to one spawning Lead,
  reset in a `finally`, and skipped when the roster has no such shape (the newer team implementation has
  no `maxMembers` at all).

## Consequences

- The plugin now depends on host internals, even if only optionally. Every path is probed; none throws.
  A Harness upgrade degrades to "retirement works, the UI still lists the member", which is exactly the
  v0.2 behaviour.
- Wrapping shared services is visible to other plugins. The wrappers are transparent (same arguments,
  same return shape, mutated copy of the payload), restore on unload, and mark themselves so a reload
  neither wraps twice nor compounds.
- Retirement writes outside the Session log. The trash directory is recoverable by hand, and the record
  points at it; there is deliberately no `rm` outside the cross-device move fallback.
- A retired member cannot be resumed: its artifact is gone from the live store. That is the intended
  meaning of retirement, and why `message_member` refuses a retired target.

## Revisit when

The Harness ships a deletion or retirement operation for members, or a public projection seam that does
not require wrapping `sessionController`.
