# Architecture

> Owner: @FrozenYty · Revisit when: a Harness upgrade changes a Service this plugin uses

This document describes what the plugin is, what it does today, and the roster design being built.
The decisions behind the design live in `docs/adr/`; this file describes the result.

## 1. What the plugin is

A DeepSeek Harness **profile bundle**. Installing it does three things:

1. selects a shipped plugin row that the profile leaves disabled (`compaction-basic`);
2. inserts one Host plugin of our own (`dsh-team`);
3. disables the shipped model-facing team tool row (`tool-agent-team`), whose tools this plugin replaces
   (P2-07, §2.3, §4.5).

There is no build step and no runtime dependency: the installed Harness resolves the shipped row from
its own installation, and our entry imports nothing (ADR 0002). The bundle is Host-only: it has no
browser half (ADR 0008).

The shipped team *service* row (`agent-team`) is deliberately not touched: adoption (§4.5.1) and the
projection filter (§2.4) read it.

The plugin was renamed from `dsh-team-roster` in v0.10.0 while its storage domain (`team_roster`), its
patch row id (`team-roster`) and its trash directory (`~/.dsh/team-roster`) kept the old spelling on
purpose (ADR 0014).

Its one tunable is the per-Lead session-trash cap, carried by the `trashLimit` field of the bundle's own
patch row (`- id: team-roster`, `config: { trashLimit: <integer> }`). `apply(ctx, config)` resolves it
before it registers anything: an absent field takes `DEFAULT_TRASH_LIMIT` (20), an integer of at least 1
is used as-is, and anything else fails the load with the field, the value and the minimum in the message
(ADR 0012). The entry deliberately declares no `Config` schema, so the Host Config provider still reports
it `absent`: that projection accepts only a native Schemastery graph, which a zero-import bundle cannot
provide, and the field is validated in `apply` instead.

## 2. What shipped, and when

A short map, not a changelog: each release below names what it added and the section that owns it today.

- **v0.1** — the compaction backend enabled profile-wide (§2.1) and the context tools (§2.2).
- **v0.2** — the owned roster: spawn, message, stop, retire and restore (§4.5), the retirement protocol
  and its handoff (§4.4), the trash move (§2.5), and the two optional host-side effects a retirement
  refreshes (§2.4).
- **v0.4** — the model-only surface (ADR 0008): the Settings panel and its HTTP bridge were deleted, and
  adoption grew to cover every descendant a Lead controls (§4.5.1).
- **v0.7–v0.8** — the trash is bounded per Lead, and the bound is the bundle's `trashLimit` config field
  (§2.5, ADR 0011, ADR 0012).
- **v0.9** — ephemeral members: a member can be marked one-shot at spawn, and a lazy sweep in the roster
  operations the model calls anyway retires it once it has run and stopped (§4.3.1, ADR 0013).
- **v0.10** — the rename: the package, the patch row's `name` and the display title became
  `dsh-team` / *Team*, while the storage domain, the patch row id and the trash directory kept
  their pre-rename names (§1, ADR 0014).
- **v0.11** — a stored, reusable handoff-brief template per Lead, set through one tool, which the
  replacement handoff composes the successor's brief from (§4.4, §4.5, ADR 0015).
- **v0.12** — a member can start with its own working directory, model route or agent preset, a start
  the Harness refuses is a typed result, and a refusal for a stale target names the live holder of its
  name (§4.1, §4.3, §4.4, §4.5, ADR 0016).
- **v0.13** — the plugin owns the work, not only the member: a task board on the Lead's roster record,
  a replacement that hands the predecessor's open tasks to the successor, and a retirement without a
  successor that leaves them unowned and names them (§4.2, §4.3.2, §4.4, §4.5, ADR 0017).
- **v0.14** — the shipped team tool row is retired: the bundle patch disables `tool-agent-team`, so the
  row's `spawn_teammate`, `wait_agent` and `team_task_*` tools stop being registered and this plugin's own
  tools serve the Lead. Three model-facing tools the kept `agent-team` service publishes — `list_agents`,
  `send_message`, `interrupt_agent` — remain (§1, §2.3, §4.5, §6).
- **v0.15** — the blocking wait returns on this plugin's own surface: `wait_members` observes the Harness's
  `agent/status` for the child Sessions on this Lead's roster, which the disabled row's `wait_agent` used to
  cover and the shipped service cannot see (§4.5).
- **v0.16** — a member can be defined on disk: `spawn_member.definition` reads a flat-frontmatter markdown
  file under `team/` in the Lead's working directory, the call's own arguments win over the file's, and the
  result reports which parts came from where (§4.5, §4.6, ADR 0018).
- **v0.19** — the team scope gets the other half of that split: one optional `team/team.md` beside the
  member definitions, whose body is the handoff-brief template. The effective template is the file, then
  the stored template, then the built-in; the read form reports which source is in effect, and a
  `handoff_template` write or clear is refused while the file exists (§4.4, §4.5, §4.7, ADR 0021).
- **v0.20** — the member scope gets the read a task's body was for: `list_my_tasks`, a read-only tool
  registered on a member Agent, returns only the rows whose `owner` is that member's own target. The
  Lead's tool set is unchanged, the board keeps one writer, and the brief's `{task_board}` pointer names
  this plugin's board and this tool instead of the shipped board (§4.4, §4.5, §4.5.2, ADR 0022).

### 2.1 Compaction is enabled

The profile ships `compaction-basic` as `inactive`. Nothing condenses, so every agent — the Lead and
every teammate — grows toward the model window unchecked. The bundle overrides the row to
`disabled: false`. The backend registers unscoped `agent/pre-step`, `agent/request` and
`agent/request-error` listeners, so every Agent in the process is covered, including subagents.

Defaults on the DeepSeek route used here (window 1,048,576, output reservation 256,000, headroom
65,536): automatic compaction triggers at `floor(min(window x 0.8, window - output - headroom))` =
727,040 tokens, retaining the newest 16% of `window - output` verbatim. Tuning is a config override on
the same row in a higher patch layer.

`command-compact` (`/compact`) is deliberately **not** enabled: it requires the `commands` service,
which this profile also leaves unmounted, so the row stays `absent` even when enabled.

### 2.2 Context tools

v0.1 shipped the context tools; §4.5 owns their current rows. Every Lead-scoped tool registers on the
exact Agent context of a Team Lead (`agent/created`), and unwinds on `agent/disposed`. No official tool
name is shadowed and no session event is written.

`member_context` existed in v0.1 and was removed: its rows duplicated `list_members`, and it read the
shipped roster rather than this plugin's.

Measured limitation that shapes the design: a local child is unloaded when it goes idle, and
`compactNow()` requires a resident idle Agent. A finished teammate therefore cannot be compacted on
demand; waking it with a message and letting automatic compaction run at its next step is the durable
path.

### 2.3 Own roster tools

v0.2 shipped the owned roster and its tools. §4.5 owns the tool surface, §4.4 the retirement protocol,
§4.5.1 adoption, and §4.2 the record those tools read and write.

Adoption (§4.5.1) is what makes `retire_member`, `message_member` and `stop_member` apply to children
this plugin never spawned — exactly the population that was invisible before. A one-shot child is
adopted like any other and can be stopped or retired; it cannot be cold-resumed, so `message_member`
reaches it only while it is resident.

Records live in one `storageDomain` domain keyed by the Lead Session id (ADR 0003). Naming rule:
generation 1 is the bare base name; generation 2 and later is `<base>-g<N>`, so a replacement never
collides with a retired name. Spawning the same base name after a retirement is the replace operation:
`probe-a` retired, `probe-a-g2` started, both recorded.

The shipped team roster and this roster no longer present two sets of spawn, wait and task tools: since
v0.14.0 the patch disables the shipped `tool-agent-team` row (P2-07), so `spawn_teammate`, `wait_agent` and
the `team_task_*` tools are absent from a Lead's tool list, and `list_members` is the only list. The
shipped roster's *service* is still mounted, which is why `list_members` still reports the members it
created — as well as every adopted descendant and every member this plugin spawned — and why the three
model-facing tools that service publishes, `list_agents`, `send_message` and `interrupt_agent`, are still
in that list: disabling the service row would take adoption, the membership test and the projection filter
with it.

The **work** never coexisted: since v0.13.0 the tasks a replacement hands over are rows on this Lead's own
board (`task_board`), stored beside the roster record, and the plugin's handover no longer reads or points
at the shipped board (§4.3.2). The shipped board's existing rows are not migrated and not readable by this
plugin — and since v0.14.0 the tools that could reach them are gone, so a Lead that wants them back
re-creates them on the owned board (ADR 0017).

### 2.4 Host-side effects

Two effects make a retirement visible to clients, make this plugin's members visible in the shipped team
panel, and keep the shipped member budget usable. Both are capability-probed, both restore exactly what
they replaced on plugin unload, and neither writes to the Lead Session (ADR 0004, ADR 0023).

| Effect | Mechanism | Behaviour when the host shape is absent |
|---|---|---|
| Projection filter | wraps `sessionController.list` / `projections` / `control` / `follow`; strips retired ids from `subagentCatalog` and `agentTeam` frames, then appends this Lead's live members to the same `agentTeam` value | retirement still works; clients keep rendering the member and never see this plugin's |
| Slot credit | replaces the legacy roster's `maxMembers` getter and wraps `spawn`, adding the retired count of the spawning Lead for the duration of that spawn | retirement still works; the shipped budget stays consumed |

