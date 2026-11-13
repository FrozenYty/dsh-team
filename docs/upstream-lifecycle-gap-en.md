# The member lifecycle gap in the experimental Agent Teams packages

> Owner: @FrozenYty · Revisit when: the experimental Agent Teams packages ship a member lifecycle that can
> retire, or the Team projection stops recording a terminal-phase transition as a permanent failure.

This is the gap `dsh-team` exists to fill, written so it can be filed as an issue against
`@deepseek-ai/dsh-experimental-agent-team` and `@deepseek-ai/dsh-experimental-tool-agent-team`
(0.2.2-rc.1 as installed). Every claim below is cited by file and line in this repository
(github.com/FrozenYty/dsh-team); the Harness facts inside those citations were read from the installed
build, and this repository's own lifecycle is described in `docs/member-lifecycle-en.md`.

## 1. What the shipped roster can do

- The roster is a fold over the Lead Session's append-only event log (`team/member`)
  (`docs/adr/0001-own-roster-on-subagents.md:12`).
- Member phases are closed: `provisioning | active | failed`. `applyCurrentTeamEvent` throws on any
  transition out of a terminal phase, and `applyProjectionEvent` records that throw as a permanent
  `state.failure`, after which every Team read and mutation for that Lead throws
  (`docs/adr/0001-own-roster-on-subagents.md:13-16`).
- The member budget is `maxMembers` (16) compared against a list that never shrinks, and a name is never
  reused (`docs/adr/0001-own-roster-on-subagents.md:17-18`). Upstream's in-progress redesign still states
  "names are permanent" and calls a delete operation "a later product decision"
  (`docs/adr/0001-own-roster-on-subagents.md:19-20`).
- There is no completion notice: a descendant's `activity` is only `running | inactive`, and `inactive`
  also covers a child that never started (`docs/architecture-en.md` §7).

## 2. Why the gap cannot be closed from outside

A synthetic "retired" event is not a safe workaround: the projection records the transition's throw as a
permanent failure that disables the Team service for that Lead
(`docs/adr/0001-own-roster-on-subagents.md:13-16`). A plugin cannot append a new event type either
(`docs/adr/0001-own-roster-on-subagents.md:49-50`), so the only implementable answer is a roster held
outside the Session log. The cost of that failure state is
already visible in this plugin: when membership cannot be read, a live root agent is accepted as the Lead
so the tools — including the retirement that repairs the team — stay callable (`index.js:107-122`).

The platform also deletes nothing, so a member's Session outlives its place in the roster:

- `ctx.sessionPersistence` names only `create`, `open`, `flush`, `stat` and `list`; the installed JSONL
  backend says outright that the seam has no deletion API (`docs/adr/0011-trash-retention.md:18-21`).
- `sessionController` has no delete either: `list`, `search`, `create`, `fork`, `rename`, `cancel`,
  `state`, `events`, `projections`, `follow` (`docs/adr/0011-trash-retention.md:22-23`).
- The only official "take a Session out of the way" mechanism is the reversible
  `workspaceRegistry.archiveSession` / `unarchiveSession` flag; the platform never deletes Session bytes
  itself (`docs/adr/0011-trash-retention.md:24-26`).

A roster that cannot shrink therefore keeps charging the budget, keeps the name taken, and leaves every
Session it ever held on disk.

## 3. What this plugin works around, and how

`dsh-team` does not extend the shipped projection. It owns a roster on the Harness subagent substrate,
never writes a session event, and keeps its durable state in a `storageDomain` domain
(`docs/adr/0001-own-roster-on-subagents.md:34-39`; `docs/architecture-en.md` §4). The
workaround is the lifecycle the shipped roster does not have:

- **A `retired` phase it owns.** Retirement is a protocol, not a deletion: record the reason, drain the
  child, tombstone the record, move the persisted Session into a trash the plugin controls, confirm the
  move, enforce a cap, hide the member from the projection exits, and report what happened
  (`docs/member-lifecycle-en.md` §3).
- **A move, not an erasure.** The Session moves to
  `<data root>/trash/<leadSessionId>/<childId>-<ms>/`, and recovery is a directory move back
  (`docs/member-lifecycle-en.md` §4). Because the platform has no deletion API, the retention cap
  deletes only the copies the plugin itself moved into its trash
  (`docs/adr/0011-trash-retention.md:28-30, 44-52`).
- **A reusable name.** Generation 1 is the bare base name and generation 2 and later is `<base>-g<N>`, so
  a successor reuses the name instead of colliding with a permanently taken one
  (`docs/roster-storage-en.md` §1).
- **A briefed successor and its work.** A replacement starts a successor from a brief composed from the
  predecessor's record and hands over the predecessor's open tasks in the same call; a retirement without
  a successor leaves those tasks unowned and names them (`docs/task-board-en.md` §2). The
  work board is the plugin's own, because the shipped board belongs to the shipped roster
  (`docs/adr/0017-own-task-board.md:9-13, 44-48`).
- **Its own model-facing surface.** The plugin serves `spawn_member`, `list_members`, `message_member`,
  `stop_member`, `retire_member`, `restore_member`, `compact_member`, `handoff_template` and `task_board`,
  and v0.14.0 disables the shipped `tool-agent-team` row that used to provide the parallel set
  (`cordis.patch.yml:28-44`).

Two limits remain inherent to working around rather than fixing: the shipped catalog still knows the
member existed, because the platform never deletes what it owns
(`docs/architecture-en.md` §8); and the shipped catalog can still be listed beside this
plugin's, because the `agent-team` service that answers `list_agents` stays mounted for adoption and the
projection filter. Retiring the shipped *tool* row in v0.14.0 removed the spawn, wait and task tools it
published, not that service (`cordis.patch.yml:28-44`).

## 4. What a rename has to freeze

The plugin was renamed to `dsh-team` in v0.10.0, and four identifiers deliberately did not follow the
package name: the storage domain `team_roster`, the patch row id `team-roster`, the data directory
`~/.dsh/team-roster` and the environment variable `DSH_TEAM_ROSTER_DATA_DIR`
(`docs/adr/0014-plugin-name.md:35-50`). They are where stored records, recorded trash paths and profile
overrides already live, and there is no rename-with-migration primitive for any of them: renaming one
silently orphans a roster, hides the trash, or stops a profile's override from matching
(`docs/adr/0014-plugin-name.md:41-49`; revisit condition at `:96-98`). Any upstream change that renames a
phase, a stored key or a configuration row inherits the same rule.

## 5. What would let this workaround go

Short, and each item removes one part of section 3 rather than asking for this plugin's design:

- Accept an explicit member-retired transition, or a terminal phase the projection does not turn into a
  permanent failure, so a roster can shrink without living outside the Session log.
- Give `maxMembers` a list that shrinks, and give a name a generation or reuse concept.
- Provide a Session deletion API, or define that moving a Session out of the store is supported; the
  plugin's trash move is standing in for that contract today
  (`docs/adr/0011-trash-retention.md:18-26`).
- Emit a member-state or completion event that distinguishes "never started" from "finished"; today the
  sweep needs the plugin's own `startedAt` because `inactive` covers both
  (`docs/member-lifecycle-en.md` §2).
- Document the upgrade rule for stored identifiers the way ADR 0014 does, so a rename has a migration
  path instead of a frozen name.
