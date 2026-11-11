# 0011 — The trash is capped per Lead, oldest first

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes [0010](0010-roster-layout-and-retention.md) for point 3 only** — *"Nothing is deleted automatically."* The rest of 0010 stands: one record per Lead with members inline, the single-file domain, and the write-time label cap.
- **Superseded by [0012](0012-configurable-retention.md) for point 1 only** — the cap is a declared config field with a documented default and a minimum, not a fixed constant. Points 2–7 stand: enforcement happens only inside a retirement that moved an artifact in, oldest first, conservatively about what it touches, never a move in flight, with a truthful tombstone and a reported result.

## Context

ADR 0010 wrote down the fact nobody had written and deferred the policy: a retirement moves a member's
persisted Session into `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/` and leaves it there
forever, one directory per retirement. It deferred retention to P4-03 because the trash holds real Session
artifacts, so a policy that deletes them is the owner's decision. The owner has now approved a cap.

The platform does not solve this for us, and that is the constraint the whole design answers. Verified
against the installed Harness, not its public source:

- `ctx.sessionPersistence` is append-only storage. Its service definition names only `create`, `open`,
  `flush`, `stat` and `list`; the installed JSONL backend implements exactly those
  (`dsh-session-persistence-jsonl/lib/index.js`), and its own README says it outright: *"Nothing deletes
  session files — logs accumulate under `root` until removed externally; the seam has no deletion API."*
- `sessionController` (the `ctx.remote.session` namespace) has no delete either: `list`, `search`,
  `create`, `fork`, `rename`, `cancel`, `state`, `events`, `projections`, `follow`.
- The only official "take a Session out of the way" mechanism is
  `workspaceRegistry.archiveSession` / `unarchiveSession` — a reversible flag. The platform never deletes
  Session bytes itself.

So a cap that actually bounds the disk has to delete something, and the only bytes this plugin may
reasonably delete are the copies it moved into its own trash. The design is therefore deliberately narrow:
small, per-Lead, oldest-first, reported in the result, and irreversible for the member it removes.

## Decision

   > **Superseded for this point by [ADR 0012](0012-configurable-retention.md).** The cap is now the
   > `trashLimit` field of the bundle's patch row, with `DEFAULT_TRASH_LIMIT = 20` as the documented
   > default and a minimum of 1; an out-of-range value is refused at load. The rest of this decision —
   > where, when and how the cap is enforced — still stands.

1. **A fixed per-Lead cap: `TRASH_LIMIT = 20`.** The unit is one Lead's trash directory. The constant is
   fixed on purpose, mirroring the shipped Agent Teams roster, which bounds its members with the
   `maxMembers` constant rather than a config key: this is a safety cap, not a preference, so changing it
   means editing that one line. 20 keeps a long recent history recoverable while bounding a directory
   whose entries are whole Session artifacts.
2. **Enforced only inside a retirement that actually moved an artifact in**, immediately after the move is
   confirmed and in the same call. No timer, no background work, no sweep on read: the move is the one
   moment the trash grows.
3. **Oldest first**, ordered by the millisecond stamp in the directory name (`<memberId>-<ms>`).
4. **Conservative about what it touches.** Only direct children of that one Lead's trash directory; only
   names shaped `<memberId>-<ms>` with a plausible member id and a numeric stamp; and only when a roster
   record's `trashPath` points at that exact directory. A foreign name, a plain file, a name with no
   numeric stamp, or an entry no tombstone accounts for is left exactly where it is. Nothing outside the
   trash root is ever removed.
5. **A move in flight is never pruned.** An entry whose record is not `trashState: 'done'` is skipped; a
   `pending` entry still counts against the cap so the total stays bounded, but its bytes are untouched
   because `pending` means the move may or may not have landed.
