# Architecture

> Owner: @FrozenYty · Revisit when: a Harness upgrade changes a Service this plugin uses

What the plugin is, what each release added, the Harness substrate it builds on, the surface it
publishes, and its risks. The subjects that used to sit here by adjacency have their own documents: a
member's life is `docs/member-lifecycle-en.md`, the work board `docs/task-board-en.md`, the brief and
its template `docs/handoff-en.md`, and the stored record with its retention `docs/roster-storage-en.md`.
The decisions behind the design live in `docs/adr/`; this file describes the result and the layers.

## 1. What the plugin is

A DeepSeek Harness **profile bundle**. Installing it does three things:

1. selects a shipped plugin row that the profile leaves disabled (`compaction-basic`);
2. inserts one Host plugin of our own (`dsh-team`);
3. disables the shipped model-facing team tool row (`tool-agent-team`), whose tools this plugin replaces
   (P2-07, §2.3, §5).

There is no build step and no runtime dependency: the installed Harness resolves the shipped row from
its own installation, and our entry imports nothing (ADR 0002). The bundle is Host-only: it has no
browser half (ADR 0008).

The shipped team *service* row (`agent-team`) is deliberately not touched: adoption (§5.1) and the
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
- **v0.2** — the owned roster: spawn, message, stop, retire and restore (§5), the retirement protocol
  and its handoff (`docs/member-lifecycle-en.md` §3), the trash move (`docs/member-lifecycle-en.md` §4), and the two optional host-side effects a retirement
  refreshes (§2.4).
- **v0.4** — the model-only surface (ADR 0008): the Settings panel and its HTTP bridge were deleted, and
  adoption grew to cover every descendant a Lead controls (§5.1).
- **v0.7–v0.8** — the trash is bounded per Lead, and the bound is the bundle's `trashLimit` config field
  (`docs/member-lifecycle-en.md` §4, ADR 0011, ADR 0012).
- **v0.9** — ephemeral members: a member can be marked one-shot at spawn, and a lazy sweep in the roster
  operations the model calls anyway retires it once it has run and stopped (`docs/member-lifecycle-en.md` §2, ADR 0013).
- **v0.10** — the rename: the package, the patch row's `name` and the display title became
  `dsh-team` / *Team*, while the storage domain, the patch row id and the trash directory kept
  their pre-rename names (§1, ADR 0014).
- **v0.11** — a stored, reusable handoff-brief template per Lead, set through one tool, which the
  replacement handoff composes the successor's brief from (`docs/member-lifecycle-en.md` §3, `docs/architecture-en.md` §5, ADR 0015).
- **v0.12** — a member can start with its own working directory, model route or agent preset, a start
  the Harness refuses is a typed result, and a refusal for a stale target names the live holder of its
  name (§4, `docs/member-lifecycle-en.md` §1, §3, `docs/architecture-en.md` §5, ADR 0016).
- **v0.13** — the plugin owns the work, not only the member: a task board on the Lead's roster record,
  a replacement that hands the predecessor's open tasks to the successor, and a retirement without a
  successor that leaves them unowned and names them (`docs/roster-storage-en.md` §1, `docs/task-board-en.md` §2, `docs/member-lifecycle-en.md` §3, `docs/architecture-en.md` §5, ADR 0017).
- **v0.14** — the shipped team tool row is retired: the bundle patch disables `tool-agent-team`, so the
  row's `spawn_teammate`, `wait_agent` and `team_task_*` tools stop being registered and this plugin's own
  tools serve the Lead. Three model-facing tools the kept `agent-team` service publishes — `list_agents`,
  `send_message`, `interrupt_agent` — remain (§1, §2.3, §5, §8).
- **v0.15** — the blocking wait returns on this plugin's own surface: `wait_members` observes the Harness's
  `agent/status` for the child Sessions on this Lead's roster, which the disabled row's `wait_agent` used to
  cover and the shipped service cannot see (§5).
- **v0.16** — a member can be defined on disk: `spawn_member.definition` reads a flat-frontmatter markdown
  file under `team/` in the Lead's working directory, the call's own arguments win over the file's, and the
  result reports which parts came from where (§5, §6, ADR 0018).
- **v0.19** — the team scope gets the other half of that split: one optional `team/team.md` beside the
  member definitions, whose body is the handoff-brief template. The effective template is the file, then
  the stored template, then the built-in; the read form reports which source is in effect, and a
  `handoff_template` write or clear is refused while the file exists (`docs/member-lifecycle-en.md` §3, `docs/architecture-en.md` §5, `docs/handoff-en.md` §2, ADR 0021).
