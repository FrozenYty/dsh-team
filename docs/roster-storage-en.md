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
trashRelPath  where that directory sits under the data root, on a tombstone; written with forward slashes and
              read on either separator; the absolute path is read-time
trashPath     the absolute path a move used, present only on a tombstone written before v0.26.0
originalRelPath  where that artifact came from, relative to the sessions root: `<slug>/<leaf>` with forward
              slashes, absent when the artifact was not in a directory named after the member (ADR 0034)
originalPath  the absolute origin a record written **before** v0.34.0 carries; read as a legacy leg, never
              written any more, so restore is a move and not a guess
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

One field belongs to the roster rather than to a member: `retiredChildIds` lists every retired child
Session id this Lead has ever had, the archived ones included, and it is rewritten on every write so a
restored member leaves it. The host hooks strip the shipped panels **by child id**, so this list — not the
tombstone — is what keeps a retired member out of them (ADR 0030).

`trashState` is validated on load, like `phase`: an unknown value is refused rather than guessed at.
`pruned` keeps `trashDir` and `trashKind` and the origin it recorded — `originalRelPath`, or the absolute
`originalPath` a pre-v0.34.0 record carries — so the tombstone still says which directory
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

**Strict on write, tolerant on read.** A recorded relative path is written with forward slashes and read by
   splitting on **either** separator, because a roster is a file that travels and the machine reading it may
   not be the one that wrote it: a record carrying the writing machine's separator read with `join` once put
   the artifact under `<root>/trash\lead\dir`, a path that does not exist. The tolerance is constructive
   rather than hopeful — **no legal segment of that field can contain a backslash**, since both the Lead and
   the child Session id are encoded identities, so splitting on both cannot split a segment in half.
   `scripts/migrate-roster.mjs` compares the same field by **segment** for the same reason, and that fixed a
   real bug: comparing it by characters reported every already-migrated record on Windows as pending, so it
   rewrote them all (ADR 0028, ADR 0034).

**A tombstone leaves once its artifact could not exist.** Past the newest `trashLimit` tombstones the cap
   has already removed the bytes, so a restore there could only answer `pruned`; those records move to
   `archive.jsonl` — append-only, one JSON object per line, never read on the hot path — and only when the
   record names a trash destination, its move is not `pending`, and its artifact is on **no** leg of the
   chain described above. The window is derived from the effective cap, so it cannot drift from the cap,
   and the bound runs on **every write for that Lead** rather than on one operation: records already past
   it flush on the next write, with no migration script, and a read never flushes. Records with no
   destination, records whose bytes are still on disk, and the storage-domain mode are deliberately not
   bounded, and neither is the archive itself (ADR 0030). A restore of an archived tombstone answers
   `reason: 'archived'` naming the file, and `list_members` reports `archived_records` with `archive_file`
   when that count is non-zero. **A read happens only when the caller asks for it** (`archived: true`): it
   answers one Lead, returns at most the newest **50** records with `archived_returned` and the real
   `archived_total` beside them, dedupes by member id because the append-before-replace crash window leaves
   duplicates by design, and counts a damaged line as `archived_unreadable` instead of raising. A plain read
   still never opens the file, which is the rule ADR 0030 set and ADR 0035 keeps (ADR 0035).

## 4. Where the file lives, and who may write it

**Every Session has a root, and the state is files only.** The root is chosen in this order: the
`DSH_TEAM_DATA_DIR` override (or the frozen `DSH_TEAM_ROSTER_DATA_DIR`), then `.agents/team/` in the
Lead's workspace, then the frozen `<home>/.dsh/team-roster`. A Lead binds to its root the first time it
uses it and the binding lives in the running process, so a `working_directory` call later in the same
session cannot move the root and orphan what it already wrote. A write with no bound root **throws naming
that invariant**: every Session is bound, so it is a caller that never bound the Lead rather than a reason
to fall through to the storage domain. The record is this plugin's own `roster.json` under that root, with
its import marker, `provenance.json` and `archive.jsonl` beside it, and the trash under the same root.
A new root with no `roster.json` reads its records **once** from `DSH_TEAM_SEED`, a file the person names,
which accepts this plugin's own shape or a storage-domain dump and is never written; a seed that is
configured and unusable is a **problem, not a fallback** — the root stays empty and `list_members` says why
(ADR 0031). The storage domain **answers no read and is not opened at all**: the import order is
`seed → nothing`, and a root with no file starts empty or from a seed (ADR 0033). `provenance.json` still
records a domain-era `source` as a **value** — nothing writes it and nothing branches on it, so a reader of
an older file is not told its history is impossible. A path whose ancestor is a file counts as **no file**
(`ENOENT` or `ENOTDIR`), because the platforms disagree there and that boolean decides whether a root is
seeded at all (ADR 0033). Records are replaced
by a temporary file plus a rename, so a crash leaves either the whole previous file or the whole new one.
`storage.source` is `'file'`, or `'none'` for a Lead this process has never bound — a file that cannot be
read is reported as `source: 'file'` with a `read_problem`, never as a fallback to the domain.

**One writer per workspace.** Two Lead Sessions in one workspace share that file by design, and nothing
serializes them — a lock file would add a stale-lock failure mode that nothing cleans up. Every write
re-reads the file first, so a concurrent change is merged rather than clobbered, and a serial this process
did not write is reported as `foreign_write_at` in `list_members`. Detection follows this process's next
read or write, not the instant the second writer writes.