Both read retired records through a two-second cache that `retire_member` invalidates, and both are
transparent to other plugins: same arguments, same return shape, and the payload is mutated rather than
copied so a caller's reference stays valid. The overlay's live rows are read synchronously from the
roster table, because they change with a spawn and a cache would only add a stale window.

#### 2.4.1 The panel overlay: what a plugin may write, and what the panel reads

The built-in team panel — **成员** (members) and **共享任务** (tasks) in the Chinese locale — renders
`projectionsBySession[lead].values.agentTeam`, the wire view of the Lead Session's team fold. That fold
hears only the `team/member` and `team/task` events the shipped roster appends, so a member started
through `ctx.subagents` was invisible there. The projection filter therefore does a second thing at the
same four exits: it appends this Lead's live members to the outgoing copy, and synthesises only the
fields the strict wire schema requires.

| Written by the overlay | Read by the panel as | Source |
|---|---|---|
| `id` | the row key and the member's Session identity: model lookup, running state, and the click that opens its chat | the `childId` on the roster record |
| `name` | the row label | the model-facing target (`reviewer`, `reviewer-g2`) |
| `role: 'teammate'` | nothing directly; the strict wire schema requires it | synthesised |
| `phase: 'active'` | 运行中 (running) when that Session is running, otherwise 未运行 (not running) | the record is `active` and has a child id |

**What a plugin may write where** is the point of the table. It may write only the **outgoing copy**: the
value each publish point validates with `wire.viewSchema.parse`, which builds new objects, so mutating it
cannot reach the projection's stored cell and cannot append a Session event. It may not write the log: a
member phase is closed at `provisioning | active | failed`, a transition out of a terminal phase throws,
and the projection stores that throw as a permanent `failure` (§3, ADR 0001). A retired member is not
written at all — the row leaves the value, and the panel draws one row fewer — because the wire enum has
no honest spelling for "retired" (ADR 0023). An id the value already carries is left exactly as it is, so
the overlay never duplicates, renames or re-roles a row.

The shared-task half of the panel is **not** overlaid. A task view needs ten fields this board does not
have (`revision`, `blockedBy`, `writeScopes`, `ownerName`, `ready`, `writeScopeWarnings`, …), while a
member row needs four; that is the next step, not this one (ADR 0023).

### 2.5 Retirement moves the artifact

`retire_member` tombstones the record *before* it touches the filesystem, carrying the trash path the
move is about to use and a `trashState: 'pending'` marker, then moves the persisted Session into
`~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/` and confirms the record with
`trashState: 'done'`; §4.4 owns those steps. The order is deliberate: a crash between the two leaves a
`retired` row beside an artifact that is either still in place or already in the trash — recoverable in
both cases, because `pending` says the move may or may not have happened and restore looks in the trash
first. The reverse order would leave a trashed session behind an `active` record, which no later read
could explain.

The move is what removes the member from the host's own discovery, since session-query drops an artifact
that no longer exists, and it deletes nothing: the cross-device fallback is the only branch there that
removes the source, and when no artifact can be moved the workspace archive hides the Session
(`archived: true`, `trashState: 'none'`, and the intended trash fields are dropped). Restoration is the
inverse and equally explicit: the record keeps the original path and the artifact kind (`trashKind` — the
Session directory or a single artifact file), so `restore_member` is a move rather than a guess; §4.5
owns the result branches and the refusals.

A retirement that actually moved an artifact in also enforces the per-Lead cap in the same call (§4.4
step 5, ADR 0011, ADR 0012): the move is the one moment the trash grows, so nothing is swept on a timer
and nothing is swept on a read.

## 3. Why the shipped roster is not extended

The shipped roster is a fold over the Lead Session's append-only event log. Member phases are
`provisioning | active | failed`; the projection rejects any transition out of a terminal phase, and a
rejected event is recorded as a permanent `failure` that disables the Team service for that Lead. A
synthetic “retired” record therefore does not fail safely. `maxMembers` is checked against a list that
never shrinks, names are never reused, and upstream's redesign still defers deletion.

The full argument, with the alternative we rejected, is ADR 0001.

## 4. v0.2, in progress: an owned roster

### 4.1 Substrate

Members are ordinary subagents created through `ctx.subagents.startActivation(...)`, which already
provides continuable children, inbox messaging, interruption, draining, cold resume and a live capacity
limit. The plugin owns only what the Harness does not: the roster, its lifecycle, and the model-facing
tools that follow from it.

The installed seam is `dsh-subagent` **0.2.2-rc.1**, and it is not the generation in the public source
tree. Its activation request is:

```
{ provider, label, request: { prompt, parent, cwd?, agentPreset?, agentOptions?, outputSchema?, maxDepth? },
  signal, delivery, childId? }
```

There is no `name` field, and no `resolveName`/`namesOf`. Names are therefore ours: the plugin generates
a UUID `childId`, passes it to `startActivation`, and keeps the name→childId mapping in its roster — the
same arrangement the shipped team uses. Capacity is `maxActiveSubagents` (default 8), counted per
subagent tree and process-local; draining a child releases its slot.

**Request composition.** The plugin sends `{ prompt, parent }` plus the optional fields the model named
through `spawn_member.spawn_options` (§4.5): `cwd`, `agentOptions` and `agentPreset`. Every field omitted
means the member inherits the Lead's value, and one exception is recorded here because the rule reads as
total without it: a changed `provider` or `model` without `reasoningEffort` lets the new route resolve its
own default rather than inheriting the Lead's effort. A spawn that names none composes exactly the request
it always did — a test pins the exact object. `cwd` is forwarded verbatim: the seam resolves a relative
path against the parent's cwd (`resolveDirectory`), and a child keeps the parent's permission roots, so a
directory outside the sandbox grant stays denied; a plugin that pre-resolved the path would disagree with
the Host. The two capability gates belong to the provider: `agentOptions` requires
`provider.capabilities.agentOptions` and `agentPreset` requires `provider.capabilities.agentPreset` —
true for the in-process spawn/fork providers and false for every external backend, whose advertisement is
`NO_START_CAPABILITIES` — and both are asserted before the manager reserves anything. Three facts about
the Harness shape this surface and are recorded because a reader will not expect them: there is **no
per-call tool allow/deny**, so `agentPreset` is the only route to a tool-restricted or read-only member
and the seam rejects `toolFilter` outright; **a preset id must be declared by the profile's bundle
patches**, because the registry neither scans directories nor accepts a path; and **there is no worktree
field**, so a worktree is `ctx.worktrees.create(...)` followed by forwarding its `path` as `cwd`, with
that service optional and experimental enough that this plugin does not create one itself (ADR 0016).

Two Harness facts shape retirement:

- `drainChildren(parent, [childId])` stops one child, releases its slot and residency, but the child's
  Session and the parent's `subagent/catalog` entry survive. A drained child stays in the shipped
  roster's own listing forever, which is why our own list tool exists.
- `ctx.workspaceRegistry.archiveSession` hides a Session from every workspace surface. It is reversible
  and deletes nothing, which makes it the fallback for a retired member whose artifact could not be
  moved.

### 4.2 Roster record

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
assignment    what the member is doing, set by the model; at most 1000 characters (§4.4)
createdAt     ISO timestamp
predecessor   memberId this member replaced, present only on a successor started with `replace`
adopted       true when the record was adopted from another roster instead of spawned here
note          the start error, present only on a record whose spawn failed
retiredAt     ISO timestamp, present only on a tombstone
retireReason  the reason the model gave for the retirement, when it gave one
trashPath     the trash directory the Session artifact was moved to, on a tombstone
originalPath  where that artifact came from, so restore is a move and not a guess
trashKind     what was moved: `directory` for the Session directory, `file` for a single artifact
trashState    `pending` while the move is in flight, `done` once it landed, `none` when there was none,
              `pruned` when the move landed and the retention cap later removed the artifact (§2.5)
archived      true when no artifact could be moved and the workspace archive hid the Session instead
ephemeral     true when the member retires itself once its work is over, set by spawn_member and cleared
              by message_member (§4.3.1); optional, absent otherwise, so a non-ephemeral record is unchanged
startedAt     ISO timestamp on an ephemeral member: when its child was started. This is the positive
              evidence the lazy sweep requires, so a reservation that never published is never swept
handoffTemplate  on the roster record, not on a member: this Lead's stored handoff-brief template,
              whose placeholders a replacement interpolates (§4.4). It is the *second* source: a
              `team/team.md` in the Lead's project wins while it exists (§4.7). Optional, so every
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
`pruned` keeps `trashPath`, `trashKind` and `originalPath` — the tombstone still says where
the artifact went — and is the only value that makes `restore_member` a typed refusal without a move.

There is no other field, and in particular no `dormant` phase (§4.3) and no `briefPath`: the brief is
composed at replacement time from `assignment` and from the effective template — the `team/team.md` file,
the stored `handoffTemplate`, or the built-in shape, in that order (§4.4, §4.7). The `ephemeral` and
`startedAt` fields are the P4-01 pair, and both are optional: a record written by any earlier release
loads and behaves exactly as it did.

