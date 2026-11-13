# 0033 — The host storage domain is gone

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** — nothing. **This satisfies [0031](0031-files-only-state.md)'s named revisit condition**:
  *"The legacy import leg is removed — one release after this one, together with the domain open, once
  every supported upgrade path has bound a workspace."* 0031 decided the removal and dated it; this pays it.

## Context

ADR 0031 left one leg standing on purpose: `openRosterStore` still opened the storage domain and ran
`migrateLegacyRoster`, so a profile that had never bound a workspace could reach its records at first load.
It also wrote down that the open and the migration had to be removed **together**, because the copy needs a
target.

Two facts made the removal safe now. Every Session having a root (0031's decision 3) means anyone who
loaded v0.31.0 has already migrated — the roots are where the bytes went, and there is nothing left to
reach for. And the seed accepts a storage-domain dump (0031's decision 1), so a domain file left on another
machine is **a seed, not orphaned data**: the person names it, and the plugin reads it once.

## Decision

1. **The bundle no longer opens, reads or writes the host storage domain.** The import order is
   `seed → nothing`. Every root is a file, and a root with no file starts empty or from a seed.
2. **What is kept is a value, not a capability.** `PROVENANCE_SOURCE.domain` still names what an earlier
   version wrote into `provenance.json`, so a reader of that file is not told its history is impossible.
   Nothing in the plugin writes that value any more and nothing branches on it.
3. **`scripts/migrate-roster.mjs` still reads the domain file by path on purpose.** It is not part of the
   bundle, it is a person's tool, and its `--domain` flag is how that person produces the seed this ADR
   depends on. Reading a file by a path someone gave you is not opening a facility.
4. **A path whose ancestor is a file counts as no file.** `exists` answers `false` for `ENOENT` **and**
   `ENOTDIR`, because the platforms disagree: a path under a file is `ENOTDIR` on Linux and `ENOENT` on
   Windows, and only `ENOENT` was counted. The same broken data root was therefore an **existing** root on
   one platform and a **new** one on the other — and that boolean decides whether a new root is **seeded**,
   so one input produced two different rosters and nothing said so. CI on Linux found it; Windows could
   not.

## Rationale

The domain's remaining role was a compatibility leg with a deadline, and the two things that made it
necessary are both gone: nothing needs a fallback source, and a domain dump still travels as a seed. Keeping
a facility open for a case the roots now cover would keep the question this repository has spent three ADRs
ending: which of two places answered this read?

The platform difference is recorded here rather than as a decision of its own because it is not a separate
architectural choice — it is one boolean in the seed path this ADR owns, and it answers the same question
("does this root already have a roster") that the removed leg used to answer differently. It gets its own
numbered ADR when a second platform-dependent boolean appears; today it would be a thin ADR competing for
the number the in-flight portable-record decision needs.

## Rejected alternatives

- **Keep the domain open for one more release.** Rejected: the deadline was 0031's, the migration job is
  done for anyone on v0.31.0, and the seed covers the machine-to-machine case.
- **Delete `PROVENANCE_SOURCE.domain` with the code.** Rejected: `provenance.json` on every migrated
  machine may carry it, and a reader who finds an unknown value in a file the plugin wrote should find it
  named in the code that wrote it.
- **Copy the domain content into `migrate-roster.mjs` so the plugin never names it.** Rejected: the script
  is the one place that *should* read it, and it already did.
- **Count only `ENOENT` and treat `ENOTDIR` as an error.** Rejected: it turns "your data root sits under a
  file" from a reported problem into a throw at load — and it is still the same answer: there is no roster
  file there.

## Consequences

- **One source of answers, with nothing left to fall back to.** A root is a file, or it is new.
- **A domain-era provenance value outlives the code that could produce it**, deliberately.
- **The migration script is the only reader left**, and only by a path a person supplies.
- **`ENOTDIR` is now a first-class "absent"**, recorded in the code comment beside the check and tested.

## Migration

None for the plugin: a machine on v0.31.0 or later already has its records in a file. A machine coming from
before that must be seeded — the operator runs `scripts/migrate-roster.mjs --domain` to produce the file and
names it with `DSH_TEAM_SEED`, which is exactly what 0031 said the seed was for.

## Revisit when

A Harness build publishes a storage facility the plugin should use again (it would be a new ADR, not a
revisit); or `provenance.json` from before v0.31.0 is no longer readable by any supported version, at which
point the domain value can be dropped with the last machine that could hold it.
