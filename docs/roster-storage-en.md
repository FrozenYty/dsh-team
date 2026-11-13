# Roster storage

> Owner: @FrozenYty · Revisit when: the record shape, a load rule, or the retention cap changes

The durable shape this plugin owns: one roster record per Lead Session, the fields it carries and
what a load refuses, the fields that have rules of their own, and the retention cap that bounds this
Lead's trash. The phases those records move through are `docs/member-lifecycle-en.md` §1; the tasks
they carry are `docs/task-board-en.md`.
Decisions: ADR 0003, ADR 0010, ADR 0011, ADR 0012, ADR 0014.

## 1. The roster record

One roster record per Lead Session holds that team's member records; the table is keyed by the Lead
Session id (ADR 0003).

```
memberId      stable identity: generated here for a member this plugin spawned, the child
              Session id for an adopted child
name          model-facing name, unique among current members
generation    1 for the first holder of a name, 2 for its successor, ...
childId       the subagent Session id, assigned with the reservation
phase         provisioning | active | retired | failed
label         the responsibility text shown to the model
assignment    what the member is doing, set by the model; at most 1000 characters (member-lifecycle §3)
createdAt     ISO timestamp
predecessor   memberId this member replaced, present only on a successor started with `replace`
adopted       true when the record was adopted from another roster instead of spawned here
note          the start error, present only on a record whose spawn failed
retiredAt     ISO timestamp, present only on a tombstone
retireReason  the reason the model gave for the retirement, when it gave one
trashDir      the name retirement gave the trash directory, on a tombstone; the part that survives the root moving
trashRelPath  where that directory sits under the data root, on a tombstone; the absolute path is read-time
trashPath     the absolute path a move used, present only on a tombstone written before v0.26.0
originalPath  where that artifact came from, so restore is a move and not a guess
trashKind     what was moved: `directory` for the Session directory, `file` for a single artifact
trashState    `pending` while the move is in flight, `done` once it landed, `none` when there was none,
              `pruned` when the move landed and the retention cap later removed the artifact (member-lifecycle §4)
archived      true when no artifact could be moved and the workspace archive hid the Session instead
ephemeral     true when the member is a one-shot: the durable spelling of a lifetime declared on the
              spawn call, and the only field either lifetime writes (member-lifecycle §2, ADR 0026). Optional, absent
              on a standing member, so a record for one is unchanged. A message does not clear it
startedAt     ISO timestamp on a one-shot member: when its child was started. This is the positive
              evidence the lazy sweep requires, so a reservation that never published is never swept.
              A message deletes it and a later read that observes the child resident writes it again,
              which is what keeps the evidence "an observation made after the last hand-off of work"
messageCount  how many messages this member was sent after the spawn, written for **every** member (v0.25.1;
              a one-shot member only before that). Its two readers differ: `list_members` advises on it for
              a one-shot member — two or more is a member that is probably a standing role — and the
              retirement gate reads it for any standing member, where two or more means the member was
              re-tasked and is therefore not bare residue (ADR 0026). Optional
assignmentCount  how many assignment changes were written for this member after the spawn, counted rather
              than inferred because `assignment` keeps only the last value. Written and read for the same
              two purposes as `messageCount`. Optional
route         the provider and model the member was started on, and where that route came from:
              `{ source, provider?, model?, select_reason? }`. `source` is `caller` (the spawn call or its
              definition named the route), `plugin` (the plugin resolved and forwarded the Lead's current
              route) or `inherited` (nothing was forwarded, with `select_reason` naming which fallback ran:
              `no-session-route` or `capability-absent`). Written once with the reservation and never
              rewritten — it is a fact about the start, and `started_with` is the receipt for the request.
              Optional, so every record written before v0.22.0 loads and behaves exactly as it did (architecture §2.5,
              ADR 0024)
handoffTemplate  on the roster record, not on a member: this Lead's stored handoff-brief template,
              whose placeholders a replacement interpolates (member-lifecycle §3). It is the *second* source: a
              `team/team.md` in the Lead's project wins while it exists (handoff §2). Optional, so every
              record written before P4-02 loads and behaves exactly as it did
tasks         on the roster record, not on a member: this Lead's work board, an array of task rows. Each
              row is `{ id, title, body?, status, owner?, created_at, updated_at? }`: `id` is a UUID
              generated when the task is created, `title` is bounded display text (`TASK_TITLE_MAX`, 200),
              `body` is the task's own statement of what "done" means and where the work stopped
              (`TASK_BODY_MAX`, 2000, present only on a row that has one, cleared with `body: null`),
              `status` is `open | done`, `owner` is the target of the member carrying the work,
              `created_at` is an ISO timestamp and `updated_at` appears after the first change. Optional,
              so every record written before P2-09 loads and behaves exactly as it did, and a Lead with an
              empty board is a record that never gained the field (ADR 0017, ADR 0020)
```