- **v0.20** — the member scope gets the read a task's body was for: `list_my_tasks`, a read-only tool
  registered on a member Agent, returns only the rows whose `owner` is that member's own target. The
  Lead's tool set is unchanged, the board keeps one writer, and the brief's `{task_board}` pointer names
  this plugin's board and this tool instead of the shipped board (`docs/member-lifecycle-en.md` §3, `docs/architecture-en.md` §5, §5.2, ADR 0022).
- **v0.22** — a member is started on the API of the Session that started it: `spawn_member` resolves the
  Lead's current `provider` and `model` and forwards them, records the route on the member, and
  `list_members` flags a member whose route is no longer the Lead's. Every failure to resolve is a
  recorded fallback, never a failed spawn, and `reasoningEffort` is never forwarded (§2.5, `docs/roster-storage-en.md` §1, `docs/architecture-en.md` §5,
  ADR 0024).
- **v0.24** — the three host hooks install when the service they wrap exists rather than when the plugin
  loads, so a row that activates before the Web layer no longer loses the feature for the life of the
  process; the shipped `list_agents` read loses a retired member too; and `list_members` reports
  `host_hooks`, so an absent hook is a typed answer (§2.4, §5, ADR 0025).
- **v0.25** — a member's lifetime is declared on the spawn call: `standing` is a role and is never retired
  automatically, `one-shot` is the fan-out case and is retired by the lazy sweep only once it has run,
  stopped and owns no open task. The board can veto a sweep and never trigger one, a standing member's
  retirement needs the person's words quoted back, a message re-opens a one-shot member instead of
  re-declaring it, and a definition file can no longer declare a lifetime at all (`docs/roster-storage-en.md` §1, `docs/member-lifecycle-en.md` §2, `docs/architecture-en.md` §6.1,
  §5, §6, ADR 0026).
- **v0.25.1** — the consent gate narrows to what a standing member still carries: a recorded assignment, an
  open row on this Lead's board, or evidence it was re-tasked. A standing member carrying none of the three
  is housekeeping, which the Lead clears in one call on a stated `reason`; both refusals say which rule
  stopped the call (`needs-confirmation` with `carries`, or `needs-reason` with `carries: []`), and the
  re-task counters that the third carrier rests on are now written for every member (`docs/roster-storage-en.md` §1, `docs/member-lifecycle-en.md` §2, §3,
  §5, ADR 0026).

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

v0.1 shipped the context tools; §5 owns their current rows. Every Lead-scoped tool registers on the
exact Agent context of a Team Lead (`agent/created`), and unwinds on `agent/disposed`. No official tool
name is shadowed and no session event is written.

`member_context` existed in v0.1 and was removed: its rows duplicated `list_members`, and it read the
shipped roster rather than this plugin's.

Measured limitation that shapes the design: a local child is unloaded when it goes idle, and
`compactNow()` requires a resident idle Agent. A finished teammate therefore cannot be compacted on
demand; waking it with a message and letting automatic compaction run at its next step is the durable
path.

### 2.3 Own roster tools

v0.2 shipped the owned roster and its tools. §5 owns the tool surface, `docs/member-lifecycle-en.md`
§3 the retirement protocol, §5.1 adoption, and `docs/roster-storage-en.md` §1 the record those tools
read and write.

Adoption (§5.1) is what makes `retire_member`, `message_member` and `stop_member` apply to children
this plugin never spawned — exactly the population that was invisible before. A one-shot child is
adopted like any other and can be stopped or retired; it cannot be cold-resumed, so `message_member`
reaches it only while it is resident.

Records live in one `roster.json` file per workspace (ADR 0027), and the host storage domain is retired as a
source of answers and is not opened at all (ADR 0031, ADR 0033). Naming rule:
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

The **work** never coexisted: since v0.13.0 the tasks a replacement hands over are rows on this
Lead's own board (`task_board`), stored beside the roster record, and the plugin's handover no
longer reads or points at the shipped board (`docs/task-board-en.md` §2). The shipped board's
existing rows are not migrated and not readable by this plugin — and since v0.14.0 the tools that
could reach them are gone, so a Lead that wants them back re-creates them on the owned board (ADR
0017).

### 2.4 Host-side effects

Three effects make a retirement visible to clients, make this plugin's members visible in the shipped team
panel and the shipped `list_agents` tool, and keep the shipped member budget usable. Each is gated on the
service it wraps through `ctx.inject`, so a service published *after* this plugin activates — the normal
case for `sessionController`, which needs the Web layer — still gets its effect; each restores exactly what
it replaced on plugin unload, and none writes to the Lead Session (ADR 0004, ADR 0023, ADR 0025).

