# Architecture

> Owner: @FrozenYty · Revisit when: a Harness upgrade changes a Service this plugin uses

This document describes what the plugin is, what it does today, and the roster design being built.
The decisions behind the design live in `docs/adr/`; this file describes the result.

## 1. What the plugin is

A DeepSeek Harness **profile bundle**. Installing it does two things:

1. selects a shipped plugin row that the profile leaves disabled (`compaction-basic`);
2. inserts one Host plugin of our own (`dsh-team-roster`).

There is no build step and no runtime dependency: the installed Harness resolves the shipped row from
its own installation, and our entry imports nothing (ADR 0002). The bundle is Host-only: it has no
browser half (ADR 0008).

## 2. v0.1, shipped

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

Every Lead-scoped tool registers on the exact Agent context of a Team Lead (`agent/created`), and unwinds
on `agent/disposed`. No official tool name is shadowed and no session event is written.

| Tool | Behaviour |
|---|---|
| `list_members` | the roster: phase, generation, label, live state, and — while resident — `pressure_tokens`, `context_window`, `usage_ratio` and `compactable`. |
| `compact_member` | `ctx.compaction.compactNow(agent, signal)` on one resident idle member, returning a structured result rather than throwing: `done`, `busy`, `not-resident`, `nothing-to-compact`, `failed`. |

`member_context` existed in v0.1 and was removed: its rows duplicated `list_members`, and it read the
shipped roster rather than this plugin's.

Measured limitation that shapes the design: a local child is unloaded when it goes idle, and
`compactNow()` requires a resident idle Agent. A finished teammate therefore cannot be compacted on
demand; waking it with a message and letting automatic compaction run at its next step is the durable
path.

### 2.3 Own roster tools (v0.2, verified live)

| Tool | Behaviour |
|---|---|
| `spawn_member` | Reserves a generation-suffixed name, persists the reservation, then starts a continuable child through `ctx.subagents.startActivation` with a generated `childId` and `delivery: 'parent'`. A failed start leaves a visible `failed` record, never an invisible child. With `replace`, the same call retires the predecessor and starts its successor from a handoff brief (§4.4). |
| `list_members` | Every record with phase, generation, live status and — while resident — context pressure. Retired members stay listed as `retired`. |
| `retire_member` | Drains the child, tombstones the record with the trash and original paths — and with whether the workspace archive hid the session instead — and moves the persisted Session into the trash directory. Retiring an already-retired member is a no-op that answers `retired: true, drained: false, reason: 'already-retired'`. Verified against a finished member and a member mid-turn. |
| `restore_member` | Moves the trashed artifact back to the path recorded at retirement and clears the tombstone; refuses when a live member already owns the target. A restore with no tombstone to invert is a no-op success, and the result's `reason` names which branch ran. |
| `message_member` | `ctx.subagents.sendMessage(caller, childId, [text], { signal })`. A running member receives it at its next step; an unloaded member is cold-resumed from its own Session. Verified live: a delivered message woke an unloaded member, which replied. |
| `stop_member` | `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: caller })`. Cancels the current turn only; the activation, slot and inbox are kept. Verified live: a member running a long command was interrupted and left no closing message. |

**Adoption.** The roster picks up every member and subagent a Lead controls that it does not already
know, the first time it is read.

- Members the shipped team roster created: the record reuses the child Session id as its identity, keeps
  the shipped name, and starts `active`.
- Every descendant the subagent registry reports, including children spawned with the shipped `subagent`
  and `subagent_fork` tools. The read is `ctx.subagents.listDescendants(rootSessionId, signal)` on the
  installed seam (`dsh-subagent` `0.2.2-rc.1`, `lib/index.js`: the service method at lines 3181–3183,
  the traversal at lines 2380–2446). Each child row is
  `{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`; `kind: 'diagnostic'`
  rows for a branch that could not be read are skipped. A child with a label is named from it through the
  same normalization a shipped name goes through; an unlabeled child is named `subagent-<id>`.