6. **The tombstone stays truthful.** A pruned entry keeps `trashPath`, `trashKind` and `originalPath` —
   the record still says where the artifact went — and its `trashState` becomes `pruned`. The enum is
   `pending | done | none | pruned`, and it is validated when a record is loaded. `restore_member` on a
   pruned tombstone answers `restored: false, reason: 'pruned'` and **never calls
   `workspace.unarchiveSession`**: there is nothing to unhide, and claiming a branch that did nothing is
   the false-success defect this plugin has already been repaired for twice.
7. **Reported, never silent.** The retirement result carries `pruned` (0 when nothing was removed) and,
   when it is above zero, a message that says how many artifacts were removed and why.

## Rejected alternatives

- **Delete nothing at all; mirror the official archive.** The platform's own answer to "take a Session out
  of the way" is the reversible archive flag, and it deletes nothing. Rejected: the cap was asked for to
  bound the disk, and a flag does not remove bytes. It also cannot help here on its own — retirement has
  already moved the artifact out of the live store, so by the time the trash is too large there is nothing
  left for the archive to hide.
- **Delete on restore only.** Drop a trash entry when the member is restored. Rejected: it bounds nothing
  for the members nobody restores, which is the normal case and exactly the growth the cap exists to stop.
- **A global cap rather than a per-Lead one.** Rejected: one Lead's activity would delete another Lead's
  artifacts. One Lead's trash directory is the unit an operator reasons about and the only unit the code
  can enumerate without crossing a boundary.
- **A time-based expiry.** Rejected: age is not what makes a trash entry valuable; recency is. A timer
  would also add a second clock and work on a schedule, where the move-triggered check needs neither.
- **Delete the tombstone along with the artifact.** Rejected: draining a child does not remove its row
  from the parent's durable `subagentCatalog`, so the tombstone is the only thing preventing the next read
  from re-adopting the member. Dropping it re-adopts the member as a live ghost — the reason ADR 0010
  gives for keeping tombstones at all. A pruned tombstone keeps its identity, its assignment and its path.
- **A configurable cap (`DSH_TEAM_ROSTER_TRASH_LIMIT`, `0` = unlimited).** Rejected on the
  mirror-the-platform rule: the shipped roster bounds members with a constant, and a safety cap nobody
  asked to tune is not a configuration surface.

## Consequences

- **A pruned member can no longer be restored.** Its bytes are gone; `trashPath` remains as the record of
  where they were, and the typed `pruned` refusal says so instead of failing on a missing directory.
- **No client sees a change.** Retirement already removed the artifact from the host's discovery, so
  pruning only decides whether the copy is still recoverable — it never alters what a running session
  list renders.
- The trash now has a hard bound: at most the effective cap — the `trashLimit` config field, default
  `DEFAULT_TRASH_LIMIT` (ADR 0012) — accounted artifacts per Lead, plus entries this plugin did not write
  and moves still in flight. Both exceptions are deliberate and both are visible to an operator who lists
  the directory.
- Loading a record now validates `trashState`. Every value this plugin has ever written is in the enum,
  so no stored roster is refused by it; an unknown value is a bug worth failing loudly on rather than
  guessing at.
- The record shape and the state matrix gain `pruned`; `docs/architecture-en.md` §4.2/§4.3/§4.4 carry it.

## Migration

`trashState` did not exist before this cap, so every tombstone written by an earlier release carries a
`trashPath` and **no state at all**. The cap reads a missing state as `done` — a record with a path has
completed its move; the field simply did not exist when it was written.

That rule is not optional politeness. The first live run of the cap pruned nothing, because an absent
state failed the "did the move land" test and every pre-existing tombstone was therefore exempt: the cap
was enforced only against records created after it. The regression test seeds state-less tombstones for
that reason, and the live re-run then pruned three artifacts and bounded the directory as designed.

## Revisit when

The owner wants a different number (set `trashLimit` in the bundle's patch row — ADR 0012, where
`DEFAULT_TRASH_LIMIT` is only the fallback), the Harness gains a Session-deletion API that
could retire the artifact in place, or the platform offers a per-plugin storage quota that makes a
self-imposed cap redundant.
