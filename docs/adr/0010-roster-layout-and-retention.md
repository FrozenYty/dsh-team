# 0010 — The roster is one record per Lead, and nothing is deleted automatically

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** [0003](0003-roster-storage.md) — the record layout only; the choice of `storageDomain`, the hand-written spec and the single-file warning all still stand.
- **Superseded by [0011](0011-trash-retention.md) for point 3 only** — the trash is now capped per Lead. The layout, the single-file domain and the label cap below all still stand.

## Context

ADR 0003 decided where the roster lives and, in passing, how it is shaped: *"One table holds one record
per member, keyed by a plugin-generated member id, and a per-Lead index record maps a Lead Session id to
its member ids."*

The code that shipped does something simpler, and the two never agreed: there is one table, `rosters`,
holding **one record per Lead Session id**, with the members as an array inside that record. No
per-member records exist and there is no index record. An independent audit found the divergence;
neither document had been wrong on purpose, which is why it survived four releases.

The same audit found a second fact that had never been written down at all: **nothing is ever deleted.**
A retirement keeps its tombstone forever and leaves the moved Session artifact in
`~/.dsh/team-roster/trash/<lead>/<member>-<ms>/` forever.

## Decision

1. The roster is **one record per Lead Session id** in the `rosters` table, with members inline. This is
   what the code does and what it keeps doing.
2. The domain keeps the default **single-file** layout.
3. **Nothing is deleted automatically.** Tombstones persist, and a moved artifact stays in the trash so a
   later `restore_member` can find it. The only removal is an emptied per-Lead trash directory, which
   `restore_member` drops once its last artifact has moved back. Retention is a deliberate deferral with
   an owner (P4-03), not an oversight.

   > **Superseded for this point by [ADR 0011](0011-trash-retention.md).** A retirement that moves an
   > artifact in now enforces a fixed per-Lead cap (`TRASH_LIMIT`, 20), removing the oldest artifacts and
   > marking their tombstones `trashState: 'pruned'`. Points 1, 2 and 4 of this decision stand unchanged.
4. The label is capped at write time (`LABEL_MAX`), because the record is a single JSON document that is
   rewritten in full on every mutation.

## Why not the per-member layout 0003 described

- **A retirement has to be one consistent document.** The tombstone, the trash path and the phase are
  written together; the storage facility serializes `update` per key, not per table, so splitting members
  into their own records would make "tombstone plus reservation" a multi-record transaction with no
  transaction to put it in — the exact lost-update class this roster was just repaired for.
- **The migration is the risk, not the layout.** Moving existing single-file records to per-record files
  would have to rekey every record, and a mistake makes every tombstone invisible — which is precisely
  what `restore_member` depends on. That is a bad trade for a store this size.
- **The cost is bounded.** Every mutation rewrites one Lead's document. With the label capped at 200
  characters and the assignment at 1000, a hundred-member roster is a few tens of kilobytes. That is paid
  on a spawn or a retirement, not on a read.

## Consequences

- Trash artifacts and tombstones accumulate. The trash holds real Session bytes, so this is the part that
  will eventually need a policy; P4-03 owns it. Until then the path is documented in both READMEs, so the
  owner can clear it by hand without guessing where it is.
- A tombstone is not free either: it is what prevents a drained member from being re-adopted, so it
  cannot simply be dropped while the Session row still exists in the parent's catalog.
- `$DSH_HOME/storages` has no cross-process lock (0003), so two Harness processes over one store remain
  last-writer-wins. The roster is correct for one running Harness, which is how subagents work too.
- Load-time validation deliberately does **not** reject a stored label longer than `LABEL_MAX`: refusing
  to load a whole roster over a display field would brick the plugin, so the cap is a write-time contract.

## Revisit when

A single Lead's roster passes a few hundred members, or one document that size hurts a write; or
`storageDomain` offers a per-record layout with a documented migration and the migration can be tested
against a real store.