| Effect | Mechanism | Behaviour when the host shape is absent |
|---|---|---|
| Projection filter | wraps `sessionController.list` / `projections` / `control` / `follow`; strips retired ids from `subagentCatalog` and `agentTeam` frames, then appends this Lead's live members to the same `agentTeam` value | the hook waits for the service and reports `panel_filter: absent`; retirement still works, clients keep rendering the member and never see this plugin's |
| Shipped roster read | replaces `agentTeams.listMembers`, synchronously dropping a row whose id is a retired child id, so the shipped `list_agents` tool answers without them | reports `roster_filter: absent`; `list_agents` keeps a retired member |
| Slot credit | replaces the legacy roster's `maxMembers` getter and wraps `spawn`, adding the retired count of the spawning Lead for the duration of that spawn | reports `slot_credit: absent`; retirement still works, the shipped budget stays consumed |

One tombstone set serves all three. `retire_member` and `restore_member` invalidate it in the call that
writes the record, so a retirement cannot linger behind the two-second cache; a read that fails keeps the
last good set in force and is reported as `tombstone_read_failed`, instead of emptying the set and serving
every row as the first version did. The projection filter's live rows are read synchronously from the
roster table, because they change with a spawn and a cache would only add a stale window; the shipped
roster read does the same, because its caller maps the array without awaiting it and a cached or async
answer would either be stale or change the method's return type.

**The installed state is part of the tool surface.** `list_members` always answers `host_hooks`, declared
in that tool's output schema, naming each hook as `installed` or `absent`, the number of tombstoned ids the
installed filters are stripping (`stripped_ids`), whether the last tombstone read failed, and a `message`
that names an absent hook and the service it needed. A hook that can never install is therefore a typed
answer, not an empty panel with no explanation (ADR 0025).

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

### 2.5 Costs and model routes

**The plugin states the route, and reports the ones that fell behind.** `spawn_member` resolves the calling
Lead's current provider and model from `caller.session.requestHeader()?.config` — the seam's own
inheritance source (`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:49-62`) — and forwards them as the
activation request's `agentOptions`, so the child is started on the API of the Session that started it and
the plugin, not the seam's implicit fallback, is what names it (ADR 0024). `spawn_options.agent_options`
from the caller still wins field by field, and a field the caller named is completed from the same read so
the route recorded on the member is the whole route the child runs on. **`reasoning_effort` is never
forwarded**: the seam drops the parent's effort only when the route it resolved differs from the parent's
(`:88-90`), and forwarding the parent's own route is the case where it does not differ, so the Lead's effort
survives the merge without being sent; the shipped tool's route preflight is not on this path
(`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`), so a forced effort the route does not support would
fail the child's first request after the member is already recorded as started.

**Every resolution failure is a fallback.** A Session whose header cannot be read (`no-session-route`) and a
provider that does not advertise `agentOptions` (`capability-absent`, the gate at
`@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`) both forward nothing, record `source: 'inherited'` with
that reason, and let the Harness inherit exactly as it did before this release. The reason is recorded
because the two fallbacks are different operational facts, and only one of them is about this profile's
configuration.

The member's route is recorded at spawn and compared at read time: `list_members` reports each row's
`route` and marks `route_stale: true` with a `route_note` when the member's route is not the Lead's
current one. Nothing re-routes a live member — its route lives in its own recorded `request/header`
— so the remedy is a replacement, which starts a successor on the current route and hands over its
open work (`docs/member-lifecycle-en.md` §3, ADR 0024).

The Session route allowlist belongs to the shipped tool (`@deepseek-ai/dsh-tool-subagent/lib/index.js:89-96`),
which this plugin does not use: what is forwarded here is the route the Session is already issuing requests
on, so it is proven rather than proposed and needs no preflight. The installed measured picture — 18 of 60
session logs still on `deepseek-official/deepseek-flash` after the relay switch, several of them members —
is what this section exists to answer.

The bundle makes no LLM call, and the `compaction-basic` row it enables summarises on the session's own route
(`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`, §2.1). The measured exception is web search,
outside this plugin: the base bundle's patch selects `searchProvider: deepseek-official`
(`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`), and `dsh-web-search-deepseek` pins its endpoint and model
(`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`, `:319-320`) and requires a
`web_search_tool_result` answer (`:61-62`). No session route reaches it; a profile either disables that row or
points it at an endpoint that executes native search. The user-facing statement is in `docs/routes-en.md`.

## 3. Why the shipped roster is not extended

The shipped roster is a fold over the Lead Session's append-only event log. Member phases are
`provisioning | active | failed`; the projection rejects any transition out of a terminal phase, and a
rejected event is recorded as a permanent `failure` that disables the Team service for that Lead. A
synthetic “retired” record therefore does not fail safely. `maxMembers` is checked against a list that
never shrinks, names are never reused, and upstream's redesign still defers deletion.

The full argument, with the alternative we rejected, is ADR 0001.

