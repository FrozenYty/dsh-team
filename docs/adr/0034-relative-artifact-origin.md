# 0034 — An artifact's origin is stored relative to the sessions root

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** — nothing. It is the sequel to [0028](0028-trash-directory-name-not-path.md) for the
  other half of the same record: 0028 made the *destination* portable, this makes the *origin* portable.
- **Related:** [0027](0027-roster-file-under-the-workspace.md), [0031](0031-files-only-state.md) (the file
  a person can carry, which is what made this necessary), [0033](0033-domain-removed.md).
- **Its recorded follow-up is settled, with no successor ADR:** v0.35.0 writes `trashRelPath` with forward
  slashes and reads it on either separator, which is this ADR's own rule and ADR 0028's applied to the field
  that was left behind — strict on write, tolerant on read, safe because no legal segment of that field can
  contain a backslash. A new ADR would have restated the path chain's existing rule for one more field, so
  the documents state it instead (`docs/roster-storage-en.md` §3).

## Context

ADR 0028 stopped a tombstone recording an absolute *destination*, because the roster is a file a person
copies to another machine and an absolute path from this one names nothing there. The **origin** was left
absolute, on the argument that it points into `~/.dsh/sessions`, which has no root to be relative to.

The seed (ADR 0031) and the domain's removal (ADR 0033) end that argument. Carrying a roster to another
machine is now a documented operation, and on that machine an absolute origin is not merely untidy: a
restore would move the artifact to a path that does not exist there.

## Decision

1. **What is written.** `originalRelPath` holds `<slug>/<leaf>` with **forward slashes**, where the leaf is
   the encoded Session id the persistence backend uses and the slug is the workspace segment the host
   actually chose — taken as the host spelled them on disk, never recomputed from the working directory,
   because a prediction of the host's naming rules would break silently the day they change and this field
   is evidence of what the host did.
2. **Nothing is written when there is no anchor.** When the artifact does not sit in a directory named
   after the member (the backend reported a bare file elsewhere), the record stores **no path at all**
   rather than a guess.
3. **The read order, in full** (`originalPathFor`): the relative form against the sessions root in effect;
   then the stored absolute as a **read-only legacy leg**, so every existing record works with no
   migration; then, for a tombstone that recorded neither, the member's own id under the root. **The first
   leg is the answer when it resolves.** The sessions root comes from a **sibling Session the persistence
   service still reports**, anchored by the member's id so that either shape a backend reports works, or
   from the service's own report. The other two legs are fallbacks that were tried and are not answers on
   their own: `legacy-absolute` is history, and `derived` is a reconstruction.
4. **Load-time validation refuses by name**: an absolute path, a drive letter, a backslash, an empty
   segment, `.` or `..` — same treatment and same reason as the succession edge (ADR 0032). A seeded or
   hand-edited roster is exactly where a bad value comes from, and a path that escapes the root would let
   a restore write outside it.
5. **A replacement stops writing the absolute form.** `originalPath` becomes a read-only legacy field:
   present on older records, read, never written by this release.

## The measured saving, and the correction it carries

The field costs **39.0 bytes per record** — 687 bytes on this profile's roster (36 records, 20 carrying
the field) and 3,354 on the pre-flush shape — because both forms carry the child id, which is most of the
string. An earlier estimate of ~8.5 KB implied roughly 90 bytes per record and was **wrong by a factor of
two and a half**; it was the Lead's estimate, and the measurement is here so the next estimate starts from
a number rather than a guess.

**Portability is the reason and the bytes are a footnote.** The field exists because a carried roster must
resolve on the machine it arrives at; the saving is a side effect of dropping a longer string, not the
argument for the change. An ADR that led with the saving would invite someone to revert it the day a
longer path made it cost more.

## Rejected alternatives

- **Keep writing the absolute path beside the relative one.** Rejected: it would zero the saving, and two
  answers to one question is the arrangement this repository keeps removing. It is the decision to revisit
  if a limit below ever bites, not a default.
- **Recompute the slug from the working directory.** Rejected: it predicts the host's naming rules instead
  of recording what the host did.
- **Store a path relative to the workspace instead of the sessions root.** Rejected: the sessions root is
  what the persistence service can name, and a workspace-relative path would need a second service to
  resolve.
- **Migrate every existing record.** Rejected: the legacy leg already reads them, so a write pass would buy
  nothing a reader can observe — the same reasoning ADR 0028 used.

## Consequences

- **A roster carried to another machine resolves its origins**, which is the point.
- **A record whose artifact has moved and whose session the host no longer reports has no leg but the
  stored absolute**, which this release stops writing. Two limits are named rather than hidden: that case
  (a single-member Lead, where no sibling can reveal the root), and **`trashRelPath` still uses platform
  separators while this field uses forward slashes** — a recorded follow-up of the same class, to be
  settled the next time ADR 0028's shape is touched, where a reader of that ADR will find it.
- **The loader gained refusals**, so a hand-edited roster with a backslash now fails by name at load
  instead of resolving oddly later.
- **`originalPath` is now legacy**, and a reader of the record shape has to be told which of the two fields
  is live.

## Migration

None. An older record keeps its absolute origin and is read through the legacy leg; a new one carries the
relative form. Nothing is rewritten on load, and a record that has both is read through the relative form
first.

## Revisit when

A single-member Lead actually loses an artifact that has moved (the limit above), which would mean writing
both fields and paying the bytes; or ADR 0028's shape is next touched, which is when `trashRelPath`'s
platform separators should be settled with it.

## A test-design rule this release also produced

The flaky test that surfaced here was real nondeterminism, not a bad assertion about behaviour:
`pruneLeadTrash` orders candidates by millisecond stamp, a fast runner produces two retirements in one
millisecond, and the test asserted which of two **equally old** records the cap removed. The rule —
*two artifacts stamped in the same millisecond are equally old, so the cap deleting either is not wrong;
what is wrong is a test that asserts which* — is not a decision about the plugin, so it lives in
`CONTRIBUTING.md`'s testing section rather than here. This ADR records only that it came from this change.