`trashState` is validated on load, like `phase`: an unknown value is refused rather than guessed at.
`pruned` keeps `trashDir` and `trashKind` and `originalPath` — the tombstone still says which directory
went and where the artifact came from, and a record written before v0.26.0 keeps its absolute `trashPath`
instead — and is the only value that makes `restore_member` a typed refusal without a move (ADR 0028).

There is no other field, and in particular no `dormant` phase (`docs/member-lifecycle-en.md` §1) and
no `briefPath`: the brief is composed at replacement time from `assignment` and from the effective
template — the `team/team.md` file, the stored `handoffTemplate`, or the built-in shape, in that
order (`docs/member-lifecycle-en.md` §3, `docs/handoff-en.md` §2). The `ephemeral` and `startedAt`
fields are the P4-01 pair and `messageCount`/`assignmentCount` are the v0.25 pair, and all four are
optional: a record written by any earlier release loads and behaves exactly as it did. The stored
field is not renamed by v0.25 — `ephemeral` is what every roster already carries — so `lifetime`
exists in the call and on a row, and `lifetimeOf` is the one translation between the two (ADR 0026).

## 2. `assignment` and `name`: the two fields with rules

`assignment` is the durable statement a successor is briefed with. It is set with
`spawn_member.assignment`, replaced with `message_member.assignment`, reported on every `list_members`
row, and kept on the tombstone after retirement.

`name` is unique among **current** members. A successor reuses the name with `generation + 1`, which
the shipped roster cannot do because it treats a name as permanently taken. Every mutation is one atomic
`update` on the roster table, not a read followed by a `put`, and every operation re-reads the roster
before it decides: two tools called in the same model turn therefore see each other's write instead of
overwriting it (`docs/member-lifecycle-en.md` §1).

## 3. The trash and the retention cap

**Bound the trash, only here.** A retirement that moved an artifact in removes the entries past the
   **effective** cap from this Lead's trash directory, oldest first; the cap is the `trashLimit` config
   field `apply` resolved (default `DEFAULT_TRASH_LIMIT`, 20), not a constant in the code; each removed
   tombstone keeps the directory name it recorded — `trashDir`, or the absolute `trashPath` a record
   written before v0.26.0 carries — and becomes `trashState: 'pruned'` (ADR 0011, ADR 0012, ADR 0028).
   Only direct children whose name parses are candidates, and a tombstone is matched to one **by
   directory name**: that name is the part of a trash location which survives the data root moving, and
   the id inside it is the **child Session id**, not the record's `memberId`, which is why the flip
   compares the record's own id instead of parsing the name (ADR 0028). A `pending` move is counted
   against the cap but never pruned, and only this plugin's own trash copies are deleted — the platform
   has no Session-deletion API, and its only "hide it" mechanism is a reversible archive that cannot
   bound bytes. A retirement that moved nothing prunes nothing. No timer and no read-time sweep exists.

**Restore never trusts a recorded absolute path.** An artifact is looked for on three legs in order: the
   data root in effect (the recorded relative path, or the layout rebuilt from the directory name), the
   absolute path the record itself carries, and the frozen `~/.dsh/team-roster`. Duplicates are dropped,
   so the ordinary case is one candidate per leg, and a tombstone written by any earlier release restores
   with no migration at all (ADR 0028).

## 4. Where the file lives, and who may write it

**One file per workspace.** The record is this plugin's own `roster.json` under `.agents/team/` in the
Lead's workspace, beside the memory notebook, and the trash sits under the same root; a profile that sets
`DSH_TEAM_DATA_DIR`, or the frozen `DSH_TEAM_ROSTER_DATA_DIR`, uses that directory instead (ADR 0014). A
Lead binds to its root the first time it uses it and the binding lives in the running process, so a
`working_directory` call later in the same session cannot move the root and orphan what it already wrote. A
Session whose workspace cannot be resolved keeps using the storage domain instead, and `list_members` says
so in `storage`. The domain is never written once a file exists and is never deleted: it is the one-time
import source, and deleting `roster.json` is the rollback. Records are replaced by a temporary file plus a
rename, so a crash leaves either the whole previous file or the whole new one; a file that cannot be read,
or that holds one record the loader refuses, falls back to the domain rather than throwing.

**One writer per workspace.** Two Lead Sessions in one workspace share that file by design, and nothing
serializes them — a lock file would add a stale-lock failure mode that nothing cleans up. Every write
re-reads the file first, so a concurrent change is merged rather than clobbered, and a serial this process
did not write is reported as `foreign_write_at` in `list_members`. Detection follows this process's next
read or write, not the instant the second writer writes.
