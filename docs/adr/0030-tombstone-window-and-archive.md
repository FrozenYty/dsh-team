# 0030 — A tombstone stays on the roster only while its artifact could still exist

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes the "Delete the tombstone along with the artifact" rejection in
  [0011](0011-trash-retention.md), and the position it supports ("a tombstone is never dropped")** — for
  records past the retention window whose bytes the cap has already removed. ADR 0011's cap, its unit, its
  `oldest first` order, its `never a move in flight` rule, its truthful tombstone, its reporting, and its
  bound to a retirement that actually moved an artifact in all stand: `pruneLeadTrash` is still called only
  from that one place.

## Context

ADR 0011 rejected deleting a tombstone with its artifact because *"draining a child does not remove its row
from the parent's durable `subagentCatalog`, so the tombstone is the only thing preventing the next read
from re-adopting the member. Dropping it re-adopts the member as a live ghost."* That was correct, and it
left the roster growing without bound: every retirement ever performed stays in `roster.json` forever,
including the ones whose bytes the cap deleted long ago.

Two facts made that growth unnecessary rather than merely untidy. A `pruned` tombstone can only ever answer
`reason: 'pruned'`, and the cap removes artifacts oldest-first beyond `trashLimit` — so beyond the newest
`trashLimit` tombstones there is nothing left to restore and nothing left to report. And the guard against
re-adoption does not actually need the *record*: the host hooks strip the shipped panels **by child Session
id**, so a list of ids keeps that guard while the record itself leaves.

The second fact was not obvious, and the first implementation found the harder half of it: `ensureAdopted`
compares a child against the roster's own records, so an archived tombstone's child would not merely
reappear in the shipped panel — it would be **adopted back as a live member** with a new `memberId`. An
archive changes every question that used to be answered by looking at the roster.

## Decision

**A tombstone stays in `roster.json` exactly while its artifact could still exist.** Older ones move to
`<data root>/archive.jsonl`.

1. **The window is the effective `trashLimit`**, not a number of its own. It is derived from the cap, so the
   two cannot drift out of step when a profile changes the cap.
2. **A tombstone leaves only when four conditions hold, in this order**: it is past the newest
   `trashLimit` tombstones; it names a trash destination; its move is not `pending`; and **its artifact is
   on no leg of the chain `restore_member` searches**. The window decides *when to look*; the filesystem
   decides *the outcome*. A record whose bytes are still on disk stays, however old it is.
3. **The ids survive the record.** `retiredChildIds` holds every retired child Session id this Lead has ever
   had, archived ones included, and it is rewritten on every write so a restored member leaves it.
4. **The bound is enforced on every write for that Lead**, not on one operation, which is why the records
   already past the window flush on the next write with no migration script. Reads never trigger it.
5. **The archive is append-only**: one JSON object per line, carrying `archivedAt`, `reason`
   (`beyond-trash-window`), the `leadSessionId` and the whole record. It is appended **before** the roster
   is replaced, so a crash between the two leaves a duplicate line rather than a lost record.
6. **A restore of an archived tombstone is a typed refusal** answering `reason: 'archived'` and naming the
   file, not a generic "not found".
7. **`list_members` says what left**: `archived_records` counts the archived tombstones and, when that is
   non-zero, `archive_file` names the file. A list that silently omitted them would read as a deletion.

**Deliberately not bounded:** the storage-domain mode (no root, so no neighbouring file), records with no
trash destination, records whose bytes remain on a leg, and the archive itself. An archive that deletes is
not an archive, and capping it is a separate decision with its own consent question.

## Why this is lossless

Beyond the window the artifact is gone by the cap's own guarantee, so there is no restore to lose: the only
answer an archived tombstone could have given is the refusal it still gives, from the file instead of the
roster. Nothing a reader could still act on is removed — which is exactly the line ADR 0011's rejection was
drawing, now drawn by the second condition of the four rather than by "never".

## Rejected alternatives

- **A fixed window of its own** (say 50 records). Rejected: two numbers that must agree will not, and the cap
  is the thing whose guarantee makes archiving safe.
- **Archive on read.** Rejected: it writes to the roster on a read, and a read-only workspace would then
  fail — the same reason ADR 0028 refuses to rewrite stored paths on load.
- **Cap the archive too.** Rejected here: an archive that deletes is not an archive, and bounding it is a
  decision about consent and retention that this one does not make.
- **Keep the tombstone and prune only its fields.** Rejected: it keeps the growth it was meant to end and
  loses the record's own evidence, which is worse than either extreme.
- **Archive without keeping the ids.** This is the variant that looks simplest and re-adopts the member as a
  live ghost, with a new `memberId`, on the next read — see Context.

## Consequences

- **The roster stops growing with history.** It holds recent members; the archive holds every retirement.
- **`retiredChildIds` grows monotonically** and is the only unbounded thing left in the file. It is a list of
  ids, not records, and it is what makes the panels correct.
- **One more file to back up.** `<data root>/` now holds `roster.json`, its import marker, `provenance.json`
  and `archive.jsonl`; the trash sits beside them.
- **A reader who wants an old member looks in the archive**, and `list_members` tells them it exists rather
  than leaving them to infer it.

## Migration

None, and none is needed: the next write for a Lead bounds its record, so the tombstones already past the
window flush then. A read does not flush, so a profile that only reads keeps showing them until something
writes.

## Revisit when

The archive needs to be searchable from a tool rather than a file; or a retention policy for the archive
itself is decided, which would need its own consent rule; or a Harness build stops stripping the shipped
panels by child id, which would make `retiredChildIds` insufficient for the reason it exists.
