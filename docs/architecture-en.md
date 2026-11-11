# Architecture

> Owner: @FrozenYty · Revisit when: a Harness upgrade changes a Service this plugin uses

This document describes what the plugin is, what it does today, and the roster design being built.
The decisions behind the design live in `docs/adr/`; this file describes the result.

## 1. What the plugin is

A DeepSeek Harness **profile bundle**. Installing it does two things:

1. selects a shipped plugin row that the profile leaves disabled (`compaction-basic`);
2. inserts one Host plugin of our own (`dsh-team-roster`).

There is no build step and no runtime dependency: the installed Harness resolves the shipped row from
its own installation, and our entry imports nothing (ADR 0002).

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
| `spawn_member` | Reserves a generation-suffixed name, persists the reservation, then starts a continuable child through `ctx.subagents.startActivation` with a generated `childId` and `delivery: 'parent'`. A failed start leaves a visible `failed` record, never an invisible child. |
| `list_members` | Every record with phase, generation, live status and — while resident — context pressure. Retired members stay listed as `retired`. |
| `retire_member` | Drains the child, archives its Session through `ctx.workspaceRegistry.archiveSession`, and tombstones the record. Verified against both a finished member and a member mid-turn. |
| `message_member` | `ctx.subagents.sendMessage(caller, childId, [text], { signal })`. A running member receives it at its next step; an unloaded member is cold-resumed from its own Session. Verified live: a delivered message woke an unloaded member, which replied. |
| `stop_member` | `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: caller })`. Cancels the current turn only; the activation, slot and inbox are kept. Verified live: a member running a long command was interrupted and left no closing message. |

**Adoption.** Members the shipped roster created are adopted into this roster the first time it is read:
the record reuses the child Session id as its identity, keeps the shipped name, and starts `active`. So
`retire_member`, `message_member` and `stop_member` apply to members this plugin never spawned — which is
exactly the population that could not be removed before. Adoption is idempotent, matched by child id.

Records live in one `storageDomain` domain keyed by the Lead Session id (ADR 0003). Naming rule:
generation 1 is the bare base name; generation 2 and later is `<base>-g<N>`, so a replacement never
collides with a retired name. Spawning the same base name after a retirement is the replace operation:
`probe-a` retired, `probe-a-g2` started, both recorded.

The shipped team roster and this roster coexist until P2-07 disables the shipped tool row. `list_agents`
reports one; `list_members` reports the other. They are different sets.

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

`retire_member` drains the child, moves its persisted Session into
`~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`, tombstones the record with that path, and
refreshes the two effects above. The move is what removes the member from the host's own discovery, since
session-query drops an artifact that no longer exists. Nothing is deleted: the cross-device fallback is
the only branch that removes the source, and the workspace archive hides the Session when no artifact can
be moved.

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
  and deletes nothing, which makes it exactly right for a retired member.

### 4.2 Roster record

One durable record per member, kept in a plugin-owned store keyed by the Lead Session id (the exact
service is chosen in P2-01; ADR follows).

```
memberId      stable identity, generated by this plugin
name          model-facing name, unique within the Lead's roster
generation    1 for the first holder of a name, 2 for its successor, ...
childId       the subagent Session id, or absent while provisioning
phase         provisioning | active | dormant | retired | failed
label         the responsibility text shown to the model
createdAt     ISO timestamp
retiredAt     ISO timestamp, present only when phase = retired
briefPath     handoff brief written by the retiring member, when one exists
predecessor   memberId this member replaced, when it is a successor
```

`name` is unique among **current** members. A successor reuses the name with `generation + 1`, which
the shipped roster cannot do because it treats a name as permanently taken. Records live in one
`storageDomain` domain, not in the Session log (ADR 0003): one record per member id, plus a
per-Lead index keyed by the Lead Session id.

### 4.3 State matrix

Every cell is decided before implementation (AGENTS.md §4.8). Events are plugin operations and Harness
notices; a dash means the event is rejected with a typed reason.

