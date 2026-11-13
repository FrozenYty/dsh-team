# 0038 — The spend field has three sources

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes, as one clause:** [0037](0037-member-spend.md)'s limits claim that the field is **resident-only**
  — precisely this sentence from its Consequences: *"The 'which member is expensive' question is answerable
  for mounted members only. The handle is `ctx.agents.get(childId)`, and an unloaded child has no Agent, so a
  non-resident member shows no spend at all."* Everything else in ADR 0037 stands, and is named below so that
  a reader knows what did not move.
- **Related:** [0037](0037-member-spend.md) (the field this extends), [0028](0028-trash-directory-name-not-path.md)
  (the retirement move that decides the third source).

## Context

ADR 0037 gave a row its `spend_tokens` from the member's live Agent, and named the consequence honestly:
only a **mounted** member could show one. That makes "which member is expensive" answerable for the members a
Lead has loaded and silent about every other — including the retired ones, which is exactly the population a
person asks about when a bill arrives.

The research for this decision found **three graded paths**, and the third is unreachable for a reason the
plugin already knew: a retirement moves the session artifact, and `trash.js:5` says what that does — *the move
also drops the artifact out of the session-query index*. So after the move the member cannot be asked at all;
what survives is a cache record whose `createdAt` no longer matches anything the listing returns, and the
tombstone does not store `createdAt`. The only moment the plugin still holds the session is the retirement
itself.

## Decision

**One field, three sources, tried in this order, and the meaning of the value depends on which one answered.**

1. **mounted** — the member has an Agent, so
   `ctx.get('sessionProjections')?.snapshot(agent.session, ['tokenUsage'])` answers. Today's path, and the
   cheapest: one projection read per row, no listing and no log.
2. **unloaded but not retired** — one `ctx.get('sessionQuery')?.listSessions()` **per `list_members` call**
   (a metadata listing, hoisted once, never per row), then the header whose id matches the member, then
   `ctx.get('sessionProjectionCache')?.cachedSnapshot(header, ['tokenUsage'])`, which the Host serves from
   its own cache with no log read. **The header is the identity witness** — that is why the listing belongs
   to the call and not to the row.
3. **retired** — the number is **captured at retirement, before the artifact is moved**, and stored on the
   tombstone. This is the only moment the session is still held (see Context), which is why the capture
   happens there and nowhere else.

**The capture is worth a fallback, and nothing else is.** The projection cache rejects a row whose
`stateVersion` no longer matches the live unit, so a token-meter bump silently blanks every cold read. At
**retirement** — one member, once, and the data unrecoverable a moment later — folding the durable log through
`readSession` is affordable. **Never on a row**: an exact read replays the whole log, and the query service's
own README says a large history pays full inspection per call.

**The field starts existing at retirement, not before.** A tombstone written before this version carries no
number, and none can be recovered: its artifact is in the trash, its cache row cannot be matched, and
inventing a value is the one thing this field must never do. The number appears on retirements from this
version on.

**What the value means, which changed:**

- on a live or unloaded member, *what its session has processed so far* — it can grow, and it can fall
  (ADR 0037's assertion stands);
- on a tombstone, *what it had processed when it was retired* — **frozen**, and it will never change again.

## What carries over from ADR 0037, unchanged

- **Omitted, never zero** — the six cases and the reason: *"nothing measured" and "nothing spent" are
  different claims*, and a partial sum would be a plausible-looking lie. A fourth source does not weaken this;
  a member none of the three can answer still omits the field.
- **The sum is unweighted and there is no price table** — a limit of the field, not a defect.
- **The non-monotonicity is asserted by a test** — a fall between two reads is the measurement, not a bug.
- **`ctx.get`, never `inject`** — a profile without any of these registries must still load; the optional
  pattern is what lets this field exist on a host that has none of them.

## Rationale

The order is cheapest-first and the costs are different: a mounted read is one projection; an unloaded read is
one listing per call plus a cache hit; a capture is paid once per member, at the one moment the data is about
to be lost. Running the expensive read per row would make `list_members` cost grow with the roster; running the
listing per row would multiply a metadata query by the number of members.

## Rejected alternatives

- **A per-row `listSessions()`.** One metadata query per member, on a read whose point is that it is cheap.
- **A per-row exact log read (`readSession`).** Replays the whole log per member; the query service documents
  that cost itself.
- **Backfill old tombstones from the cache.** Their `createdAt` matches nothing the listing returns, so there
  is nothing to backfill *from* — and a guessed number is the failure this field exists to avoid.
- **Leave it resident-only** (ADR 0037's answer). Rejected by decision: it answers only for the loaded
  members and never for the retired ones.

## Consequences

- **The question is answerable for every member, with one gap that is historical:** retired members from
  before this version have no number and never will.
- **A retirement now writes one more field**, captured before the move. That is the only write this decision
  adds, and it is on the path that was already moving an artifact.
- **A cold row costs one listing**, shared by every row of that call — not a cost that grows with the roster.
- **A token-meter `stateVersion` bump blanks cold reads, and retirement is the one place that survives it**
  because it pays the exact read while the session is still held.
- **Not implemented in this version.** v0.38.1 ships the mounted source only; this ADR records the decision
  the next change implements. A reader checking the shipped code for the second and third sources will not
  find them yet.

## Revisit when

The listing proves too costly on a very large profile, which would want the target ids filtered at the query
rather than after it; or a `stateVersion` bump turns out to blank more than the cold reads, which would move
the fallback rather than add one.
