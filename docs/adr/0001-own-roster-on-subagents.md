# 0001 — Own the roster on `ctx.subagents` instead of extending the shipped team

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

The user's problem is not context length: it is that a teammate cannot be removed or replaced. The
shipped experimental Agent Teams packages were examined line by line before this decision.

- The roster is a fold over the Lead Session's append-only event log (`team/member`).
- Member phases are closed: `provisioning | active | failed`. `applyCurrentTeamEvent` throws on any
  transition out of a terminal phase, and `applyProjectionEvent` records the throw as a permanent
  `state.failure` — after which every Team read and mutation for that Lead throws. A fabricated
  "retired" event does not fail safely; it destroys the Team service for that session.
- `maxMembers` (16) is compared against a list that never shrinks, so finished and failed members keep
  consuming it. Names are never reused.
- Upstream's in-progress redesign moves members onto subagents, but still states "names are permanent"
  and calls a delete operation "a later product decision".

Three options were considered:

1. **Extend**: add a `retire_member` tool on top of the shipped service. Rejected: the roster row
   cannot disappear, the name and the member slot cannot be freed, the shipped `list_agents` still shows
   the member, and the cumulative cap still applies. The tool would be advisory only.
2. **Fork**: vendor the shipped roster source and add a `retired` phase. Rejected: it forks a design
   upstream is actively deleting, and the projection's replay and cache-version invariants make the fork
   expensive to keep in step.
3. **Own**: disable the shipped team rows and keep our own roster on the Harness subagent substrate.

## Decision

Option 3. The plugin owns the roster. A member is a child created through
`ctx.subagents.startActivation(...)`, and the plugin keeps its own durable record per member with an
explicit `retired` phase, generation-suffixed names, and a `replace_member` operation. The shipped
roster and its tools are disabled by the bundle patch so that two rosters never answer the same question
differently.

## Rationale

- The lifecycle states the user needs (`retired`, a reusable name, a replaced predecessor) are
  representable in a store we own and unrepresentable in the shipped log.
- `ctx.subagents` already provides the expensive half: continuable children, inbox messaging,
  interruption, draining, cold resume, capacity. We own only the bookkeeping.
- The substrate is where upstream is heading, so this work is not thrown away by the redesign.
- Holding state outside the Session log also respects the Harness rule against third-party plugins
  appending new event types.

## Consequences

- The plugin must reimplement what the team tools gave for free: listing, messaging, stopping, and
  eventually a shared task board. Each is small, but they are real.
- The shipped Team panel, if it appears in a future build, will show whatever the shipped roster thinks
  rather than ours. Until a UI of our own exists (P3), the roster is visible through tools only.
- Retirement is a lifecycle fact in our record, not erasure. The child's Session stays on disk, and the
  Harness catalog still knows the child existed.

## Revisit when

The Harness ships a deletion or retirement operation for members, or a stable public API for a custom
roster. Either would make our bookkeeping redundant.