| Phase \ Event | spawn | message | stop | retire | child completes | child fails |
|---|---|---|---|---|---|---|
| provisioning | reject | queue until active | reject | mark retired, drain | `active` | `failed` |
| active | reject | deliver | `active` (turn stopped) | `retired` + drain | `dormant` | `failed` |
| dormant | reject | deliver, becomes `active` | no-op | `retired` | not applicable | not applicable |
| retired | reject | reject, typed reason | no-op | no-op | ignore | ignore |
| failed | reject | reject, typed reason | no-op | `retired` | ignore | ignore |

`dormant` is deferred to P4-01: the shipped implementation keeps `active` as the lifecycle phase and
reports live state (`running`, `idle`, `unloaded`) separately, so an unloaded member is visible without a
second durable phase.

Two cells are the expensive ones and are called out deliberately:

- **retire while provisioning** — the record becomes `retired` and the in-flight child is drained when
  it publishes. A member must never come back to life after retirement.
- **retire while active** — retirement wins over in-flight work. The member writes its brief first, and
  if it is too degraded to do so the Lead writes it (see 4.4).

### 4.4 Retire and replace

Retirement is a protocol, not a deletion, because a member's Session is durable and its work may be
half-finished:

1. **Brief.** The member is asked for a bounded, fixed-schema handoff brief — goal, done, in progress,
   next action, files, and what the successor must not redo — written to a path the Lead can read. If
   the member is unresponsive, degraded, or already failed, the Lead writes the brief instead. A third
   summarizer is never introduced.
2. **Reconcile.** The Lead compares the brief against the roster and the working tree before trusting
   it; a brief that contradicts the repository is a finding, not a plan.
3. **Drain.** The child is drained through `ctx.subagents.drainChildren(lead, [childId])`, releasing its
   activation slot and residency.
4. **Move and tombstone.** The persisted Session moves into the plugin's trash directory, and the record
   moves to `retired` carrying that path. The workspace archive is the fallback when no artifact can be
   moved.
5. **Hide.** Retired ids stop being served by the host projection exits, so every client drops the member,
   while the roster keeps the trash path for manual recovery.
6. **Replace (optional).** A successor is spawned with a pointer to the brief — never with the
   predecessor's transcript — and a read-back gate before it edits anything.

### 4.5 Model-facing surface

Shipped: `spawn_member`, `list_members`, `message_member`, `stop_member`, `retire_member` (P2-03, P2-04,
P2-06), beside `compact_member` and the shipped task-board tools. The shipped roster tools stay enabled:
they own the shared task board, and adoption makes the members they create retirable. A future task
(P2-09) can replace the task board and then disable the shipped tool row.

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
| durable plugin state | `ctx.storageDomain`, not session events (ADR 0003) |
| hide a retired child | `ctx.workspaceRegistry.archiveSession` (reversible, deletes nothing) |
| make clients drop a retired member | wrap `sessionController` list/projection/stream exits (ADR 0004) |
| credit the shipped roster budget | patch the legacy roster's `maxMembers` getter and `spawn` (ADR 0004) |
| move a retired session aside | `ctx.get('sessionPersistence').stat(id).location.path` + a rename into the trash |

## 6. Risks and limits

- **Two rosters during migration.** Until P2-07 lands, the shipped roster and ours can both be visible
  to the model. The patch step is part of the phase gate, not an afterthought.
- **No true erasure.** A retired member's Session stays on disk and the shipped catalog still knows it
  existed. Retirement is a lifecycle fact in our roster, not a filesystem deletion.
- **Harness API drift.** Every Service named here is read from an installed asar whose version moves;
  a Harness upgrade can invalidate this document without any change in this repository. The installed
  subagent seam is a different generation from the public source tree: the public tree has member names
  and `resolveName`, the installed build does not. Read the installed `lib/index.js` before trusting a
  public example.
- **Compaction is profile-wide.** Enabling the backend changes behaviour for every session in the
  profile. It is a shipped feature turned on, not custom code, but it is not scoped to this plugin's
  members.