So `retire_member`, `message_member` and `stop_member` apply to children this plugin never spawned —
exactly the population that was invisible before. Adoption is idempotent and matched by child id, and the
tombstone is what keeps it that way: draining a child does not remove its row from the parent's durable
`subagentCatalog`, so a retired record must stay in the roster or the next read would adopt the member
back. A one-shot child is adopted like any other and can be stopped or retired; it cannot be
cold-resumed, so `message_member` reaches it only while it is resident.

Records live in one `storageDomain` domain keyed by the Lead Session id (ADR 0003). Naming rule:
generation 1 is the bare base name; generation 2 and later is `<base>-g<N>`, so a replacement never
collides with a retired name. Spawning the same base name after a retirement is the replace operation:
`probe-a` retired, `probe-a-g2` started, both recorded.

The shipped team roster and this roster coexist until P2-07 disables the shipped tool row. `list_agents`
is the shipped tool and reports the shipped roster; `list_members` reports that roster's members **plus**
every adopted descendant and every member this plugin spawned, so it is a superset of `list_agents`, not a
disjoint set.

### 2.4 Host-side effects

Two effects make a retirement visible to clients and keep the shipped member budget usable. Both are
capability-probed, both restore exactly what they replaced on plugin unload, and neither writes to the
Lead Session (ADR 0004).

| Effect | Mechanism | Behaviour when the host shape is absent |
|---|---|---|
| Projection filter | wraps `sessionController.list` / `projections` / `control` / `follow` and strips retired ids from `subagentCatalog` and `agentTeam` frames | retirement still works; clients keep rendering the member |
| Slot credit | replaces the legacy roster's `maxMembers` getter and wraps `spawn`, adding the retired count of the spawning Lead for the duration of that spawn | retirement still works; the shipped budget stays consumed |

Both read retired records through a two-second cache that `retire_member` invalidates, and both are
transparent to other plugins: same arguments, same return shape, and the payload is mutated rather than
copied so a caller's reference stays valid.

### 2.5 Retirement moves the artifact

`retire_member` drains the child, writes the tombstone — carrying the trash path the move is about to
use and a `trashState: 'pending'` marker — and then moves the persisted Session into
`~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`, confirming the record with
`trashState: 'done'`. The order is deliberate: the record is retired before anything touches the
filesystem, so a crash between the two leaves a `retired` row beside an artifact that is either still in
place or already in the trash — recoverable in both cases, because `pending` says the move may or may not
have happened and restore looks in the trash first. The reverse order would leave a trashed session
behind an `active` record, which no later read could explain. The move is what removes the member from the
host's own discovery, since session-query drops an artifact that no longer exists. Nothing is deleted: the
cross-device fallback is the only branch that removes the source, and when no artifact can be moved the
workspace archive hides the Session (`archived: true`, `trashState: 'none'`, and the intended trash fields
are dropped); the record and the result say which of the two happened.

Restoration is the inverse and equally explicit: the record keeps the original path and the artifact
kind (`trashKind` — the Session directory or a single artifact file), so `restore_member` is a move
rather than a guess, and its result says which branch ran: the move back, the workspace unhide, or a
record that was already active. It never overwrites an existing destination, refuses a target a live member already owns,
and leaves the record retired when the move cannot be made.

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

Two Harness facts shape retirement:

