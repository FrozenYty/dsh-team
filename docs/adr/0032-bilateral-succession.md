# 0032 — A succession is bilateral, and it names an identity

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** — this one stands alone. ADR 0009 decided *when* the two halves run (successor first,
  predecessor second, one call); this decides *what is written*, and it adds a half 0009 never named.
- **Related:** [0009](0009-replacement-handoff.md) (ordering and the handoff), [0019](0019-definition-precedence-on-replace.md),
  [0030](0030-tombstone-window-and-archive.md) (what happens when the other end is archived).

## Context

A replacement writes two records: the successor that takes the position, and the tombstone the predecessor
becomes. ADR 0009 decided the ordering and the brief. What neither it nor the code said, until now, is that
the pair is a **link**: a reader holding either record should be able to name the other end.

Three facts made the shape non-obvious.

A **name** is not an identity here. `reviewer`, `reviewer-g2` and `reviewer-g3` are three holders of one
base name over time — that is the whole point of generations (ADR 0010's naming, ADR 0014's frozen base) —
so a stored target would resolve to whichever holder happens to be current, which is exactly the question
the link exists to answer. `member_id` and `child_id` are also not the same value for anything this plugin
spawned (ADR 0028 found the same split on the trash side), so the link has to say which one it carries.

And the roster is now a **file** whose load-time validation is the only gate it passes (ADR 0027, ADR
0031): a seeded or hand-edited roster is where a stale link would come from, and there is no other reader
between the file and the tools.

## Decision

1. **The reverse edge is written in the write that makes the record a tombstone.** Not in a later write,
   not by whoever reads it next: a chain that can exist for one state with one end missing is a chain a
   reader can observe half-built, and the window between two writes is exactly when a retirement can crash.
2. **An edge names an identity, never a name.** Both directions carry `{ target, member_id }`: the target
   for the reader, the member id for the resolution. `member_id` is the roster identity the record owns.
3. **Both directions exist and each record owns one.** The successor row carries `predecessor`; the
   tombstone carries `successor`. A reader holding either end can name the other without scanning.
4. **Load-time validation checks structure and deliberately not references.** A `successor` must be an
   object carrying a non-empty `target` and `member_id`, and no more than that is required. A **dangling
   edge is not malformed**: a predecessor whose tombstone is archived is what a correct record looks like
   (ADR 0030), and a load-time check cannot tell a dangling id from an archived one without opening the
   archive — which the hot path must not do. The reasoning is itself a test.
5. **The archived walk stops at the id.** `list_members` reports the id with **no target** when the other
   end is not in the roster, and it does **not** claim the predecessor is archived: claiming it would mean
   opening the archive on the hot path. The same read already reports `archived_records` and
   `archive_file`, which is where that history went (ADR 0030).
6. **A retirement with no successor records none.** The edge is written by a replacement, not by every
   retirement; a plain retirement has no successor to name and writes no field (ADR 0017's board rules
   already distinguish the two).

## Rationale

The roster is a state machine whose most consequential transition is "this role changed hands". Recording
only one direction makes that transition readable from one side; recording it by name makes it wrong the
next time the base name is reused; recording it by anything but the member id makes it unresolvable. The
pair of edges is also what lets a later reader — a person, a tool, or the plugin itself after a reload —
reconstruct who held a position and who took it over without trusting a label.

## Rejected alternatives

- **Store the predecessor's target name.** Rejected: generations make a name ambiguous by design.
- **Store the child Session id.** Rejected: it is not the roster identity, the artifact can be pruned, and
  ADR 0028 already had to draw this exact distinction once.
- **Validate that the edge resolves at load.** Rejected: it would open the archive on the hot path, and it
  would call a correct record broken because its other end was archived.
- **Write the reverse edge when the tombstone is next read.** Rejected: a read would then write, which the
  file store does not do (ADR 0027), and a crash between the two writes leaves the half-built chain.
- **Let the walk claim "archived" when the id is missing.** Rejected: an id can be missing for more than
  one reason, and the read already says which.

## Consequences

- **A reader can walk the chain from either end**, by member id, across retirement and a pruned artifact.
- **A stale edge is possible and is not an error.** A roster seeded from a file that predates this change
  simply has no edges; one seeded from a file with a stale edge reports an id without a target.
- **The tool result gained fields**, so the schema and the design documents carry them (`member_id`,
  `predecessor`, `successor`).
- **The edge survives the record's own retirement**, because it is written into the tombstone the
  retirement produces.

## Migration

None. An existing roster has no edges, which is a valid state: a link that was never written is absent, not
dangling. A replacement from that point writes both halves.

## Revisit when

The archive needs to be queried by the walk itself, which would change the "stops at the id" rule; or a
third participant appears in a handover (a role held by more than one member at once), which would make the
chain a graph and this pair of fields insufficient.