`handoffTemplate` is the one field on this record that describes the Lead rather than a member. Its
**type** is validated when the record loads; its **content** — the placeholder vocabulary, the required
`{assignment}` reference and the length cap — is checked when it is stored and re-reported by the read
form (§4.5). That split is deliberate: the storage facility validates every record of every Lead when it
opens the domain, so refusing a whole roster over one Lead's brief preference would hide every team. A
stored template that no longer passes validation is reported, never silently dropped, and the
composition falls back to the built-in brief instead of writing the offending token into a child. Since
v0.19.0 the file's body goes through the same content check where it is parsed, and a file that fails it
does not become the effective template (§4.7).

`tasks` follows the same split for the same reason, and goes one step further. Its **structure** is
validated on load — an array, every row an object with an `id` string, a known `status`, a non-empty
`owner` when present, and no id twice — because a roster that cannot represent a task cannot answer for
one. Its **content** is not: a title or a body that is merely too long, or a list that grew past the
write-time cap before this release existed, loads and is reported by the read (`problem` on the row, §4.5)
rather than refusing the domain. That is the `handoffTemplate` precedent applied where it matters most: one
Lead's stale task would otherwise hide every roster in the profile, including the retirement that exists to
repair that team. The three write-time caps are refused, never truncated: `TASK_TITLE_MAX` (200),
`TASK_BODY_MAX` (2000) and `TASK_LIMIT` (200 tasks per Lead, `done` included).

**A board write is built from the row as stored, inside the serialized mutation.** The read a `task_board`
call makes at its start states the *premise*, and is never a row to write back: the mutation looks the task
up again in the record `updateRoster` hands it and builds the next row from that. `update` therefore
applies only the fields the call named — a status change keeps the owner a handover gave the row, and a
body amendment keeps everything else — while `release` and `delete`, whose effect is subtraction, apply
only to the state the call read: when the stored row's `status`/`owner` is no longer the one in the
snapshot, they write nothing and answer `changed: false` with the row they found. A row that vanished
between the read and the write draws the same refusal an unknown id draws. That is what makes "only the
person changes, not the work" hold under concurrency and not only in sequence: a replacement's handover
cannot be undone by the next board call, and the model is asked to track no revision and no schema gains a
parameter (ADR 0017 point 5, ADR 0020).

`assignment` is the durable statement a successor is briefed with. It is set with
`spawn_member.assignment`, replaced with `message_member.assignment`, reported on every `list_members`
row, and kept on the tombstone after retirement.

`name` is unique among **current** members. A successor reuses the name with `generation + 1`, which
the shipped roster cannot do because it treats a name as permanently taken. Every mutation is one atomic
`update` on the roster table, not a read followed by a `put`, and every operation re-reads the roster
before it decides: two tools called in the same model turn therefore see each other's write instead of
overwriting it (§4.3).

### 4.3 State matrix

Every cell is decided before implementation (AGENTS.md §4.8). The four phases are the ones `PHASE` holds.
**refusal** marks a deliberate rejection: the call reports why instead of acting, and it is neither a crash
nor an omission. "Same base" means spawning the name whose earlier holder is in that phase.

| Phase \ Event | adopt | spawn (same base) | replace | message | stop | compact | retire | restore | sweep |
|---|---|---|---|---|---|---|---|---|---|
| `provisioning` | not produced by adoption — an adopted record starts `active` or `failed` | reserves the next generation; this row is untouched | successor starts, then this reservation is drained and tombstoned | delivered through `sendMessage`; a child that has not published yet is refused by the subagent service and the error is reported | no-op unless the child is already resident, then its turn is cancelled | refusal `not-resident` until it is resident and idle | drain, then tombstone; the artifact usually cannot be moved yet, so `trashed: false` and the archive branch decides | refusal `not-retired` — only `active` is the no-op success (`restored: true, reason: 'already-active'`) | no-op — nothing has run, so there is no evidence to sweep on; only the read-time reconciliation can move this row, and it moves it to `failed` |
| `active` | no-op — identity is the child id, so a known child is never adopted twice | reserves the next generation; this row is untouched | successor starts from the brief, then this member is drained and tombstoned | delivered; a running child sees it at its next step, an unloaded one is cold-resumed | current turn cancelled; activation, inbox and record kept | compacts in place when resident and idle; refusal `busy` while running, `not-resident` when unloaded | drain, tombstone (`pending`), move and confirm, refresh the host effects | no-op success: `restored: true, reason: 'already-active'` | the one phase a sweep acts on: an ephemeral member with `startedAt` whose child is no longer resident is retired through the normal path, and a running or resident member — or any non-ephemeral member — is left exactly as it is (§4.3.1) |
| `retired` | no-op — the tombstone holds the child id, which is what stops re-adoption | allowed: a new generation of the base starts with no replacement link (§2.3) | successor starts from the tombstone's brief; the retire half is a no-op (`reason: 'already-retired'`) | refusal `retired` | refusal `retired` | refusal — only `provisioning` and `active` are addressable | repeat: no-op success, `retired: true, drained: false, reason: 'already-retired'` | moves the artifact back, or runs the workspace unhide branch; `reason` names which one ran. A `trashState: 'pruned'` tombstone instead refuses with `restored: false, reason: 'pruned'` and never calls the workspace | no-op — the tombstone is already the result the sweep exists to produce |
| `failed` | no-op — known child id | reserves the next generation; this row is untouched | successor starts, then this record is tombstoned | refusal `failed` — the child never started, so there is nothing to receive it | refusal `failed` | refusal — only `provisioning` and `active` are addressable | accepted and tombstoned; there is usually nothing to drain or move | refusal `not-retired` — only `active` is the no-op success (`restored: true, reason: 'already-active'`) | no-op — it never ran, and the record stays visible and retirable |

Harness notices are the events no plugin operation can prevent:

| Phase \ Notice | the child finishes its turn | the child's turn fails | the host drains or unloads the child | the persisted Session disappears |
|---|---|---|---|---|
| `provisioning` | not applicable — the reservation precedes any turn | `failed`, with the start error in `note`; this is the only failure the plugin records | nothing observed; the reservation stands until the start resolves | retirement reports `trashed: false` with the reason, then the archive branch hides the Session |
| `active` | no durable change on its own — no completion notice is observed; the phase stays `active` and live state reports `unloaded`. An ephemeral member is retired by the next lazy sweep, which is the only thing that turns this notice into a durable change (§4.3.1) | no durable change — a failure after the start is invisible here, so the record stays `active` | phase unchanged, live state `unloaded`; still messageable (cold-resumed) and retirable | retirement reports `trashed: false` and falls back to the archive; restore reports the reason and leaves the record retired |
| `retired` | ignored — there is no live child | ignored | ignored | restore refuses and the record stays retired |
| `failed` | ignored | ignored | ignored | ignored |

What the cells depend on:

- **`dormant` does not exist, and P4-01 did not add one.** The four phases above are exactly `PHASE` in
  `roster.js`; live state (`running`, `idle`, `unloaded`) is read from the Harness at call time and never
  stored. Ephemeral members do not need a stored "finished" state: the `ephemeral` flag rides on the
  record and a lazy sweep retires the member once positive evidence that it ran and stopped exists
  (§4.3.1). The completion hook this note used to expect does not exist in the Harness (ADR 0013).
- **`replace` is one model call composed of `spawn` and `retire`.** The successor starts first in every
  cell, so a start that fails leaves the row exactly as it was, and the retire half reports
  `predecessor_retired: false` when it fails.
- **A start the Harness refuses is the same failed start, answered as a typed result.** The capability
  gates are asserted before a child is reserved, so nothing is running: the reservation the plugin wrote
  first becomes a `failed` record, nothing is left `provisioning`, and `spawn_member` returns
  `started: false` with a `reason` the model can act on instead of a host error (ADR 0016). On the
  `replace` cells this is the ordering already written above: the predecessor is untouched and the
  answer says `predecessor_retired: false`.
- **`replace` with a stored or file template is the same cell.** The phases and the order of the two
  halves do not change: the successor starts from the brief, and the brief is rendered from the effective
  template — `team/team.md`, then the Lead's `handoffTemplate`, then the built-in shape (§4.4, §4.7).
  Two refusals are added and both happen before anything starts — a template is validated when it is set
  or parsed, and a rendered brief past its cap refuses the call — so the cells stay as written and the
  record is not touched. A `handoff_template` write or clear while the file exists is a refusal, not a
  phase transition: it changes no member row and no stored template (§4.7).
- **Two tools in one model turn.** Every call re-reads the roster and every mutation is one atomic
  `update` (§4.2), so the second call acts on the first one's result: `message_member` then
  `retire_member` in one turn delivers and then tombstones, the reverse order refuses with `retired`,
  and `retire_member` then `spawn_member` starts the next generation. Parallel tool calls are serialized
  by the storage table, not by the caller.
- **A retired or failed member is still a controllable record.** It is listed, retirable and
  replaceable: `retire_member` and `restore_member` look a target up in any phase. Only the operations
  that need a live child — `message_member` and `stop_member` — are narrow, and they refuse a retired or
  failed target with the typed reason `retired`, `failed` or `missing`.
