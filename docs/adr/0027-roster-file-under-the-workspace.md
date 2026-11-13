# 0027 — The roster is a file the plugin owns under the workspace, and the storage domain is its import and rollback path

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes [0003](0003-roster-storage.md) for its store clause only** — *"The roster lives in
  `ctx.storageDomain`, not in the Session log"*. The decision that the plugin owns the roster (ADR 0001),
  the record layout (ADR 0010) and the storage domain's own name (ADR 0014) all still stand. It also
  supersedes the storage-domain row of [0014](0014-plugin-name.md): the domain still has that name, but it
  is no longer where a live roster lives.

## Context

ADR 0003 chose the storage domain because it was the only durable facility a zero-import bundle could
reach, and it chose correctly for the question it was asked: the alternative was a Session event type that
the Session refuses to reopen. What it did not weigh is where those bytes *are*. A domain record is
reachable through one Harness and one profile; it is not a file a person can look at, copy, diff or
version, and it dies with the profile that holds it. Every member record, every tombstone and every trash
path this plugin is responsible for lived there.

Two things forced the move. The trash paths in a tombstone are absolute, and a domain record cannot be
fixed by hand when a profile's data directory changes (ADR 0028 is the other half of that story). And the
plugin is the owner of this state by ADR 0001, so the honest place for it is a file the owner controls,
not a facility whose format the plugin does not define.

## Decision

**One `roster.json` per workspace root, at `<workspace>/.agents/team/roster.json`, read and written by the
plugin with `node:fs`.** The file is the store of record; every read and every write goes there.

1. **The file is created by importing the storage domain, once per Lead record.** A load imports when the
   content it serves holds no record for that Lead, and for no other reason. A marker beside the file
   records that the import happened — when, and how many members and tasks came across — so a reader can
   tell an imported roster from one this plugin built.
   **The marker records the import; it does not guard it.** The guard is the file's own content: an
   existing record is the truth, and a file that is absent or holds no record for that Lead is imported
   again on the next load. That is deliberate — see the rollback consequence below.
2. **The domain is demoted to import source and rollback path.** It is never written once the file
   exists, and it is never deleted. Deleting `roster.json` puts that workspace back on the domain, which
   is the documented way to roll back.
3. **The root is bound in-process on first use.** The workspace a Lead's bytes live under is resolved
   once and remembered for the life of the process, so a later `working_directory` call cannot move a live
   roster out from under a retirement that is halfway through.
4. **A Lead with no resolvable root keeps using the domain.** No workspace and no override is not an error
   and not an invented location: the domain is still served, and `list_members` says so with a note naming
   the way out (give the Session a working directory, or set `DSH_TEAM_DATA_DIR`).
5. **Writes replace the file atomically** — a temporary file in the same directory and a rename — so a
   reader never sees half a roster and a failed write leaves the previous file intact.
6. **One writer per workspace, and no lock file.** Every write re-reads the file first, which is also what
   merges a concurrent change instead of clobbering it, and a serial this process did not write is
   reported as `foreign_write_at`.

The stored layout, the two modes and the writer rule are described for a reader in
`docs/roster-storage-en.md` §4; this ADR owns why they are what they are.

## Rationale

The bytes are this plugin's own creation and its own responsibility. A file under the workspace is
inspectable, copyable, diffable and backup-able with ordinary tools; it is reachable without the Harness;
and it survives the profile. The domain keeps the one property the file does not have — it belongs to the
profile rather than to the workspace — and that is exactly why it is worth keeping as the fallback for a
Session that has no workspace to own bytes in.

## Rejected alternatives

- **Stay on the storage domain.** Rejected: the state stays invisible to the person whose members it
  describes, cannot be repaired by hand, and disappears with the profile. It also leaves the trash-path
  half of the problem unsolvable, because a recorded absolute path under the domain cannot be rebased.
- **A lock file beside `roster.json`.** Rejected: it adds a stale-lock failure mode that nothing cleans
  up, while the file already reveals the second writer. Two Lead Sessions in one workspace share the file
  by design, which is the same arrangement the subagent substrate itself has.
- **Move the file when the working directory changes.** Rejected: a roster is live state with in-flight
  retirements; moving it during a lifecycle operation is a window with no correct answer. Binding once is
  the smaller claim.
- **Write the file and the domain both.** Rejected: two writers of one fact, and the first disagreement
  between them is undetectable.

## Consequences

- **A second writer is detected late.** Two processes over one workspace are last-writer-wins, and the
  second one is reported when this process next reads or writes — not at the instant it writes. The
  plugin adds no lock and no merge protocol beyond re-reading before writing, and it says so in the result
  as `foreign_write_at`.
- **The domain is dead weight that must not be deleted.** It costs nothing to keep and it is the only
  rollback path; removing it would strand every profile that upgrades and every Session with no workspace.
- **Two notions of "the workspace" now coexist, deliberately.** This roster root is bound once per
  process; the `team/` directory that holds member definitions and the team file (ADR 0018, ADR 0021) is
  resolved from the Lead's working directory at call time. They answer different questions — where durable
  state lives versus which files the Lead is looking at — and merging them would make a definition
  disappear on a `working_directory` call.
- **The marker is a record for a reader, not a lock.** Deleting `roster.json` is the whole rollback: the
  next load finds no record for that Lead and imports the domain's copy again, and that is the behaviour
  the rollback depends on. If the marker gated the import, deleting the file would leave the workspace
  serving an empty roster while the domain still held the records — a documented rollback that rolled
  nothing back. An existing record in the file is the truth; an empty file stays empty only until
  something imports into it, and the marker never decides which.

## Migration

Greenfield: nothing is moved on upgrade. The first read of a root imports the domain's record and writes
both the file and the marker; the domain is left exactly as it was. Rolling back is deleting
`roster.json` — the next load finds no record for that Lead and imports the domain's copy again. The
marker needs no handling, because it records the import rather than switching it, and a session that
never resolves a root never migrates, because it never left.

## Revisit when

The Harness publishes a per-workspace durable store that the plugin can reach without an import; or a
second writer over one workspace becomes a real arrangement rather than an accident, at which point a lock
with an owner and a timeout stops being the wrong answer.