## 4. The substrate: what the Harness provides

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
through `spawn_member.spawn_options` (§5): `cwd`, `agentOptions` and `agentPreset`, and plus the route it
resolved itself when the caller named none (§2.5, ADR 0024). Every field omitted means the member inherits
the Lead's value, and one exception is recorded here because the rule reads as total without it: a changed
`provider` or `model` without `reasoningEffort` lets the new route resolve its own default rather than
inheriting the Lead's effort. Here the Lead's value is the Lead's current route — resolved at each spawn from
the Session's latest logged request header, not from the options the Lead Agent was created with (§2.5).
Only a spawn whose route could not be resolved (or whose provider cannot apply one) composes exactly the
request it always did — a test pins the exact object for that path. `cwd` is forwarded verbatim: the seam
resolves a relative path against the parent's cwd (`resolveDirectory`), and a child keeps the parent's
permission roots, so a directory outside the sandbox grant stays denied; a plugin that pre-resolved the path
would disagree with the Host. The two capability gates belong to the provider: `agentOptions` requires
`provider.capabilities.agentOptions` and `agentPreset` requires `provider.capabilities.agentPreset` —
true for the in-process spawn/fork providers and false for every external backend, whose advertisement is
`NO_START_CAPABILITIES` — and both are asserted before the manager reserves anything; the plugin's own probe
of the first gate is what turns a would-be refusal into the inherit path. Three facts about the Harness shape
this surface and are recorded because a reader will not expect them: there is **no per-call tool allow/deny**,
so `agentPreset` is the only route to a tool-restricted or read-only member and the seam rejects `toolFilter`
outright; **a preset id must be declared by the profile's bundle patches**, because the registry neither
scans directories nor accepts a path; and **there is no worktree field**, so a worktree is
`ctx.worktrees.create(...)` followed by forwarding its `path` as `cwd`, with that service optional and
experimental enough that this plugin does not create one itself (ADR 0016).

Two Harness facts shape retirement:

- `drainChildren(parent, [childId])` stops one child, releases its slot and residency, but the child's
  Session and the parent's `subagent/catalog` entry survive. A drained child stays in the shipped
  roster's own listing forever, which is why our own list tool exists.
- `ctx.workspaceRegistry.archiveSession` hides a Session from every workspace surface. It is reversible
  and deletes nothing, which makes it the fallback for a retired member whose artifact could not be
  moved.

## 5. Model-facing surface