- **A pruned tombstone is retired, not gone.** The retention cap (§2.5) removes the artifact, not the
  member's identity: the record stays listed and keeps its assignment and path, so `restore_member` can
  answer `pruned` from the record instead of failing on a missing directory. That cell is a refusal, and
  it leaves the phase `retired`.

Two cells are the expensive ones and are called out deliberately:

- **retire while provisioning** — the record becomes `retired` immediately, and the in-flight child is
  drained when it publishes. A member must never come back to life after retirement. `replace` on a
  provisioning member does the same to the predecessor, after the successor has started.
- **retire while active** — retirement wins over in-flight work. The record's `assignment` is the brief
  (§4.4); if the model never recorded one, the successor's prompt says so and sends it to the Lead's own
  task board instead of inventing a summary.

#### 4.3.2 The transfer matrix (P2-09)

The work a member carries is not only its `assignment`. It is the open tasks on this Lead's board that
name it as their owner (§4.2), and what happens to those rows at each event is decided here, before the
code (AGENTS.md §4.8). Three questions per cell, and all three have an answer:

- what happens to the member's **open** tasks;
- what the call **reports** about them;
- whether its **done** tasks move.

**No cell moves a `done` task.** Finished work belongs to the record that finished it, so a `done` row
keeps its owner through every event in the table, including the events that retire that owner. That is the
one rule the whole matrix rests on: a handover hands over *work still owed*, not a history.

| Event | The member's open tasks | Result fields | Done tasks |
|---|---|---|---|
| `spawn_member` with `replace` succeeds, and the predecessor retires | re-addressed to the successor before the tombstone is written: the same rows, a new `owner` | `transferred` (count) and `transferred_tasks` (ids); the retirement record contributes no second copy | stay with the predecessor's tombstone |
| `spawn_member` with `replace` on an **already-retired** predecessor | re-addressed to the successor, together with every other open task nobody owns — the work was left unowned by the earlier retirement, and this is the successor it was waiting for | `transferred` and `transferred_tasks`, and the message names them; the retire half answers `already-retired` and adds nothing | stay where they are |
| a **failed successor start** | nothing moves: the predecessor is untouched and still live | the thrown error says the predecessor was **not** retired, and no task field appears because no task moved | unchanged |
| a **failed retirement behind a started successor** | already moved: the handover is the first write, so the successor the caller started still carries its work | `predecessor_retired: false`; `transferred` is **absent**, because this call transferred nothing (a previous attempt did) | unchanged |
| `retire_member` with **no successor** | the owner is cleared: the rows stay `open` and become unowned, because the work is still owed | `unowned` (count), `unowned_tasks` (ids), and the message says nobody will carry them | stay with the tombstone |
| **restore** of a member whose tasks were transferred | unchanged: a restore recovers a lifecycle record and an artifact, it does not re-assign work | `unowned` / `unowned_tasks` report the work still waiting for an owner — a fact, not a claim; no owner is written | unchanged |
| retirement by the **ephemeral sweep** | the owner is cleared, through the same retirement the model would have called | the triggering call's `swept`/`swept_targets` gain `unowned`/`unowned_tasks` for the rows the sweep orphaned | stay with the tombstone |
| an open task whose **owner name was later reused** by a new generation | nothing happens by name: `owner` is a *target*, and generation 2 of a name is `reviewer-g2`, a different target. A new generation inherits nothing by name alone, and the old target still resolves for re-assignment because a retired member is a valid owner handle | none | unchanged |
| a task carrying a **`body`** through a handover | the row is re-addressed like any other one: the body moves with it, because the body belongs to the task and not to the member that happens to hold it | the same `transferred` / `transferred_tasks`; the brief names the id and title only, so the successor reads the body from the board with `list_my_tasks` (§4.5.2) | stays with the predecessor's tombstone |
| a **`task_board` write racing a handover** (`update`, `release` or `delete` computed before it lands) | `update` applies only the fields it names to the row as stored, so a status or body change keeps the successor's owner; `release` and `delete` find a row whose `status`/`owner` is no longer the one they read and write nothing at all | `changed: false` with the row as stored and a message naming what moved and how to repeat the call; `delete` also omits `deleted` | unchanged |

What the cells depend on:

- **The handover is the first write of a replacement, before the tombstone.** A successful start, then one
  mutation that re-addresses the rows, then the retirement record. A failed start therefore moves nothing,
  and a failed tombstone leaves a live member whose work already belongs to its successor — a partial
  lifecycle whose next step is one more `retire_member`, not a lost task. The order is the reverse of the
  retirement's own tombstone-first rule (§4.4), and for the same reason: the operation that can fail must
  fail on the half that is recoverable.
- **Unowned work is adopted only by a replacement.** A retirement creates unowned rows and a replacement
  consumes them, so a `spawn_member` with `replace` picks up every open row nobody owns, including rows it
  did not orphan. Nothing else claims them, and no read ever assigns an owner.
- **A transfer writes ownership, never status.** A row stays `open` through a handover; only `task_board`
  with `action: update` turns it `done`, which is also the only way a row stops being inherited.
- **A board write is rebuilt from the row it lands on, and subtraction has a premise.** Every id-addressed
  task action re-reads the row inside the serialized mutation (§4.2): `update` merges the fields it names,
  and `release`/`delete` answer `changed: false` instead of removing an owner or a row that a handover
  changed since the call read it. That is what keeps the replacement row above true when the two calls
  overlap rather than merely follow one another (ADR 0020).
- **Two tools in one model turn.** Every task mutation is one atomic `update` on the roster table, like
  every member mutation (§4.2), so a `task_board` call and a replacement in the same turn see each other's
  write instead of overwriting it.
- **A definition-spawned successor is swept like any other one-shot member.** A `replace` whose definition
  carries `ephemeral: true` starts a successor that retires itself once its turn ends, so the work this
  matrix just moved to it loses its owner at the next sweep, and the `unowned`/`unowned_tasks` that sweep
  reports are the same rows it was given here (§4.3.3).

#### 4.3.1 Ephemeral members (P4-01)

An ephemeral member exists for one-shot work: the model spawns several of them in parallel, reads their
output, and expects them to leave the roster without one `retire_member` call each.

**The property, not a phase.** `spawn_member.ephemeral: true` records `ephemeral: true` on the member and
`startedAt` when its child starts, and every `list_members` row reports `ephemeral: true`, so the model
can see which members will leave on their own. The default is false, no phase is added, and a profile that
never sets the flag behaves exactly as it did before. `message_member` to an ephemeral member **clears
the flag**: messaging it again is a declaration that it is not one-shot after all, and this is the one
case where a later sweep would otherwise retire work the model intended to keep.

**There is no durable completion event, so the sweep carries its own evidence.** The notices table above
records that nothing durable happens when an active child finishes its turn. The installed subagent seam
(`dsh-subagent` 0.2.2-rc.1) reports a descendant row's `activity` as `running` or `inactive`
(`lib/index.js:2435`, `sessions.get(entry.id) === undefined ? "inactive" : "running"`), and `inactive`
also describes a child that never started, so it cannot prove completion by itself — only `running` is
trustworthy positive evidence. The plugin therefore requires evidence it recorded itself: `startedAt`,
written when the activation resolved, so a reservation that never published has none; plus the local live
registry (`liveStateOf`: `ctx.agents.get(childId)`) reporting the member not resident. That pair is "it
ran and then stopped" — a member that never started, and a member still running, are both left alone.
ADR 0013 records the signal and why `activity` alone was not enough.

**The sweep is lazy, and it has exactly two trigger points.** It runs at the start of `list_members` (the
read where the model collects results) and `spawn_member` (the fan-out where the freed slots matter), and
nowhere else. Both already re-read the roster; neither runs on a plugin-owned clock, and no background
task, timer or model call is involved. It runs before the triggering operation's own read, so a
`list_members` result already shows a swept member as `retired`, and `spawn_member` can reuse the freed
target. It returns immediately — no read of the subagent registry, no write — when no member is
ephemeral. Every other tool is either target-scoped (`message_member`, `stop_member`, `retire_member`,
`restore_member`, `compact_member`), reads live state without writing (`wait_members`), or touches no
member at all (`handoff_template`), so a sweep there would be an unrelated retirement on a result that
does not report it.

**Retirement stays one implementation.** A swept member goes through `retireMember` exactly like a
model-invoked retirement — drain, tombstone-first, artifact move, retention cap, host effects — and its
tombstone records `retireReason: 'ephemeral member: its turn ended'`. A triggering operation whose sweep
retired something adds `swept` and `swept_targets` to its result; when it retired nothing, the result is
byte-for-byte what it was before this feature.

What the four events do to an ephemeral member in each phase:

| Phase | retire | message | replace | sweep |
|---|---|---|---|---|
| `provisioning` | drains (usually nothing) and tombstones; the child is drained when it publishes | delivered or refused as the matrix says, and an accepted message clears the flag | the successor starts, then the reservation is tombstoned | never — there is no `startedAt`, so nothing proves it ran |
| `active` | the normal retirement protocol | delivered, and the flag is cleared: it is no longer one-shot | the normal replacement handoff | retires it only when it is not resident; a running member is never swept |
| `retired` | no-op, `reason: 'already-retired'` | refusal `retired` | the normal replacement, briefed from the tombstone | no-op |
| `failed` | accepted; there is usually nothing to drain | refusal `failed` | the normal replacement | no-op — it never ran, and the record stays visible |

