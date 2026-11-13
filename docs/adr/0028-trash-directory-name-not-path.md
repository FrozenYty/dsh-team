# 0028 — A tombstone records a trash directory name, and the absolute path is computed at read time

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes [0011](0011-trash-retention.md) for point 3's matching rule and point 6's `trashPath`
  wording** — *"only when a roster record's `trashPath` points at that exact directory"* and *"a pruned
  entry keeps `trashPath`, `trashKind` and `originalPath`"*. The cap itself (default, minimum,
  enforcement only inside a retirement that moved an artifact in, oldest first, never a move in flight,
  a truthful tombstone, a reported result) stands, as does ADR 0012's configurability.
- **Also supersedes the comparison in [0009](0009-replacement-handoff.md)** — *"it survives retirement as
  a tombstone fact, exactly like `trashPath`"* — because `trashPath` is no longer the shape of a tombstone
  fact, and the data-directory clause of [0014](0014-plugin-name.md), which describes every tombstone as
  recording an absolute `trashPath` under `~/.dsh/team-roster`.

## Context

A tombstone used to carry one absolute `trashPath`. That is a fact about one machine at one moment: it
breaks when the profile's data directory moves, when the workspace moves, when the home directory differs
between two installs, and when a person changes `DSH_TEAM_DATA_DIR`. Worse, it cannot be repaired from the
outside, because a record is a stored value rather than a computed one.

The retirement also names its directory after the **child Session id**, while the record's own identity is
its `memberId` — two ids that are equal for an adopted member and different for a spawned one. The prose
in this repository did not distinguish them, and that is the best available explanation for the defect
described under Consequences.

## Decision

**A tombstone records where its artifact sits relative to the data root, and the absolute path is a
read-time computation.**

1. **The record carries `trashDir` and `trashRelPath`.** `trashDir` is the name retirement gave the
   directory; `trashRelPath` is that directory under the data root. A record written before this field
   existed keeps its absolute `trashPath` and keeps working with no migration.
2. **The directory name is the stable part, so both readers go through it.** `recordedTrashDir` answers the
   name from `trashDir`, then from the last segment of `trashRelPath`, then from the last segment of
   `trashPath`. Restore and the retention cap both call it.
3. **Restore resolves through three legs, in order**: the data root in effect (the recorded relative path,
   or the layout rebuilt from the name when a record has a name but no relative path); the absolute path
   the record itself carries, which is what every older tombstone has; and the frozen `~/.dsh/team-roster`,
   where an artifact nothing has moved yet still sits. Duplicates are dropped, so the ordinary case yields
   one candidate per leg rather than two. The resolver and the cap are described for a reader in
   `docs/roster-storage-en.md` §3.
4. **The cap matches a tombstone by directory name.** A name shaped `<id>-<ms>` with a plausible id and a
   numeric stamp is ordered by its stamp, and a tombstone is matched to it by the name it carries. This is
   the one part of a trash location that survives the root moving.
5. **The flip uses the record's own `memberId`.** The name's id is the child Session id; it is used only as
   a fallback for a row that carries no `memberId` at all.

## Rationale

A name relative to the root is portable across every move the absolute path cannot survive, and it is
still a fact about the move rather than about the moment it is read. Keeping the old shape readable means
no migration gate: an upgraded profile restores tombstones written by any earlier release, on whichever leg
still holds the bytes.

## Rejected alternatives

- **Rewrite every stored path on load.** Rejected: it writes to the roster on a read, and a read that
  cannot write (a read-only workspace) would then fail.
- **Keep the absolute path as the authority and add a relative field.** Rejected: two answers to one
  question, and the stale one wins by being first.
- **Match the cap by parsing the id out of the directory name.** This is what the previous release did, and
  it is wrong: the name carries the child Session id, so the parsed id matched no `memberId` and the flip
  hit the wrong record — see Consequences.
- **A migration that rebases every tombstone.** Rejected for now: it is a write pass over stored state that
  buys nothing while the three-leg resolver already finds the bytes, and it would have to be idempotent and
  interruptible for a benefit no reader can observe.

## Consequences

- **The defect this ADR exists to prevent, stated plainly.** The retention cap emptied an artifact and then
  flipped the tombstone it believed it had emptied, comparing an id parsed out of the directory name
  against `memberId`. Because the name carries the child Session id, the flip missed: **46 of 63 measured
  tombstones read `trashState: done` while their recorded location was already gone** (28 on the first leg
  plus 46 on the legacy leg is the 74 dangling paths the storage move measured). Their bytes had been
  removed by the cap and their records still claimed the sessions were recoverable. The fix compares
  `record.memberId`, which is what `retireMember` flips on.
- **The prose carried the same confusion as the code.** Four documents named the trash directory
  `<memberId>-<ms>`; a retirement has always written `<childId>-<ms>`. A reader checking the cap's matching
  rule against those documents would have found a rule that looked consistent and was not. The new ADRs
  record the distinction, and the design documents now use it.
- **The old path keeps working without a migration.** Every tombstone written before this release restores
  through the second or third leg, and a record whose artifact is gone on every leg answers
  `reason: 'trash-missing'` rather than throwing.
- **`restore_member` and the cap now agree by construction.** Both ask `recordedTrashDir`, so a change to
  the name's shape has one place to change.
- **A relative path is not a checksum.** A record silently follows the root if the root moves to a
  different directory tree with the same layout, which is the intended behaviour and the reason the name,
  not the path, is the matching key.

## Migration

None required and none performed. New tombstones carry the relative fields; old ones keep the absolute path
and are read through the fallback chain. The 46 already-wrong records are left to the roster migration,
which walks every tombstone; until it runs they answer the generic `trash-missing`, and the fix is
forward-only.

## Revisit when

A tombstone has to survive a change in the directory-name shape itself, which would need a name that
carries both ids; or the fallback chain's third leg (the frozen `~/.dsh/team-roster`) can be dropped
because no supported release ever wrote a path there.