The plugin is Host-only, so every operation it owns is a tool (ADR 0008). Ten are Lead-scoped, and the
`target` of a `list_members` row is the selector every member-scoped Lead tool takes (`handoff_template`
takes no target: it acts on the Lead's own record). One is member-scoped and read-only, `list_my_tasks`:
it registers on a member Agent rather than the Lead's, and §5.2 is the authority model for both scopes.
`child_id` on the row is the durable identity the host's own listings show; it is reported, not used as a
second selector, because a second addressing mode would have to be honoured by every member-scoped tool to
stay consistent while the target is already unique among addressable members. The Lead check is
deliberately forgiving about the membership projection: a live agent with no parent Session is the root
agent and is treated as the Lead, so a failed projection cannot disable every tool.

| Tool | Behaviour |
|---|---|
| `spawn_member` | Reserve the next generation of a base name and start it as a continuable child; with `definition`, start it from a member definition committed with the project, whose fields fill whatever the call omitted (§6); with `replace`, start the successor from the handoff brief, hand the predecessor's open tasks to it, and retire the predecessor in the same call (`docs/member-lifecycle-en.md` §3, `docs/task-board-en.md` §2). `lifetime` declares how long the member lives — `standing` (the default) or `one-shot`; `ephemeral: true` is the pre-v0.25 spelling of `one-shot` — and it is this call's alone: never the predecessor's, never the file's (`docs/member-lifecycle-en.md` §2, ADR 0026). `spawn_options` (optional) starts it with its own `cwd`, `agent_options` (`provider`, `model`, `reasoning_effort`, `max_tokens`) or `agent_preset`; an omitted field inherits the Lead's value — except that a changed `provider` or `model` without `reasoning_effort` lets the new route resolve its own default. A spawn that names no `agent_options` still runs on this Session's route: the plugin resolves the Lead's current `provider` and `model` and forwards them, so the member uses the API of the Session that started it, and `started_with.route_source` says whether the route came from the call (`caller`), was resolved by the plugin (`plugin`) or was inherited unresolved (`inherited`, with `route.select_reason` naming which fallback ran); `started_with` reports back what the plugin forwarded, not what the child resolved (`docs/architecture-en.md` §2.5, ADR 0024). A start the Harness refuses is a typed result (`started: false`, with a `reason` naming the way out), never a host error, and a definition that cannot be read is answered the same way (ADR 0016, ADR 0018). A one-shot member is retired by the sweep once it has run, stopped and owns no open task, and the call first sweeps any member already in that state (`docs/member-lifecycle-en.md` §2). |
| `list_members` | Every member and subagent the Lead controls: this roster, adopted shipped members, and adopted subagent descendants (§5.1). Rows carry `target`, `child_id`, phase, generation, label, the `assignment` recorded for the member, the `lifetime` its spawn declared (`standing` or `one-shot`, with `ephemeral` beside it as the durable field), `retasked: true` and a `retasked_note` on a one-shot member handed work at least twice, the `route` the member was started on, live state and `compactable`; the pressure fields (`pressure_tokens`, `context_window`, `usage_ratio`) appear only while resident. When the Lead's own route can be read and differs from a member's recorded one, the row also carries `route_stale: true` and a `route_note` naming both routes and the one call that replaces the member (§2.5, ADR 0024). A read first sweeps one-shot members that have run, stopped and own no open task, and reports `swept` and `swept_targets` when it retired any — while a member the board's veto kept is reported through `blocked`, `blocking_tasks` and `blocking_note`, and `unowned`/`unowned_tasks` appear only if a row was created for a swept member in between (`docs/member-lifecycle-en.md` §2, `docs/task-board-en.md` §2, ADR 0026). It always carries `host_hooks`: `panel_filter`, `roster_filter` and `slot_credit` as `installed` or `absent`, `stripped_ids` and `tombstone_read_failed` while a filter is installed, and a `message` naming an absent hook, the service it needed and what that means for the shipped panel and `list_agents` (`docs/architecture-en.md` §2.4, ADR 0025). Every row carries `member_id`, the roster identity a succession link names; where a replacement created a link the row carries it in the direction that record owns — `predecessor` on the successor and `successor` on the tombstone it left, each naming a target and a member id, so the chain reads from either end and survives retirement (ADR 0032), while an id whose other end has left the roster is reported without a target. It also reports `archived_records`, the tombstones that left the roster for the append-only archive, with `archive_file` naming that file whenever the count is non-zero — so a target missing from this list may still be in the archive rather than gone (`docs/roster-storage-en.md` §3, ADR 0030). It also always carries `storage`: `source: 'file'` with the `path` of this workspace's `roster.json`, plus `imported_at` when that file was created by importing the storage domain, `foreign_write_at` when another writer changed the file, and `read_problem` while a file that could not be used is reported instead of falling back — or `source: 'none'` for a Lead this process has never bound, which the storage API can reach and production does not. Serving from the storage domain is no longer a value the schema publishes, because it can no longer happen (`docs/roster-storage-en.md` §4, ADR 0031). |
| `wait_members` | One bounded wait on the live status of this Lead's members: it answers when a member's `agent/status` transitions (`idle` ⇄ `running`) or after the timeout, and reports the member and the status it entered. The timeout defaults to 30 s and is refused above 1 h; a roster with no `running` member and no `provisioning` reservation answers `no_progress` at once, because a blocked Lead cannot wake an idle member. It observes only post-call transitions and never wakes anyone (§5). |
| `message_member` | Deliver one message to a live target, and optionally replace its recorded `assignment`; a running child sees it at its next step, an unloaded continuable child is cold-resumed. A message never changes a lifetime: messaging a one-shot member re-opens it (the finished-evidence is dropped, and the result answers `reopened: true` with the unchanged `lifetime`), so it will not be swept until it has run and stopped again (`docs/member-lifecycle-en.md` §2, ADR 0026). Every accepted message also counts itself on the member's record, for any member, because the retirement gate reads those counters (`docs/roster-storage-en.md` §1, `docs/member-lifecycle-en.md` §2). A retired or failed target is refused with `reason: 'retired'` or `'failed'`, and an unknown one with `'missing'`; when another generation of the name is live, the refusal also carries `current_holder` and says so. |
| `stop_member` | Cancel one target's current turn, keeping its activation and inbox; refuses a retired or failed target with the same typed reason as `message_member`, and carries `current_holder` the same way. |
| `retire_member` | Drain, tombstone, move the session artifact to the trash, enforce the per-Lead retention cap and refresh the host effects (`docs/member-lifecycle-en.md` §3); the result reports `pruned`, a repeat is a no-op that answers `reason: 'already-retired'`, and a stale target then names the live holder of its name. **A `standing` member is not retired by this call alone when it still carries something** — an `assignment`, an `open` row, or a re-tasking: it answers `retired: false, reason: 'needs-confirmation'` with the `question` to put to the person, `carries` naming what it found, `owns_tasks`/`assignment` when it has them, and a `message` saying what to do next; the retirement happens on the next call, which passes `confirmed` set to that person's sentence quoted verbatim, echoed back in the result. **A `standing` member that carries nothing is the Lead's to clear on a stated `reason`**, and a call that states no reason answers `reason: 'needs-reason'` with `carries: []`. A one-shot member, a successor started by `spawn_member` with `replace`, and a record in `failed` (or already `retired`) are exempt, because none of them is a role being ended by this call (`docs/member-lifecycle-en.md` §2, ADR 0026). It is a retirement with no successor, so the member's open tasks lose their owner and the result names them in `unowned`/`unowned_tasks` (`docs/task-board-en.md` §2). |
| `restore_member` | Move a trashed artifact back and return the record to `active`; the result says which branch ran, an already-active record is a no-op success rather than an error, a pruned tombstone answers `reason: 'pruned'` without touching the workspace, and a refusal carries `current_holder` when another generation of the name is live. It assigns no work: `unowned`/`unowned_tasks` report the open rows still waiting for an owner (`docs/task-board-en.md` §2). |
| `compact_member` | `ctx.compaction.compactNow(agent, signal)` on a resident, idle target, returning a structured result rather than throwing: `done`, `busy`, `not-resident`, `nothing-to-compact`, `failed`. |
| `handoff_template` | Read, store or clear this Lead's handoff-brief shape: omit `template` to read the effective one and its `source` (`file`, `stored` or `builtin`), pass a template to validate and store it, pass an empty string to clear it. The team file `team/team.md` wins while it exists, so a store or clear is refused with the file's path and the instruction to edit it; a broken file is reported by `file_problem` and does not shadow a usable stored template. A stored value that no longer passes validation is reported (`valid`, `problem`) and the composition falls back to the built-in (`docs/handoff-en.md` §2). |
| `task_board` | This Lead's own work board: `create` adds a task, `list` reads the board, `update` sets a task's `status`, `owner` and/or `body` (`owner: null` and `body: null` clear them), `release` clears an owner, `delete` removes the row (`docs/task-board-en.md` §2). One tool with an `action` enum rather than five names, because the five operations share one row shape and one refusal vocabulary and each action carries at most three extra fields. A task id is a UUID, a title is refused past 200 characters, a body is refused past 2000 and one Lead holds at most 200 tasks; a stored row whose title or body no longer passes the read rule is served with `problem` rather than dropped (`docs/roster-storage-en.md` §1). `list` reports how many tasks are open, how many of those nobody owns, and every row's body — the acceptance criteria and stopping point the brief does not carry. An id-addressed write is built from the row as stored inside the serialized mutation, so an `update` keeps a field it did not name and a `release` or `delete` whose row moved since the call read it answers `changed: false` with the row it found instead of undoing a handover (ADR 0020). |
| `list_my_tasks` | Registered on a **member** Agent, not the Lead: the read-only rows whose `owner` is this member's own target, each with its id, title, body, status, timestamps and the same read-time `problem` the Lead's board reports, plus `open` and the member's `target` (§5.2). It takes no parameter: the caller's Session is the selector. A member owning nothing gets `tasks: []` and a sentence, not an error; another member's row, an unowned row and the Lead's whole board are absent. The board has no member writer — a member reports finished work and the Lead closes the row (ADR 0022). |

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

### 5.1 Adoption is the control surface

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

### 5.2 The authority model: what a Lead sees, what a member sees, and why (v0.20.0)

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

**One writer is an invariant, not a convenience.** The board is one serialized document whose
handover is a single mutation that re-addresses rows before a tombstone (`docs/task-board-en.md`
§2), and whose `release`/`delete` actions act only on the state they read (ADR 0020). Every
transition in the transfer matrix has exactly one owner because a member never writes. Giving the
member a status change would add a second authority rule, a second compare-and-set story against the
Lead's handover, and a row whose `done` cannot be told apart from "the member said so". A member's
report and the Lead's transition are two different facts, and the round-trip that keeps them apart
is cheaper than the ambiguity that removes it.

**The registration follows the Agent, like the Lead's.** `installMember` registers on the member Agent's
own `agent.ctx` at load and on `agent/created`, and `agent/disposed` and plugin unload remove it. The
`target` a member reads under is resolved at call time, so registration can cover every non-root Agent
while the answer stays as narrow as the roster row that names it.

## 6. Member definitions (v0.16.0)

A member used to exist only as a tool call: its prompt, label and assignment lived in that call and in the
Lead's roster record, so a team could not be reviewed, versioned or shared, and the same "reviewer" was
retyped every session. A definition moves the member out of the call and onto disk — one markdown file per
member, read from the workspace's `.agents/team/definitions/` or its `team/` directory, or from the five
templates this bundle ships — while the roster stays runtime state (ADR 0018, ADR 0029).

**The path.** A definition is read from a chain of three directories, most specific first:
`<Lead working directory>/.agents/team/definitions`, then `<Lead working directory>/team`, then the five
templates in `templates/definitions` inside the bundle. The first declaration of a name wins, a name
declared twice in **one** directory is still refused naming both files, and a malformed file blocks only
the name it claims (ADR 0029). Both workspace directories are resolved through the `workingDirectory`
service: `ctx.get('workingDirectory').ensure(leadAgent, signal)` (§7). That is the same service and method
the installed spawn seam uses for a relative `request.cwd`, so a definition is read from exactly the
directory `spawn_options.cwd` resolves against. The service is optional and read with `ctx.get`, like
`compaction`; a profile that mounts none, or whose `ensure` rejects, is a typed refusal
(`reason: "working-directory-unavailable"`) rather than a guess at a directory. **The team file is not
part of that chain:** it stays at `<Lead working directory>/team/team.md` (ADR 0021), because it is not a
member definition and has no shipped counterpart — `.agents/team/` holds the roster file and the
definitions the plugin owns, `team/` holds the project's own team file (ADR 0029).

**The file.** `---` on line 1, a flat frontmatter block, `---`, then the markdown body, which is the
member's prompt. The accepted fields are exactly the inputs `spawn_member` already has that describe
the role: `name` and `label` required, then `assignment`, `cwd`, `provider`, `model`,
`reasoning_effort`, `max_tokens` and `agent_preset`. **`lifetime` is not among them**, and
`ephemeral` was removed in v0.25.0: a lifetime is a declaration about one member and the person's
consent to it leaving on its own, so it is made on the spawn call and never inherited from a file
(`docs/member-lifecycle-en.md` §2, `docs/architecture-en.md` §6.1, ADR 0026). The file's *name* is
not an identity — the definition declares `name`, which is also the key `spawn_member.definition`
looks up — and a field with no counterpart on the call is out of scope.

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

### 6.1 A definition across spawn, replace and message (v0.17.0)

A definition is read at one moment — the spawn that names it — and every field it carries then lives on a
record, on a live child, or nowhere. `name`, `label` and `prompt` follow the precedence rule in §6; the
table below is every other accepted field, because each of them can surprise whoever wrote the file and
did not read the call. One cell per field, and each cell answers the same three questions: what the file
contributes at that event, what the call may override, and what the effect is. The events are the three
`docs/member-lifecycle-en.md` §1 already names: `spawn` (no `replace`), `replace`, and `message` (`message_member`).

**`message_member` never reads the file.** A message acts on a member that already started, so a
definition contributes nothing there: the only field a message can still reach is the assignment it
records, and no field of the file is consulted again until a later `spawn_member` reads it for another
member.

| Field | `spawn` (no replace) | `replace` | `message` |
|---|---|---|---|
| `assignment` | file: supplies the durable assignment; call: an explicit `assignment` on the call overrides it; effect: the record carries it and `list_members` reports it. | file: supplies it **only when the predecessor recorded none**; call: an explicit assignment on the call wins over both, and the predecessor's recorded assignment wins over the file's; effect: the successor is briefed with the work rather than the role's standing sentence, and the result names the winner in `definition.assignment` (`call`, `predecessor` or `file`). | file: read for nothing; call: `message_member.assignment` replaces the recorded assignment once the message is accepted; effect: this member's next successor is briefed with the new text. |
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
- **A lifetime is not in this matrix at all, and that is the decision.** `lifetime` has no row because the
  file cannot declare one: it was removed from the accepted field set in v0.25.0, and a file that carries
  `ephemeral` or `lifetime` is refused by name with the reason and the alternative (ADR 0026). ADR 0019
  point 3 had the file describe the role's lifetime, and the consequence it accepted — a one-shot successor
  orphaned the work a replacement had just moved to it — is the one the owner's rule forbids, so the field
  left the file rather than getting another consequence written down.
- **The predecessor's `cwd` and model route are not inherited, and cannot be.** They are start options,
  not record fields: `started_with` is a receipt on a tool result, not durable state (`docs/roster-storage-en.md` §1), so a
  successor takes the file's, the call's or — for the route — the one the plugin resolves from the Lead's
  current Session, and nothing else (§2.5, ADR 0024). A Lead that wants the successor in the
  predecessor's directory passes it.
- **The transfer matrix (`docs/task-board-en.md` §2) is unchanged by any of this.** A replacement still moves the
  predecessor's open tasks in the same call, whatever the file says; the lifetime is the spawn call's, and
  the ownership the transfer writes is what vetoes a sweep of the successor (`docs/member-lifecycle-en.md` §2).

## 7. Harness extension points used

| Need | Mechanism |
|---|---|
| enable a shipped, disabled row | bundle patch `- id: <row>` with `disabled: false` |
| per-Agent behaviour | `agent.ctx` registrations from an `agent/created` listener, unwound on `agent/disposed` |
| tool registration | `agent.ctx.tools.register(definition)`, definition in canonical JSON Schema |
| context pressure | `ctx.tokenMeter.contextPressure(session)` |
| compaction | `ctx.get('compaction').compactNow(agent, signal)` |
| membership test | `ctx.agentTeams.tryMembership(agent)` |
| child lifecycle | `ctx.subagents.startActivation`, `sendMessage`, `interrupt`, `drainChildren` |
| start a member with its own directory, model route or preset | `request.cwd` / `request.agentOptions` / `request.agentPreset` on `ctx.subagents.startActivation`; gated by the provider's advertised capabilities, and tool restriction has no other route than an agent preset (§4, ADR 0016) |
| list every subagent descendant | `ctx.subagents.listDescendants(rootSessionId, signal)`; rows carry `id`, `mode`, `label?`, `parentId` and `depth` |
| notice that a child stopped | `subagent/end` (published when a run settles) and the `idle` edge of `agent/status`; neither is durable, so the one-shot sweep still carries its own evidence (`docs/member-lifecycle-en.md` §2, ADR 0013, ADR 0026) |
| wait on a member's live status | `ctx.on('agent/status', ({ agent, status }))` from the plugin's own context, filtered by the child ids this roster holds; the dispatch is scope-filtered and an unscoped listener is admitted to it (§5) |
| durable plugin state | files the plugin owns under the workspace root, not session events (ADR 0027, ADR 0033) |
| resolve the Lead's working directory, the `team/` the team file is read from, and the chain a member definition is read from | `ctx.get('workingDirectory').ensure(agent, signal)` — the same service and method the spawn seam uses to resolve a relative `cwd`; optional, so a profile without it refuses a definition spawn and cannot see a team file, instead of guessing a directory (§6, `docs/handoff-en.md` §2, ADR 0018, ADR 0021, ADR 0029) |
| hide a Session whose artifact could not be moved | `ctx.workspaceRegistry.archiveSession` / `unarchiveSession` (reversible, deletes nothing; the fallback branch of retirement and restore) |
| make clients drop a retired member | wrap `sessionController` list/projection/stream exits (ADR 0004) |
| make the shipped team panel list this plugin's live members | the same exits: append the four-field member row to the outgoing `agentTeam` value (ADR 0023) |
| make the shipped `list_agents` read drop a retired member | replace `agentTeams.listMembers` with a synchronous wrapper over the same tombstone set (ADR 0025) |
| run a host hook only once the service it wraps exists | `ctx.inject([service], callback)`: the callback installs, its returned disposer unwinds, and Cordis unloads/re-runs it when the service is replaced (ADR 0025) |
| credit the shipped roster budget | patch the legacy roster's `maxMembers` getter and `spawn` (ADR 0004) |
| move a retired session aside | `ctx.get('sessionPersistence').stat(id).location.path` + a rename into the trash |

## 8. Risks and limits

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
- **The shipped task board is out of reach.** A Lead's work lives on the owned board (`docs/task-board-en.md` §2); rows on the
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
  The route is the one of the three the plugin also *resolves*: when the caller names none, the Lead's
  current provider and model are read from the Session's own request header — the seam's inheritance
  source, not a guess at what route works — and a profile that cannot produce one inherits instead
  (§2.5, ADR 0024).
- **Harness API drift.** Every Service named here is read from an installed asar whose version moves;
  a Harness upgrade can invalidate this document without any change in this repository. The installed
  subagent seam is a different generation from the public source tree: the public tree has member names
  and `resolveName`, the installed build does not. Read the installed `lib/index.js` before trusting a
  public example.
- **The handoff is only as good as the recorded assignment and the board it names.** The plugin cannot read
  the shipped task board or the predecessor's transcript, so the successor's brief is composed from the
  record and from this plugin's own task rows (`docs/task-board-en.md` §2). A member whose assignment was never recorded, and
  whose board holds no open task, hands over a label and a pointer, not a summary.
- **A member definition and the team file are files this plugin only reads.** It cannot tell whether they
  are current, whether a prompt matches the work the Lead has in mind, or whether a `team/` directory or
  a `.agents/team/definitions/` one is shared by two Leads in one working directory; that is the project's
  version control, not this plugin's
  job. What it guarantees is narrower and checkable: the definitions a caller can use are exactly the
  readable `.md` files in the chain it searched that moment — the workspace's two directories and the
  shipped templates — the team file is exactly `team/team.md` under `<Lead working directory>/team/`, and
  a file it cannot read is refused by path and line rather than half-applied (§6, `docs/handoff-en.md` §2,
  ADR 0018, ADR 0021, ADR 0029).
- **Compaction is profile-wide.** Enabling the backend changes behaviour for every session in the
  profile. It is a shipped feature turned on, not custom code, but it is not scoped to this plugin's
  members.