#### 4.3.3 A definition across spawn, replace and message (v0.17.0)

A definition is read at one moment — the spawn that names it — and every field it carries then lives on a
record, on a live child, or nowhere. `name`, `label` and `prompt` follow the precedence rule in §4.6; the
table below is every other accepted field, because each of them can surprise whoever wrote the file and
did not read the call. One cell per field, and each cell answers the same three questions: what the file
contributes at that event, what the call may override, and what the effect is. The events are the three
§4.3 already names: `spawn` (no `replace`), `replace`, and `message` (`message_member`).

**`message_member` never reads the file.** A message acts on a member that already started, so a
definition contributes nothing there: the two fields a message can still reach are the assignment it
records and the one-shot flag it clears, and no other field of the file is consulted again until a later
`spawn_member` reads it for another member.

| Field | `spawn` (no replace) | `replace` | `message` |
|---|---|---|---|
| `assignment` | file: supplies the durable assignment; call: an explicit `assignment` on the call overrides it; effect: the record carries it and `list_members` reports it. | file: supplies it **only when the predecessor recorded none**; call: an explicit assignment on the call wins over both, and the predecessor's recorded assignment wins over the file's; effect: the successor is briefed with the work rather than the role's standing sentence, and the result names the winner in `definition.assignment` (`call`, `predecessor` or `file`). | file: read for nothing; call: `message_member.assignment` replaces the recorded assignment once the message is accepted; effect: this member's next successor is briefed with the new text. |
| `ephemeral` | file: marks the member one-shot; call: `ephemeral: false` overrides it; effect: a lazy sweep retires it once it has run and stopped (§4.3.1). | file: **applies to the successor** — the file describes the role, and a replace starts that role; call: `ephemeral: false` or `ephemeral: true` overrides it; effect: a one-shot successor retires itself at the end of its turn, and the work it just inherited — including the tasks this same call handed over — becomes unowned and is reported through `unowned`/`unowned_tasks` (ADR 0017). | file: contributes nothing; call: any accepted message **clears** the flag; effect: the member is no longer one-shot and a later sweep leaves it alone. |
| `cwd` | file: supplies the working directory; call: `spawn_options.cwd` overrides it; effect: the child starts there, exactly as written. | file: supplies it; call: `spawn_options.cwd` overrides it; the predecessor's own `cwd` is **not** inherited, because the record does not store it; effect: the successor starts where the file or the call says, which may differ from where the predecessor ran. | file: contributes nothing; effect: fixed for this member's life — a different directory needs a new spawn or replacement. |
| `provider` | file: supplies it; call: `spawn_options.agent_options.provider` overrides it; effect: the member's model requests are routed there. | same as `spawn`, and the predecessor's route is not inherited — it is not on the record. | contributes nothing; fixed for this member's life. |
| `model` | file: supplies it; call: `spawn_options.agent_options.model` overrides it; effect: a chosen model is never silent, because `started_with` echoes what was forwarded. | same as `spawn`; the predecessor's model is not inherited. | contributes nothing; fixed for this member's life. |
| `reasoning_effort` | file: supplies it; call: `spawn_options.agent_options.reasoning_effort` overrides it; effect: an omitted effort after a provider or model change lets the new route resolve its own default. | same as `spawn`. | contributes nothing; fixed for this member's life. |
| `max_tokens` | file: supplies it, refused unless it is a positive integer; call: `spawn_options.agent_options.max_tokens` overrides it; effect: bounds the member's output tokens. | same as `spawn`. | contributes nothing; fixed for this member's life. |
| `agent_preset` | file: supplies it; call: `spawn_options.agent_preset` overrides it; effect: it selects the member's preset, persona and tool set, and an id the profile does not declare is a typed refusal. | same as `spawn`. | contributes nothing; fixed for this member's life. |

What the table depends on:

- **Continuity is what a replacement is for, and one field of a file could break it.** The `assignment`
  rule is the point of v0.17.0: before it, a file that carried an `assignment` briefed every successor
  with the role's standing sentence instead of what the predecessor was doing, which defeats ADR 0009 and
  the plugin's claim that the work survives the person. The call is the Lead's explicit statement and
  still wins; the file is the fallback for a predecessor that recorded nothing. This adjusts point 4 of
  ADR 0018, which stated the merge for a fresh spawn and did not yet name the predecessor as a source
  (ADR 0019).
- **`ephemeral` is the file speaking about the role, and its consequence is stated rather than hidden.** A
  replaced member that self-retires at the end of its turn is exactly the surprise this matrix exists to
  prevent: the tasks a replacement just moved to it lose their owner when the next `list_members` or
  `spawn_member` sweeps it, and the sweep's result names them (§4.3.1, ADR 0017). A Lead that wants the
  successor to keep the work messages it once — which clears the flag — or passes `ephemeral: false` on
  the replace call. Ignoring the file's `ephemeral` on a replace was the alternative, and it was rejected:
  the definition *is* the role, and a role that is one-shot does not stop being one-shot when its first
  holder is replaced (ADR 0019).
- **The predecessor's `cwd` and model route are not inherited, and cannot be.** They are start options,
  not record fields: `started_with` is a receipt on a tool result, not durable state (§4.2), so a
  successor takes the file's or the call's values and nothing else. A Lead that wants the successor in the
  predecessor's directory passes it.
- **The transfer matrix (§4.3.2) is unchanged by any of this.** A replacement still moves the
  predecessor's open tasks in the same call, whatever the file says; the `ephemeral` row above only
  decides who loses them next.

### 4.4 Retire and replace

Retirement is a protocol, not a deletion, because a member's Session is durable and its work may be
half-finished. What `retire_member` does, in the order the code does it:

1. **Record the reason.** A model-supplied `reason` is kept on the tombstone as `retireReason`.
2. **Drain.** `ctx.subagents.drainChildren(lead, [childId])` stops the child and releases its activation
   slot and residency. A child that never published, or one that already settled, has nothing to drain;
   retirement proceeds either way, because the record is the lifecycle authority.
3. **Tombstone.** The record moves to `retired` carrying `retiredAt`, its `assignment`, any reason, and
   the trash path the next step intends to use, marked `trashState: 'pending'` (or `'none'` at once when
   there is nothing to move) — *before* the filesystem is touched (§2.5). A crash here leaves a retired
   record and an artifact that is either unmoved or already trashed; `pending` says which is unknown and
   restore looks in the trash first, so both cases are recoverable.
4. **Move the artifact, then confirm.** The persisted Session moves into the plugin's trash directory and
   the record is confirmed with `trashState: 'done'`, its `trashPath`, `originalPath` and `trashKind`.
   When no artifact can be moved, the workspace archive hides the Session instead, the intended trash
   fields are dropped, and the record and the result say that this is what happened (`archived: true`,
   `trashState: 'none'`). `archived` and `trashPath` are mutually exclusive: the archive branch runs only
   when no move happened.
5. **Bound the trash, only here.** A retirement that moved an artifact in removes the entries past the
   **effective** cap from this Lead's trash directory, oldest first; the cap is the `trashLimit` config
   field `apply` resolved (default `DEFAULT_TRASH_LIMIT`, 20), not a constant in the code; each removed
   tombstone keeps its `trashPath` and becomes `trashState: 'pruned'` (ADR 0011, ADR 0012). Only direct
   children whose name and tombstone both parse are candidates, a `pending` move is counted against the
   cap but never pruned, and only this plugin's own trash copies are deleted — the platform has no
   Session-deletion API, and its only "hide it" mechanism is a reversible archive that cannot bound
   bytes. A retirement that moved nothing prunes nothing. No timer and no read-time sweep exists.
6. **Hide.** Retired ids stop being served by the host projection exits, so every client drops the
   member, while the roster keeps the trash path for manual recovery.
7. **Report.** The result carries `retired`, `drained`, `archived`, `trashed`, `pruned` (0 when nothing
   was removed) and — when there is one — `trash_path`; when `pruned` is above 0 the message says how
   many artifacts were removed, at which cap, and why. A repeated call is a no-op that answers
   `retired: true, drained: false, pruned: 0, reason: 'already-retired'`.

The durable statement of the work is the member's `assignment`, set by the model with
`spawn_member.assignment` and kept current with `message_member.assignment`; it is capped at 1000
characters, so a record cannot grow without limit.

**Replace.** `spawn_member` with `replace: <target>` composes a short, self-contained prompt for the
successor: the successor's name, the predecessor's target and label, the recorded assignment, the fact
that the predecessor is gone, its open tasks by id and title, and a pointer to this Lead's own task board
under the predecessor's name — read by the member with `list_my_tasks` (§4.5.2). The board's rows are handed over, not copied and not duplicated. It then
runs steps 2–6 on the predecessor. **The successor starts first and the predecessor is retired second, in
the same call**: a failed start leaves the predecessor untouched and live, and a failed retirement returns
`predecessor_retired: false` with the reason, so one more `retire_member` call recovers it. A target
already retired is accepted, and its tombstone supplies the brief. ADR 0009 records the ordering and why
the alternatives were rejected; ADR 0017 records the handover itself.

