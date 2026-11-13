# 0036 — One archived record can be looked up by identity

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes:** — nothing. ADR 0035 made the archive readable; this is the other half of that
  capability — the operation that makes it answerable **past the cap**. Neither replaces the other: one
  answers "what left the roster lately", this answers "what happened to *this* member".
- **Related:** [0035](0035-archive-readable-on-request.md) (the reader this builds on), [0032](0032-bilateral-succession.md)
  (where a target and a member id come from), [0030](0030-tombstone-window-and-archive.md) (the file).

## Context

ADR 0035 gave the archive a reader, bounded at the newest 50 records with the real total beside it. That
bound is right for an answer and wrong for a question: the archive exists so that "what happened to this
member?" has an answer, and after enough retirements the member being asked about is no longer in the newest
fifty. The tool would then be able to say *74 records exist* and be unable to show the one the person named.

Two things this change cost, recorded here because they are what the shape of the code is answering:

- **A probe that passed for the wrong reason.** The first test of the identity rule asserted that a
  sentence containing the target is not a match by testing equality where only containment could differ —
  so it would have passed with the text match still in place. The test now pins a tombstone whose
  `successor.target` is `reviewer-g2` and whose prose says `"Replaced by reviewer-g2"`, and fails if the
  prose is consulted.
- **A capped read broken while wiring the two paths.** Composing the lookup into the reader's call path
  temporarily made the capped read return the scan's rows; **an existing entry-layer test caught it before
  anything was committed.** The defect lived in the composition, not in either function — which is why the
  test that caught it was one that had been written for the *other* path.

## Decision

**The cap constrains what an answer carries, not what a search may read.** A lookup given a target scans the
whole archive and returns one row; the newest-50 window never applies to it. This is the whole decision, and
everything below follows from it.

1. **A miss carries the work behind it.** `archived_returned: 0` with `archived_scanned` (the lines that were
   read to be sure), `archived_total`, and a message naming the target. That is why those fields exist: an
   empty answer is a *result*, and without the cost beside it, it reads as a failed read.
2. **Identity, never prose.** A target is matched through `targetOf` — the plugin's own name-and-generation
   rule — or a `member_id` by equality. A `label`, an `assignment` and any sentence are never consulted,
   because a target appearing *inside* a sentence is not the same claim as a record that *is* that member.
   A text match would have been the first place in this bundle to break a rule that holds everywhere else:
   the roster is matched by identity, and a description is not an identity.
3. **The last match wins**, so a record that appears twice — the append-before-replace crash window — is
   answered by its newest line, exactly as the capped read answers it.
4. **The existing rules still hold**: one Lead's records only (the line records the `leadSessionId` it was
   written for), a damaged line is counted as `archived_unreadable` rather than raised, and a missing archive
   is not an error.

## Rationale

The alternative — a bigger cap, or a paging cursor — answers a different question: both keep the answer
bounded by recency, and the lookup's whole purpose is to escape recency. Reading the file once to return one
row is the cost of the question being answerable at all, and the cost is **reported** rather than hidden
(`archived_scanned`), so a caller can see what the answer took.

## Rejected alternatives

- **Raise the cap.** It moves the boundary rather than removing it, and every raise makes the unbounded read
  that the cap exists to prevent more expensive.
- **A cursor or offset.** Answers "give me the next fifty", which is not the question; the caller would have
  to page until it found the member, and would still not know when to stop.
- **Match the target against the record's text.** Cheapest to write and the first thing to go wrong: a
  tombstone's prose mentions names constantly (`"Replaced by reviewer-g2"`), and a substring hit would
  return a record that merely *talks about* the member.

## Consequences

- **The question is answerable at any depth of history**, which is what the archive was for.
- **The scan reads the whole file with no memory bound.** An answer carries `archived_scanned` so the cost is
  visible; a very large archive costs a full read, and that is stated rather than discovered.
- **There is no prefix or fuzzy matching.** A partial name is not an identity, so `review` does not find
  `reviewer-g2`, and the refusal names the target that was not found.
- **It answers one Lead only**, since one file serves every Lead under a data root (ADR 0035's rule).
- **It has not been exercised live.** The live checklist's lookup entry runs on a real store, on an archive
  larger than the cap, with the target beyond it — and that has not happened yet.

## Migration

None. The file and its lines are unchanged; this release adds a second reader.

## Revisit when

An archive grows large enough that a full scan is felt, which would want an index or a tail-first scan; or a
caller needs to find several records at once, which would want a list of targets rather than a second call
per name.
