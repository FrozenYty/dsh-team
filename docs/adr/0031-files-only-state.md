# 0031 — The plugin's state is files only, and the storage domain is retired as a source of answers

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes [0027](0027-roster-file-under-the-workspace.md) for its storage-domain clause only** — *"The
  domain is demoted to import source and rollback path. It is never written once the file exists, and it is
  never deleted."* Both halves are now false, and in different ways: it cannot answer a read at all, and on
  this machine its file has been deleted after verification. Everything else 0027 decided stands — the
  file is the store of record, the root is bound in-process on first use, writes replace atomically, one
  writer per workspace with `foreign_write_at`, the import marker, and the record layout.
- **Amends [0014](0014-plugin-name.md)'s frozen-names table by pointer** — the domain name `team_roster` is
  still frozen for the reason that ADR gives, but the table's description of it as the place where every
  record and tombstone "already lives" no longer holds. The name did not change; a location did.

## Context

ADR 0027 moved the roster to a file and left the storage domain as the fallback: a Session with no
resolvable workspace kept being served from it, deleting the file rolled a workspace back to it, and it was
never written once the file existed. That made the domain a second source of answers, and the source of a
class of question no test can enumerate: which of two places answered this read?

Two changes finished the move. Every Session now has a root — the override, the workspace's
`.agents/team/`, or the frozen `<home>/.dsh/team-roster` — so a read never needs the domain, and a write
that has no bound root throws naming that invariant instead of falling through. And the domain stopped
answering: it is now the second leg of the *import* order rather than a source of reads, `table.get`
returns nothing for a Lead this process has not bound, and the value the schema publishes no longer
contains a case that cannot happen.

The rollback story did not survive, and saying so is part of the decision: there is no domain to roll back
to. What replaces it are three things that already exist — the archive (ADR 0030), the
`.agents/team/backups/` copies the migration writes before it touches anything, and the seed below for
carrying a roster to a new root.

## Decision

1. **`DSH_TEAM_SEED` names one file a new root reads its records from.** It accepts both this plugin's own
   `roster.json` shape (`{version, serial, rosters}`) and a storage-domain dump
   (`{unit, global, tables: {rosters}}`), told apart by their top-level keys rather than by a flag. It is
   read once, never written, and consulted only for a root that has no `roster.json`.
2. **A seed that is configured and unusable is a problem, not a fallback.** A typo in a path must not read
   someone else's records and look like success: the root stays empty and `list_members` says why.
3. **Every Session has a root**: `DSH_TEAM_DATA_DIR`, then the workspace's `.agents/team/`, then the frozen
   `<home>/.dsh/team-roster`. No write can fall through to the domain, and a write with no bound root
   throws naming the invariant — that is a caller that never bound the Lead, which is a bug worth naming.
4. **The domain no longer answers a read.** It is the last leg of the import order — `seed → domain →
   nothing` — and `table.get` returns nothing for an unbound Lead rather than borrowing the domain's copy.
5. **`storage.source` is `'file'` or `'none'`.** Serving from the domain became impossible, and a schema
   that keeps publishing a value which cannot occur is lying to whoever reads it. `'none'` did **not**
   disappear, for a specific reason: it covers a Lead this process has never bound — reachable through the
   storage API, not in production. It is not the "frozen directory could not be created" case, which
   reports `source: 'file'` with a `read_problem`.
6. **The legacy import leg stays for one release, deliberately.** `openRosterStore` still opens the domain
   and runs `migrateLegacyRoster` — the only remaining write to it — because that is how a profile that has
   never bound a workspace reaches its records on the new frozen root at first load. Removing the open and
   removing the migration **must happen together**: the copy needs a target.
7. **The domain's file on this machine was deleted**, after both migration backups were confirmed
   byte-identical to it by SHA256.

## Rationale

Two sources of answers cannot be tested into agreement; one can. The domain's only remaining value was as
a fallback nobody wanted, and the frozen root already gives every Session a place to write — so the
fallback's cost, a second answer to "where did this read come from", was being paid for a case the roots
now cover. The seed replaces the one thing the domain was genuinely good for: carrying records into a root
that has none, deliberately, once, with the file named by the person.

## Rejected alternatives

- **Keep the domain answering when no root resolves.** Rejected: every root resolves now, so the branch
  would be dead code that still has to be documented as live — the exact confusion this ADR ends.
- **Fall back to the domain when the seed is unusable.** Rejected: it turns a typo into a mystery, and it
  is the failure mode where a user believes they restored one roster and is reading another.
- **Delete the domain file in the release rather than by hand.** Rejected: deleting a user's durable state
  from a plugin is the owner's act, and it was done as one, with a SHA256 comparison first.
- **Remove the legacy import leg now.** Rejected: it strands exactly the profiles that never bound a
  workspace, which is the population the leg exists for.

## Consequences

- **One source of answers.** A read is answered by a file or by nothing, and "which place answered this" is
  no longer a question a reader has to ask.
- **The rollback is not a domain.** Deleting `roster.json` no longer falls back to the domain's copy; what
  a person does instead is name a seed, restore a backup, or read the archive (ADR 0030).
- **A temporary leg with a deadline.** The domain open and `migrateLegacyRoster` must be removed in the same
  change, one release after every profile has had a chance to bind — see Revisit when.
- **`'none'` is a narrow value.** It describes an unbound Lead, and a reader who sees it should read "this
  process has not bound that Session", not "the storage broke".

## Migration

Reads need none: a root with a `roster.json` is served from it, and a fresh root is imported once from the
seed if one is named, otherwise from the domain. A profile that has never bound a workspace keeps working
through the legacy leg until the root resolves. The domain file itself was deleted on this machine only,
after verification; no release deletes it for anyone else.

## Revisit when

The legacy import leg is removed — one release after this one, together with the domain open, once every
supported upgrade path has bound a workspace; or a Harness build stops publishing `storageDomain`, which
would make the leg unopenable and the removal mandatory rather than scheduled.