**A successor starts with the options the caller names for it.** `spawn_options` applies to a
replacement exactly as it does to a plain spawn; the predecessor's live record and its eventual
tombstone are unaffected. A start the Harness refuses — a preset id the profile does not declare, a
provider without the requested capability — is the failed start the ordering above already covers: the
predecessor stays live, the result says `predecessor_retired: false`, and the failed reservation is
listed so a retry can name a declared preset or omit the field (ADR 0016).

The successor's brief is inherited work, not a copy of the predecessor's state: the successor inherits
the predecessor's `assignment` unless the model records a different one, so repeated replacement does not
thin the record out one generation at a time.

**The brief's shape has three sources, in this order: the team file, the stored template, the built-in
shape.** A Lead that replaces members repeatedly can commit `team/team.md` with the project, store a
template with `handoff_template` (§4.5), or store nothing and get the built-in shape. The file wins while
it exists, so the tool reports `source` on every read and refuses a store or clear with the file's path
(§4.7). The placeholders are `{successor}` and `{predecessor}` (the two targets), `{label}` (the
predecessor's role), `{assignment}` (what it was recorded as doing) and `{task_board}` (the pointer to the
Lead's own task board). `{assignment}` is required, because a brief that omits it hands the successor a
role and a board pointer but not the work it inherited — which is the whole point of the handoff. A
template is validated when it is stored or when the file is parsed: an unknown placeholder is refused by
name, so a typo cannot reach a child as literal text. The successor's own task is always appended after
the rendered template, so no template can drop it. The rendered section is capped at 2000 characters and
refused rather than truncated, measured only when a template is in effect — which is what keeps the
built-in path byte-identical to the release before P4-02. A stored template belongs to one Lead's roster
record, so two Leads never share one; a team file belongs to the project, so two Leads working in the same
project do share it, deliberately. `list_members` rows never carry either.

**The board travels with the brief, bounded.** A brief is not a workspace dump: a member starting with a
200-line backlog is worse off than one starting with five ids. So the composition adds **one line** naming
the predecessor's open tasks by id *and* title — either alone is unusable, because an id the successor
cannot look up is a round-trip and a title alone cannot be marked done — and the line is bounded twice:
at most 5 rows, and at most 600 characters, which is five maximal titles (`TASK_TITLE_MAX`, 200) with room
for the ids. **The line carries ids and titles and nothing else: never a row's `body`**, which is bounded
for the board (`TASK_BODY_MAX`, 2000) and not for a child's prompt, so one maximal body per row would
break the 600-character bound — the successor reads the bodies from the board with `list_my_tasks` (the
Lead with `task_board`), the same board the pointer sentence sends it to (ADR 0020, ADR 0022). A list that
would not stay under either bound is
dropped entirely and the successor keeps the `{task_board}` pointer sentence, which is exactly the brief
the release before P2-09 produced. A successor whose predecessor owned no open task therefore gets a brief
that is byte-identical to the old one, and a test pins that string — the brief carries ids and titles only
when there is work actually in flight, and it never carries a `done` row.

**A template keeps its own line.** The inherited-tasks line is appended after the rendered template
and before the successor's own task, so a template can neither drop it nor duplicate it, and the
`{task_board}` placeholder still means what it always meant: the pointer. A template is not required to
mention the board at all — it is the default shape that does.

**Not built, and therefore not described as behaviour.** There is no member-written brief and no brief
file: asking a member for one costs a model round-trip exactly when the member may be unresponsive or
already failed, so the brief is composed from the record and the board. Nothing in the code reconciles an
assignment or a task against the working tree — that check is the Lead's judgment, and the plugin only
names the rows it stored.

### 4.5 Model-facing surface

The plugin is Host-only, so every operation it owns is a tool (ADR 0008). Ten are Lead-scoped, and the
`target` of a `list_members` row is the selector every member-scoped Lead tool takes (`handoff_template`
takes no target: it acts on the Lead's own record). One is member-scoped and read-only, `list_my_tasks`:
it registers on a member Agent rather than the Lead's, and §4.5.2 is the authority model for both scopes.
`child_id` on the row is the durable identity the host's own listings show; it is reported, not used as a
second selector, because a second addressing mode would have to be honoured by every member-scoped tool to
stay consistent while the target is already unique among addressable members. The Lead check is
deliberately forgiving about the membership projection: a live agent with no parent Session is the root
agent and is treated as the Lead, so a failed projection cannot disable every tool.

| Tool | Behaviour |
|---|---|
| `spawn_member` | Reserve the next generation of a base name and start it as a continuable child; with `definition`, start it from a member definition committed with the project, whose fields fill whatever the call omitted (§4.6); with `replace`, start the successor from the handoff brief, hand the predecessor's open tasks to it, and retire the predecessor in the same call (§4.4, §4.3.2). `spawn_options` (optional) starts it with its own `cwd`, `agent_options` (`provider`, `model`, `reasoning_effort`, `max_tokens`) or `agent_preset`; an omitted field inherits the Lead's value — except that a changed `provider` or `model` without `reasoning_effort` lets the new route resolve its own default — and `started_with` reports back what the plugin forwarded, not what the child resolved. A start the Harness refuses is a typed result (`started: false`, with a `reason` naming the way out), never a host error, and a definition that cannot be read is answered the same way (ADR 0016, ADR 0018). With `ephemeral: true` the member retires itself once it has run and stopped (§4.3.1), and the call first sweeps any finished ephemeral member. |
| `list_members` | Every member and subagent the Lead controls: this roster, adopted shipped members, and adopted subagent descendants (§4.5.1). Rows carry `target`, `child_id`, phase, generation, label, the `assignment` recorded for the member, `ephemeral` on a one-shot member, live state and `compactable`; the pressure fields (`pressure_tokens`, `context_window`, `usage_ratio`) appear only while resident. A read first sweeps finished ephemeral members and reports `swept` and `swept_targets` when it retired any — plus `unowned`/`unowned_tasks` when a swept member left open work behind (§4.3.2). |
| `wait_members` | One bounded wait on the live status of this Lead's members: it answers when a member's `agent/status` transitions (`idle` ⇄ `running`) or after the timeout, and reports the member and the status it entered. The timeout defaults to 30 s and is refused above 1 h; a roster with no `running` member and no `provisioning` reservation answers `no_progress` at once, because a blocked Lead cannot wake an idle member. It observes only post-call transitions and never wakes anyone (§4.5). |
| `message_member` | Deliver one message to a live target, and optionally replace its recorded `assignment`; a running child sees it at its next step, an unloaded continuable child is cold-resumed. Messaging an ephemeral member clears its flag, so it will not be swept. A retired or failed target is refused with `reason: 'retired'` or `'failed'`, and an unknown one with `'missing'`; when another generation of the name is live, the refusal also carries `current_holder` and says so. |
| `stop_member` | Cancel one target's current turn, keeping its activation and inbox; refuses a retired or failed target with the same typed reason as `message_member`, and carries `current_holder` the same way. |
| `retire_member` | Drain, tombstone, move the session artifact to the trash, enforce the per-Lead retention cap and refresh the host effects (§4.4); the result reports `pruned`, a repeat is a no-op that answers `reason: 'already-retired'`, and a stale target then names the live holder of its name. It is a retirement with no successor, so the member's open tasks lose their owner and the result names them in `unowned`/`unowned_tasks` (§4.3.2). |
| `restore_member` | Move a trashed artifact back and return the record to `active`; the result says which branch ran, an already-active record is a no-op success rather than an error, a pruned tombstone answers `reason: 'pruned'` without touching the workspace, and a refusal carries `current_holder` when another generation of the name is live. It assigns no work: `unowned`/`unowned_tasks` report the open rows still waiting for an owner (§4.3.2). |
| `compact_member` | `ctx.compaction.compactNow(agent, signal)` on a resident, idle target, returning a structured result rather than throwing: `done`, `busy`, `not-resident`, `nothing-to-compact`, `failed`. |
| `handoff_template` | Read, store or clear this Lead's handoff-brief shape: omit `template` to read the effective one and its `source` (`file`, `stored` or `builtin`), pass a template to validate and store it, pass an empty string to clear it. The team file `team/team.md` wins while it exists, so a store or clear is refused with the file's path and the instruction to edit it; a broken file is reported by `file_problem` and does not shadow a usable stored template. A stored value that no longer passes validation is reported (`valid`, `problem`) and the composition falls back to the built-in (§4.7). |
| `task_board` | This Lead's own work board: `create` adds a task, `list` reads the board, `update` sets a task's `status`, `owner` and/or `body` (`owner: null` and `body: null` clear them), `release` clears an owner, `delete` removes the row (§4.3.2). One tool with an `action` enum rather than five names, because the five operations share one row shape and one refusal vocabulary and each action carries at most three extra fields. A task id is a UUID, a title is refused past 200 characters, a body is refused past 2000 and one Lead holds at most 200 tasks; a stored row whose title or body no longer passes the read rule is served with `problem` rather than dropped (§4.2). `list` reports how many tasks are open, how many of those nobody owns, and every row's body — the acceptance criteria and stopping point the brief does not carry. An id-addressed write is built from the row as stored inside the serialized mutation, so an `update` keeps a field it did not name and a `release` or `delete` whose row moved since the call read it answers `changed: false` with the row it found instead of undoing a handover (ADR 0020). |
| `list_my_tasks` | Registered on a **member** Agent, not the Lead: the read-only rows whose `owner` is this member's own target, each with its id, title, body, status, timestamps and the same read-time `problem` the Lead's board reports, plus `open` and the member's `target` (§4.5.2). It takes no parameter: the caller's Session is the selector. A member owning nothing gets `tasks: []` and a sentence, not an error; another member's row, an unowned row and the Lead's whole board are absent. The board has no member writer — a member reports finished work and the Lead closes the row (ADR 0022). |

The operation bodies live in `actions.js`; `index.js` owns argument validation, the Lead-only authority
check and the tool result schemas. Replacement deliberately has no tool of its own: `spawn_member` and
`message_member` gained one parameter each rather than the model learning a third name for the same job
(ADR 0009). The brief's *shape* is one further tool rather than a parameter on `spawn_member`, because a
stored preference must not change as a side effect of creating a member (ADR 0015). The task board is one
tool rather than five for the same reason in reverse: five names would triple the surface for one row shape
(ADR 0017), and its two jobs — the board and the handover — reach the model as one vocabulary.

The shipped roster's spawn, wait and task tools are disabled by the bundle patch (P2-07, v0.14.0) —
`spawn_teammate`, `wait_agent` and the `team_task_*` tools — and this plugin's tools are the roster surface
a Lead acts through; the patch entry itself states what it removes and what it costs
(`cordis.patch.yml`). Three tools the shipped `agent-team` service publishes stay in the list:
`list_agents`, `send_message` and `interrupt_agent`, because disabling that service row would take
adoption, the membership test and the projection filter with it. Every tool the disabled row owned has a
replacement here, `wait_agent` included: `wait_members` observes the Harness's `agent/status` event,
filtered by the child ids on this Lead's roster. The shipped `agentTeams.waitForChange` is notified from
that same event, but only for an agent its own membership test resolves, and a member spawned through
`ctx.subagents` is not in its journal — which is why the wait is this plugin's own listener rather than a
call to that service.

#### 4.5.1 Adoption is the control surface

`ensureAdopted` (`actions.js`) is what makes the surface complete: it reads the shipped team roster and
the subagent registry, and records every unknown child as a member. A member adopted from the shipped
roster keeps its shipped name and starts `active`. The registry read is
`ctx.subagents.listDescendants(rootSessionId, signal)` (installed seam `dsh-subagent` `0.2.2-rc.1`,
`lib/index.js` lines 3181–3183 delegating to 2380–2446); child rows are
`{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`, and
`kind: 'diagnostic'` rows are skipped. A child with a label is named from it through the same
normalization a shipped name goes through; an unlabeled child is named `subagent-<id>`. Adoption is
idempotent by child id, and the retired record is the
tombstone that keeps it that way, because draining a child does not remove its row from the parent's
durable catalog. Message delivery is addressed through the Lead's direct-child authority, while a
retirement proceeds even when the drain refuses. The shipped depth limit is 1, so every descendant is a
direct child; a deeper tree — possible only when that limit is raised — is refused by message delivery
and still retirable.

#### 4.5.2 The authority model: what a Lead sees, what a member sees, and why (v0.20.0)

A member receives no Lead tool, and the Lead receives no member tool. That is two scopes, not two
permissions on one tool, and the split is what lets the board keep exactly one writer while the person
doing the work can still read the work it owns (ADR 0022).

| Caller | Tools it receives | What it reads | What it writes |
|---|---|---|---|
| The Lead of a Team | the ten Lead-scoped tools; `list_my_tasks` is not among them | the whole board with `task_board list`, every member with `list_members` | every roster operation and every board write |
| A member: a non-root Agent whose Session a roster names | `list_my_tasks` only | the rows whose `owner` is exactly its own target — open and done — from that roster | nothing on the board: it reports finished work, and the Lead marks the row `done` |
| A member that owns nothing | `list_my_tasks` | `tasks: []`, `open: 0` and a sentence | nothing |
| A child no roster names (a root Agent, or an unadopted child) | `list_my_tasks` | a refusal naming `task_board` for the Lead and the adoption trigger for the child; a read never adopts | nothing |

**The authority is the caller's Session, never an argument.** `requireMember` scans the rosters for the
record whose `childId` is the calling Session and returns that row; the row's target is what the filter
uses. A member therefore cannot ask for another member's rows by naming them, and there is no second way
to address work. The read is deliberately non-writing: adoption already runs on `list_members` and
`spawn_member`, and a member's read must not write a record onto a Lead it cannot see.

**One writer is an invariant, not a convenience.** The board is one serialized document whose handover is
a single mutation that re-addresses rows before a tombstone (§4.3.2), and whose `release`/`delete` actions
act only on the state they read (ADR 0020). Every transition in the transfer matrix has exactly one owner
because a member never writes. Giving the member a status change would add a second authority rule, a
second compare-and-set story against the Lead's handover, and a row whose `done` cannot be told apart from
"the member said so". A member's report and the Lead's transition are two different facts, and the
round-trip that keeps them apart is cheaper than the ambiguity that removes it.

**The registration follows the Agent, like the Lead's.** `installMember` registers on the member Agent's
own `agent.ctx` at load and on `agent/created`, and `agent/disposed` and plugin unload remove it. The
`target` a member reads under is resolved at call time, so registration can cover every non-root Agent
while the answer stays as narrow as the roster row that names it.

### 4.6 Member definitions (v0.16.0)

A member used to exist only as a tool call: its prompt, label and assignment lived in that call and in the
Lead's roster record, so a team could not be reviewed, versioned or shared, and the same "reviewer" was
retyped every session. A definition moves the member out of the call and onto disk — one markdown file per
member under `team/` in the Lead's working directory, committed with the project — while the roster stays
runtime state (ADR 0018).

**The path.** `<Lead working directory>/team/*.md`, resolved through the `workingDirectory` service:
`ctx.get('workingDirectory').ensure(leadAgent, signal)` (§5). That is the same service and method the
installed spawn seam uses for a relative `request.cwd`, so a definition is read from exactly the directory
`spawn_options.cwd` resolves against. The service is optional and read with `ctx.get`, like `compaction`; a
profile that mounts none, or whose `ensure` rejects, is a typed refusal
(`reason: "working-directory-unavailable"`) rather than a guess at a directory.

**The file.** `---` on line 1, a flat frontmatter block, `---`, then the markdown body, which is the
member's prompt. The accepted fields are exactly the inputs `spawn_member` already has: `name` and `label`
required, then `assignment`, `ephemeral`, `cwd`, `provider`, `model`, `reasoning_effort`, `max_tokens` and
`agent_preset`. The file's *name* is not an identity — the definition declares `name`, which is also the key
`spawn_member.definition` looks up — and a field with no counterpart on the call is out of scope.

**The subset is documented, not approximated.** `key: value`, one pair per line, no indentation; a value is
plain or quoted at both ends, with no escape interpreted; blank lines and `#` comments are allowed.
Nesting, lists, block scalars (`|`, `>`), anchors and aliases (`&`, `*`), merge keys (`<<`), flow
collections (`[...]`, `{...}`), duplicate keys, an unknown field, a key with no value and a missing
`name`/`label` are each refused with the file path and the line, and an unknown field's sentence lists the
accepted set. There is no YAML library, because the bundle imports nothing outside Node builtins (ADR 0002):
this repository's parser is the specification, and what it does not implement is refused rather than
misread.

**Precedence: the call wins, the record outranks the file on a replace, and the result says so.** Every
field passed to `spawn_member` overrides the definition's, per field and including inside
`agent_options`; the answer's `definition` object names the file, the fields taken from it (`from_file`)
and the ones the call replaced (`overridden`). `prompt` is one exception: the body is the member's
standing prompt and the call's `prompt` is the task, so the call's text is appended after the body and
`definition.prompt` reports `file` or `file+call`. The other is `assignment`, which has a third source:
on a `replace` the assignment recorded on the predecessor outranks the file's standing sentence, because
a successor inherits the work and not the role (ADR 0009, ADR 0019), and `definition.assignment` reports
which of `call`, `predecessor` or `file` supplied it — the file applies only when the predecessor
recorded none. Nothing from the file is dropped silently, because a model that believes it overrode a
definition and did not is exactly the failure this report exists to prevent.

**One bad file never hides the others.** A scan collects what it can read and reports what it could not:
`definition.problems` on a successful spawn, `problems` on a refusal, each row `{path, line?, problem}`. A
name declared by two files refuses both, because a lookup that quietly picked one would make the other
file's edits invisible. An unknown name answers `definition-not-found` with `available` — the names the same
scan could use — and answers `definition-invalid` instead when the directory also held a refused file,
since the name may be declared there. This is the rule a stored task already follows (ADR 0017): one bad
record must not hide the rest.

**Caps are refusals.** 16 KiB per file (`DEFINITION_FILE_MAX`) and 64 files per scan (`DEFINITION_LIMIT`),
never a truncation and never a partial read. The size cap is per file, so an oversized definition is refused
while its neighbours still work; the count cap is on the directory, so an over-full directory refuses the
whole scan rather than serving a partial set. A refusal reserves nothing — no member record is written and no
child is started — so fixing the file and retrying reuses the same name.

**The surface is one parameter.** `spawn_member.definition` is the whole feature: there is no
create/update/delete tool, because version control and an editor are what make a file better than a tool,
and the model writes the files with its own file tools. `spawn_member`'s result schema is a two-branch
`oneOf` — the member row, or the definition refusal — since the refusal is an answer rather than a host
error, which is the rule ADR 0016 already applies to a refused start.

### 4.7 The team file (v0.19.0)

The member scope moved onto disk in v0.16.0; the team scope wanted the same thing for the one setting that
shapes a handover. A brief template was the only team setting with no diff, no review, and no sharing
between two Leads working in the same project, so it is now a file committed with the project:
`<Lead working directory>/team/team.md`, resolved through the same `workingDirectory` service and the same
`team/` directory the member definitions use (§4.6). The file's body is the handoff template, validated by
the same `handoffTemplateProblem` rules a stored template passes.

**The name is reserved, and that is the answer to the scan collision.** `team.md` is skipped by the
member-definition scan, so it can never be mistaken for a member definition — a `team.md` declares no
`name` and would otherwise be reported as a broken definition on every spawn. A member may still declare
`name: team` in another file: the filename is not an identity (ADR 0018), and the reservation covers one
path, not one name.

**The frontmatter is empty for now.** It is parsed by the same documented subset, with no accepted field,
so a team setting nobody asked for is refused by name and line instead of silently carried. A future team
setting is a field added to that set, not a new parser.

**The effective template has three sources, in this order.**

| Source | When it is in effect | What the composition does |
|---|---|---|
| `file` | `team/team.md` exists and parses as a usable template | renders the file's body; the stored template is shadowed |
| `stored` | no usable file, and this Lead's `handoffTemplate` passes the content rules | renders the stored template, unchanged from v0.11.0 |
| `builtin` | no usable file and no usable stored template | renders the built-in shape, byte-identical to a profile that never had either |

The read form of `handoff_template` reports `source`, the effective `template`, the file's path when one
exists, `file_problem` when the file is not usable, and the stored value's own `stored`/`valid`/`problem`.
A file that exists but does not pass — an unknown placeholder, a missing `{assignment}`, an over-cap
template, an unknown frontmatter field, an unreadable or oversized file — is reported and never becomes
the effective template; the stored template is next, and the built-in shape is last. That is the same
fallback a stored value that no longer validates already gets, and it is what stops a typo in a file from
reaching a child as literal text.

**A store write is refused while the file exists.** The file wins, so accepting a write would be a silent
no-op: the model would believe it changed the brief while the file still composed every successor. Both
setting and clearing answer with the same refusal, and it names the file and the edit:

```
handoff_template: the team file "<abs path>/team/team.md" is in effect, so a stored template would be
shadowed and this write would change nothing. Edit that file to change the brief, or remove it to use
handoff_template again.
```

**What stays in the runtime record, and why.** The *tasks* do not move to the file. A task is lifecycle
state, written in the same breath as a tombstone and moved by a replacement (ADR 0017): it belongs to the
Lead's run, not to the project's source tree. The template is the opposite kind of state — a shape
preference, true of the team rather than of one member or one run — and that is exactly what a committed
file is good at. The split is by kind, not by age: the file holds what two Leads in one project should
share, and the record holds what only this run knows. A shared `team/` directory is therefore a feature
for the template and would be a bug for the board.

## 5. Harness extension points used
| Need | Mechanism |
|---|---|
| enable a shipped, disabled row | bundle patch `- id: <row>` with `disabled: false` |
| per-Agent behaviour | `agent.ctx` registrations from an `agent/created` listener, unwound on `agent/disposed` |
| tool registration | `agent.ctx.tools.register(definition)`, definition in canonical JSON Schema |
| context pressure | `ctx.tokenMeter.contextPressure(session)` |
| compaction | `ctx.get('compaction').compactNow(agent, signal)` |
| membership test | `ctx.agentTeams.tryMembership(agent)` |
| child lifecycle | `ctx.subagents.startActivation`, `sendMessage`, `interrupt`, `drainChildren` |
| start a member with its own directory, model route or preset | `request.cwd` / `request.agentOptions` / `request.agentPreset` on `ctx.subagents.startActivation`; gated by the provider's advertised capabilities, and tool restriction has no other route than an agent preset (§4.1, ADR 0016) |
| list every subagent descendant | `ctx.subagents.listDescendants(rootSessionId, signal)`; rows carry `id`, `mode`, `label?`, `parentId` and `depth` |
| notice that a child stopped | `subagent/end` (published when a run settles) and the `idle` edge of `agent/status`; neither is durable, so the ephemeral sweep still carries its own evidence (§4.3.1, ADR 0013) |
| wait on a member's live status | `ctx.on('agent/status', ({ agent, status }))` from the plugin's own context, filtered by the child ids this roster holds; the dispatch is scope-filtered and an unscoped listener is admitted to it (§4.5) |
| durable plugin state | `ctx.storageDomain`, not session events (ADR 0003) |
| resolve the Lead's working directory, and the `team/` a member definition or the team file is read from | `ctx.get('workingDirectory').ensure(agent, signal)` — the same service and method the spawn seam uses to resolve a relative `cwd`; optional, so a profile without it refuses a definition spawn and cannot see a team file, instead of guessing a directory (§4.6, §4.7, ADR 0018, ADR 0021) |
| hide a Session whose artifact could not be moved | `ctx.workspaceRegistry.archiveSession` / `unarchiveSession` (reversible, deletes nothing; the fallback branch of retirement and restore) |
| make clients drop a retired member | wrap `sessionController` list/projection/stream exits (ADR 0004) |
| make the shipped team panel list this plugin's live members | the same exits: append the four-field member row to the outgoing `agentTeam` value (ADR 0023) |
| credit the shipped roster budget | patch the legacy roster's `maxMembers` getter and `spawn` (ADR 0004) |
| move a retired session aside | `ctx.get('sessionPersistence').stat(id).location.path` + a rename into the trash |

## 6. Risks and limits

- **The in-app view is the shipped team panel, overlaid — not a panel of ours.** There is no Settings
  page (ADR 0008). The 成员 (members) section lists this plugin's live members because the projection
  filter adds them to the outgoing `agentTeam` value, and a retired member leaves that value rather than
  appearing as a row marked retired (ADR 0023). The overlay is a view: it cannot retire, replace or edit
  anything, and it is only as fresh as the next `list`/`projections`/`follow` read or `control` frame —
  this plugin writes no Session event, so a spawn publishes no team change frame of its own. The
  共享任务 (tasks) section still shows the shipped board, because a task view needs ten fields this
  board does not have.
- **The shipped roster is still the source of the members it created.** Its spawn, wait and task tools are
  disabled (P2-07), but its service is not, because adoption and the projection filter need it:
  `list_members` reports those members, this plugin keeps their tombstones, and the service's three
  model-facing tools (`list_agents`, `send_message`, `interrupt_agent`) stay registered.
- **The shipped task board is out of reach.** A Lead's work lives on the owned board (§4.3.2); rows on the
  shipped board are not readable from this plugin, and the tools that could read them were disabled in
  v0.14.0. A retirement neither transfers nor un-owns them: a Lead that wants them re-creates them on
  `task_board` (ADR 0017).
- **Bounded recovery, and no true erasure of the platform's record.** A retired member's Session is
  recoverable until this Lead's trash passes its cap; a pruned artifact's bytes are gone for good, and
  the record says `pruned` instead of pretending otherwise. The shipped catalog still knows the member
  existed, because the platform never deletes what it owns (ADR 0011). Retirement is a lifecycle fact in
  our roster, not a platform deletion.
- **A forwarded directory, route and preset are the caller's decision, and the plugin only forwards
  them.** It cannot tell whether a `cwd` is usable until the Harness resolves it, and it cannot tell
  whether a preset id exists until the registry looks it up, so both refusals are the seam's answer
  translated into a typed result rather than a pre-check that could disagree with the Host (ADR 0016).
- **Harness API drift.** Every Service named here is read from an installed asar whose version moves;
  a Harness upgrade can invalidate this document without any change in this repository. The installed
  subagent seam is a different generation from the public source tree: the public tree has member names
  and `resolveName`, the installed build does not. Read the installed `lib/index.js` before trusting a
  public example.
- **The handoff is only as good as the recorded assignment and the board it names.** The plugin cannot read
  the shipped task board or the predecessor's transcript, so the successor's brief is composed from the
  record and from this plugin's own task rows (§4.3.2). A member whose assignment was never recorded, and
  whose board holds no open task, hands over a label and a pointer, not a summary.
- **A member definition and the team file are files this plugin only reads.** It cannot tell whether they
  are current, whether a prompt matches the work the Lead has in mind, or whether a `team/` directory is
  shared by two Leads in one working directory; that is the project's version control, not this plugin's
  job. What it guarantees is narrower and checkable: the definitions a caller can use are exactly the
  readable `.md` files under `team/` at the moment of the call, the team file is exactly `team.md`, and a
  file it cannot read is refused by path and line rather than half-applied (§4.6, §4.7, ADR 0018,
  ADR 0021).
- **Compaction is profile-wide.** Enabling the backend changes behaviour for every session in the
  profile. It is a shipped feature turned on, not custom code, but it is not scoped to this plugin's
  members.