- `drainChildren(parent, [childId])` stops one child, releases its slot and residency, but the child's
  Session and the parent's `subagent/catalog` entry survive. A drained child stays listed by the stock
  `list_agents` forever, which is why our own list tool exists.
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
trashState    `pending` while the move is in flight, `done` once it landed, `none` when there was none
archived      true when no artifact could be moved and the workspace archive hid the Session instead
```

There is no other field, and in particular no `dormant` phase (§4.3) and no `briefPath`: the brief is
composed at replacement time from `assignment`, and a stored, reusable template is still P4-02.

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

| Phase \ Event | adopt | spawn (same base) | replace | message | stop | compact | retire | restore |
|---|---|---|---|---|---|---|---|---|
| `provisioning` | not produced by adoption — an adopted record starts `active` or `failed` | reserves the next generation; this row is untouched | successor starts, then this reservation is drained and tombstoned | delivered through `sendMessage`; a child that has not published yet is refused by the subagent service and the error is reported | no-op unless the child is already resident, then its turn is cancelled | refusal `not-resident` until it is resident and idle | drain, then tombstone; the artifact usually cannot be moved yet, so `trashed: false` and the archive branch decides | no-op success — there is no tombstone to invert |
| `active` | no-op — identity is the child id, so a known child is never adopted twice | reserves the next generation; this row is untouched | successor starts from the brief, then this member is drained and tombstoned | delivered; a running child sees it at its next step, an unloaded one is cold-resumed | current turn cancelled; activation, inbox and record kept | compacts in place when resident and idle; refusal `busy` while running, `not-resident` when unloaded | drain, tombstone (`pending`), move and confirm, refresh the host effects | no-op success: `restored: true, reason: 'already-active'` |
| `retired` | no-op — the tombstone holds the child id, which is what stops re-adoption | allowed: a new generation of the base starts with no replacement link (§2.3) | successor starts from the tombstone's brief; the retire half is a no-op (`reason: 'already-retired'`) | refusal `retired` | refusal `retired` | refusal — only `provisioning` and `active` are addressable | repeat: no-op success, `retired: true, drained: false, reason: 'already-retired'` | moves the artifact back, or runs the workspace unhide branch; `reason` names which one ran |
| `failed` | no-op — known child id | reserves the next generation; this row is untouched | successor starts, then this record is tombstoned | refusal `failed` — the child never started, so there is nothing to receive it | refusal `failed` | refusal — only `provisioning` and `active` are addressable | accepted and tombstoned; there is usually nothing to drain or move | no-op success — there is nothing to invert, because the record is not a tombstone |

Harness notices are the events no plugin operation can prevent:

| Phase \ Notice | the child finishes its turn | the child's turn fails | the host drains or unloads the child | the persisted Session disappears |
|---|---|---|---|---|
| `provisioning` | not applicable — the reservation precedes any turn | `failed`, with the start error in `note`; this is the only failure the plugin records | nothing observed; the reservation stands until the start resolves | retirement reports `trashed: false` with the reason, then the archive branch hides the Session |
| `active` | no durable change — no completion notice is observed; the phase stays `active` and live state reports `unloaded` | no durable change — a failure after the start is invisible here, so the record stays `active` | phase unchanged, live state `unloaded`; still messageable (cold-resumed) and retirable | retirement reports `trashed: false` and falls back to the archive; restore reports the reason and leaves the record retired |
| `retired` | ignored — there is no live child | ignored | ignored | restore refuses and the record stays retired |
| `failed` | ignored | ignored | ignored | ignored |

What the cells depend on:

- **`dormant` does not exist.** The four phases above are exactly `PHASE` in `roster.js`; live state
  (`running`, `idle`, `unloaded`) is read from the Harness at call time and never stored. A `dormant`
  phase is P4-01 work, together with the completion hook that would ever set it.
- **`replace` is one model call composed of `spawn` and `retire`.** The successor starts first in every
  cell, so a start that fails leaves the row exactly as it was, and the retire half reports
  `predecessor_retired: false` when it fails.
- **Two tools in one model turn.** Every call re-reads the roster and every mutation is one atomic
  `update` (§4.2), so the second call acts on the first one's result: `message_member` then
  `retire_member` in one turn delivers and then tombstones, the reverse order refuses with `retired`,
  and `retire_member` then `spawn_member` starts the next generation. Parallel tool calls are serialized
  by the storage table, not by the caller.
- **A retired or failed member is still a controllable record.** It is listed, retirable and
  replaceable: `retire_member` and `restore_member` look a target up in any phase. Only the operations
  that need a live child — `message_member` and `stop_member` — are narrow, and they refuse a retired or
  failed target with the typed reason `retired`, `failed` or `missing`.

Two cells are the expensive ones and are called out deliberately:

- **retire while provisioning** — the record becomes `retired` immediately, and the in-flight child is
  drained when it publishes. A member must never come back to life after retirement. `replace` on a
  provisioning member does the same to the predecessor, after the successor has started.
- **retire while active** — retirement wins over in-flight work. The record's `assignment` is the brief
  (§4.4); if the model never recorded one, the successor's prompt says so and sends it to the shared
  task board instead of inventing a summary.

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
5. **Hide.** Retired ids stop being served by the host projection exits, so every client drops the
   member, while the roster keeps the trash path for manual recovery.
6. **Report.** The result carries `retired`, `drained`, `archived`, `trashed` and — when there is one —
   `trash_path`. A repeated call is a no-op that answers
   `retired: true, drained: false, reason: 'already-retired'`.

The durable statement of the work is the member's `assignment`, set by the model with
`spawn_member.assignment` and kept current with `message_member.assignment`; it is capped at 1000
characters, so a record cannot grow without limit.

**Replace.** `spawn_member` with `replace: <target>` composes a short, self-contained prompt for the
successor: the successor's name, the predecessor's target and label, the recorded assignment, the fact
that the predecessor is gone, and a pointer to the shared team task board under the predecessor's name.
The board is not copied and not duplicated. It then runs steps 2–6 on the predecessor. **The successor
starts first and the predecessor is retired second, in the same call**: a failed start leaves the
predecessor untouched and live, and a failed retirement returns `predecessor_retired: false` with the
reason, so one more `retire_member` call recovers it. A target already retired is accepted, and its
tombstone supplies the brief. ADR 0009 records the ordering and why the alternatives were rejected.

The successor's brief is inherited work, not a copy of the predecessor's state: the successor inherits
the predecessor's `assignment` unless the model records a different one, so repeated replacement does not
thin the record out one generation at a time.

**Not built, and therefore not described as behaviour (P4-02).** There is no member-written brief and no
brief file: asking a member for one costs a model round-trip exactly when the member may be unresponsive
or already failed, so the brief is composed from the record instead. Nothing in the code reconciles an
assignment against the working tree or the task board — that check is the Lead's judgment, and the plugin
only points at the board. A stored, reusable brief template is P4-02.

### 4.5 Model-facing surface

The plugin is Host-only, so every operation it owns is a tool (ADR 0008). All of them are Lead-scoped,
and the `target` of a `list_members` row is the selector every other tool takes. `child_id` on the row
is the durable identity the host's own listings show; it is reported, not used as a second selector,
because a second addressing mode would have to be honoured by seven tools to stay consistent while the
target is already unique among addressable members. The Lead check is deliberately forgiving about the
membership projection: a live agent with no parent Session is the root agent and is treated as the Lead,
so a failed projection cannot disable every tool.

| Tool | Behaviour |
|---|---|
| `spawn_member` | Reserve the next generation of a base name and start it as a continuable child; with `replace`, start the successor from the handoff brief and retire the predecessor in the same call (§4.4). |
| `list_members` | Every member and subagent the Lead controls: this roster, adopted shipped members, and adopted subagent descendants (§4.5.1). Rows carry `target`, `child_id`, phase, generation, label, the `assignment` recorded for the member and live state, plus pressure and `compactable` while resident. |
| `message_member` | Deliver one message to a live target, and optionally replace its recorded `assignment`; a running child sees it at its next step, an unloaded continuable child is cold-resumed. A retired or failed target is refused with `reason: 'retired'` or `'failed'`, and an unknown one with `'missing'`. |
| `stop_member` | Cancel one target's current turn, keeping its activation and inbox; refuses a retired or failed target with the same typed reason as `message_member`. |
| `retire_member` | Drain, tombstone, move the session artifact to the trash and refresh the host effects (§4.4); a repeat is a no-op that answers `reason: 'already-retired'`. |
| `restore_member` | Move a trashed artifact back and return the record to `active`; the result says which branch ran, and a restore with nothing to invert is a no-op success rather than an error. |
| `compact_member` | Force one context compaction on a resident, idle target. |

The operation bodies live in `actions.js`; `index.js` owns argument validation, the Lead-only authority
check and the tool result schemas. Replacement deliberately has no tool of its own: `spawn_member` and
`message_member` gained one parameter each rather than the model learning a third name for the same job
(ADR 0009). The shipped roster tools stay enabled: they own the shared task board, and adoption makes the
members they create retirable. A future task (P2-09) can replace the task board and then disable the
shipped tool row.

#### 4.5.1 Adoption is the control surface

`ensureAdopted` (`actions.js`) is what makes the surface complete: it reads the shipped team roster and
the subagent registry, and records every unknown child as a member. The registry read is
`ctx.subagents.listDescendants(rootSessionId, signal)` (installed seam `dsh-subagent` `0.2.2-rc.1`,
`lib/index.js` lines 3181–3183 delegating to 2380–2446); child rows are
`{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`, and
`kind: 'diagnostic'` rows are skipped. Adoption is idempotent by child id, and the retired record is the
tombstone that keeps it that way, because draining a child does not remove its row from the parent's
durable catalog. Message delivery is addressed through the Lead's direct-child authority, while a
retirement proceeds even when the drain refuses. The shipped depth limit is 1, so every descendant is a
direct child; a deeper tree — possible only when that limit is raised — is refused by message delivery
and still retirable.

## 5. Harness extension points used

| Need | Mechanism |
|---|---|
| enable a shipped, disabled row | bundle patch `- id: <row>` with `disabled: false` |
| per-Agent behaviour | `agent.ctx` registrations from an `agent/created` listener, unwound on `agent/disposed` |
| tool registration | `agent.ctx.tools.register(definition)`, definition in canonical JSON Schema |
| context pressure | `ctx.tokenMeter.contextPressure(session)` |
| compaction | `ctx.get('compaction').compactNow(agent, signal)` |
| membership test | `ctx.agentTeams.tryMembership(agent)` (v0.1 only) |
| child lifecycle | `ctx.subagents.startActivation`, `sendMessage`, `interrupt`, `drainChildren` |
| list every subagent descendant | `ctx.subagents.listDescendants(rootSessionId, signal)`; rows carry `id`, `mode`, `label?`, `parentId` and `depth` |
| durable plugin state | `ctx.storageDomain`, not session events (ADR 0003) |
| hide a Session whose artifact could not be moved | `ctx.workspaceRegistry.archiveSession` / `unarchiveSession` (reversible, deletes nothing; the fallback branch of retirement and restore) |
| make clients drop a retired member | wrap `sessionController` list/projection/stream exits (ADR 0004) |
| credit the shipped roster budget | patch the legacy roster's `maxMembers` getter and `spawn` (ADR 0004) |
| move a retired session aside | `ctx.get('sessionPersistence').stat(id).location.path` + a rename into the trash |

## 6. Risks and limits

- **No in-app view.** The roster is visible to the model through `list_members` only; there is no
  Settings page. The host's own subagent pickers still render what they always did, minus retired ids
  (ADR 0008).
- **Two rosters during migration.** Until P2-07 lands, the shipped roster and ours can both be visible
  to the model. The patch step is part of the phase gate, not an afterthought.
- **No true erasure.** A retired member's Session stays on disk and the shipped catalog still knows it
  existed. Retirement is a lifecycle fact in our roster, not a filesystem deletion.
- **Harness API drift.** Every Service named here is read from an installed asar whose version moves;
  a Harness upgrade can invalidate this document without any change in this repository. The installed
  subagent seam is a different generation from the public source tree: the public tree has member names
  and `resolveName`, the installed build does not. Read the installed `lib/index.js` before trusting a
  public example.
- **The handoff is only as good as the recorded assignment.** The plugin cannot read the shared task
  board or the predecessor's transcript, so the successor's brief is composed from the record. A member
  whose assignment was never recorded hands over a label and a pointer to the board, not a summary.
- **Compaction is profile-wide.** Enabling the backend changes behaviour for every session in the
  profile. It is a shipped feature turned on, not custom code, but it is not scoped to this plugin's
  members.
