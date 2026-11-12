# dsh-team

[中文](README-zh.md)

> Only the person changes, not the work.

A DeepSeek Harness profile bundle for the one thing the shipped agent-team roster cannot do: let a member
go. A Lead can retire one, restore it from a trash it controls, or replace it with a successor that inherits
the assignment, what was already in flight, and a pointer to the Lead's own task board. It owns the roster
and has no browser half.

[github.com/FrozenYty/dsh-team](https://github.com/FrozenYty/dsh-team)

## What it is

One Host plugin plus one bundle patch: the patch inserts `dsh-team`, enables the shipped
`compaction-basic` row and disables the shipped `tool-agent-team` row, and the plugin imports no Harness
package, writes no session events, and keeps its state in a `storageDomain` domain keyed by Lead Session
id (ADR 0003). The shipped team *service* row (`agent-team`) stays mounted, because adoption and the
projection filter read it. The name changed in v0.10.0; the storage domain, the patch row id and the trash
directory did not, on purpose (ADR 0014).

## Status

- Current version: v0.25.1.
- **Verified live**, in the author's profile with this bundle installed: retirement, restore, message,
  stop, and a replacement whose successor finished the predecessor's task (v0.5.0, v0.6.0); the trash cap
  (v0.7.0) and the configurable cap (v0.8.0), applied and refused at load; the ephemeral sweep (v0.9.0) —
  two ephemeral members finished, the next `list_members` answered `swept: 2` with both targets, and both
  rows came back `retired`; the handoff template (v0.11.0) — a stored template carrying a unique marker,
  echoed whole by the successor with its fields substituted, an unknown placeholder refused by name, a
  template without `{assignment}` refused with the reason, and clearing it returning the built-in brief;
  `spawn_options` (v0.12.0) — a member started in the forwarded `cwd` and reporting that exact directory,
  a valid `agent_preset` running, an unknown preset id answering `started: false` with
  `reason: preset-not-found` and the declared ids, an alternate model id running and replying, and a spawn
  with no options carrying no `started_with` — the behaviour that release had, and the one v0.22.0 changes,
  since such a spawn now reports `started_with.route_source`; the task board (v0.13.2) — a task created and
  owned by a member, `spawn_member` with `replace` answering `transferred: 1` with the task id and the
  predecessor retired, the successor's brief naming that id and title, and `retire_member` with no successor
  answering `unowned: 1` with the id.
- **The cost boundary this release answers, measured on the running profile.** After the relay switch, an
  inventory of 60 session logs found 18 still on `deepseek-official/deepseek-flash` — several of them
  members of a live team, while the live Lead sessions ran on the relay — because a member's route is
  written into its own Session header at start and nothing re-routes it. v0.22.0 forwards the Lead's current
  route at spawn, records it on the member, and flags a member whose route is no longer the Lead's. The live
  half — the route on a spawned child's own `request/header` — stays the owner's install check (ADR 0024).
- **The tool surface, measured live** (v0.14.0, `listTools` read immediately before and after the
  install): the shipped row is retired, so `spawn_teammate`, `wait_agent` and the `team_task_*` tools are
  gone from a Lead's list and calling one answers `unknown tool`, while this plugin's `spawn_member` and
  `task_board` remain. Three tools are still there, and this patch cannot remove them: `list_agents`,
  `send_message` and `interrupt_agent` come from the `agent-team` *service* row, which the bundle keeps
  mounted because adoption, the membership test and the projection filter read it. `wait_agent` was the
  one tool with no equivalent here until v0.15.0; `wait_members` now replaces it, built on the Harness's
  own `agent/status` event, and it is unit-tested only — its live subscription has not run in a profile.
- **Two failures only a live install could show**, each one line, each fixed inside the release that had
  it and each now covered: v0.12.0's bundle installed and did not activate until a schema keyword was
  removed (same version; `scripts/check.mjs` now refuses that keyword), and v0.13.0's replacement answered
  with a result the host refused until v0.13.2 declared the fields (`tests/entry.test.mjs` now validates
  every answer against its own tool's declared output schema).
- **A live run found the gap this release closes.** A successor enumerated its tools, found no roster
  tool (every one was Lead-scoped), and read `~/.dsh/storages/team_roster.json` directly to discover the
  task body it had inherited. v0.20.0 registers one read-only tool in the member scope, `list_my_tasks`,
  and corrects the `{task_board}` pointer, which had named the shipped board and told the member to ask the
  Lead. The live call from inside a real member remains the owner's install check (ADR 0022).
- **Unit-tested only**, with no live profile having exercised them: the write-time `label` and
  `assignment` caps; a retirement during an in-flight spawn; the lost-update protection when two roster
  operations overlap; that a member still running is never swept; the exact request a spawn whose route
  cannot be resolved composes; the task board's write-time caps and the transfer-matrix cells a live run did
  not reach; the task body's 2000-character cap, the handover injected between a board call's read and its
  write — an interleaving a live run cannot be made to produce, so the test drives the table's own
  serialized `update` hook — and the rule that a board write cannot undo a handover; `wait_members`' event
  wiring, timeout, cancellation and no-progress paths; the whole definition layer (v0.16.0) — reading
  a file, the precedence report, and every refusal; the team-file layer (v0.19.0) — the three-source
  precedence, the store-write refusal, the placeholder fallback and the reserved filename; the member
  scope (v0.20.0) — the owner filter, the empty answer, the non-member refusal, the registration on a
  member Agent and the schema conformance of a real answer; the route layer (v0.22.0) — forwarding,
  the caller's option winning, both fallbacks, `reasoning_effort` never added, and the stale-route flag
  being set, cleared and never guessed; and the lifetime layer (v0.25.0) — the declared lifetime and its
  refusal, the three sweep conditions, the board's veto and the ids it reports, the consent gate through the
  real `retire_member` tool both ways, a message re-opening a one-shot member without re-declaring it, the
  retask advice, and the two record fields the advice counts — narrowed in v0.25.1 to what a member carries,
  with a case per carrier and the bare member that retires on a stated reason or is refused `needs-reason`
  without one. A live start from a definition, a live team-file read, a live `list_my_tasks` call from
  inside a member, the route on a real child's own `request/header`, and a live sweep and consent refusal
  are the owner's install check (ADR 0018, ADR 0021, ADR 0022, ADR 0024, ADR 0026).
- A fresh install has a real side effect, so it is the owner's decision each time.
- History, append-only: [PROGRESS.md](PROGRESS.md).

## Why this exists

The shipped experimental Agent Teams roster cannot let a member go. It is a fold over the Lead Session's
append-only event log with closed phases `provisioning | active | failed`: the projection throws on any
transition out of a terminal phase and records that throw as a permanent failure, after which every Team
read and mutation for that Lead throws, so a synthetic "retired" record poisons the projection rather than
failing safely (ADR 0001). `maxMembers` (16) is checked against a list that never shrinks; names are never
reused; the contract has no deletion; upstream's in-progress redesign still defers it. This profile also
ships the compaction backend disabled.

The plugin supplies the missing half without forking the shipped roster: its own roster on the Harness
subagent substrate, a real `retired` phase, a reusable name at the next generation, and a session trash
that is a move rather than a deletion.

## What you can do

| Tool | Behaviour |
|---|---|
| `spawn_member` | Start a named member as a continuable child, optionally from a member definition on disk with `definition`, or with its own working directory, model route or agent preset through `spawn_options`; with `replace`, start its successor from a handoff brief and retire the predecessor in the same call. `lifetime` says how long the member lives: `standing` (the default) is a role you expect to use again and is never retired automatically, while `one-shot` is created for one piece of work and the sweep retires it once it has run, stopped and owns no open task — `ephemeral: true` is the older spelling of `one-shot`. The lifetime is that call's alone: never inherited from a predecessor or a definition file. A spawn that names no model starts the member on **this Session's current route**: the plugin resolves `provider` and `model` from the Session and forwards them, and `started_with.route_source` says whether the route came from the call, was resolved by the plugin, or was inherited unresolved. |
| `list_members` | Every member and subagent this Lead controls: this roster, members the shipped roster created, and every child spawned with the shipped `subagent` / `subagent_fork` tools. A row carries target, child session id, phase, generation, label, assignment, the `lifetime` its spawn declared (with `ephemeral` as the same fact on the record), `retasked: true` plus a note on a one-shot member handed work at least twice, the `route` it was started on, live state, `compactable` and — while resident — context pressure. A member whose route is no longer the Lead's is marked `route_stale: true` with a `route_note` naming both routes and the call that replaces it. The read first sweeps one-shot members that have run, stopped and own no open task, and reports `swept`/`swept_targets`; a member the board's veto kept is reported through `blocked`, `blocking_tasks` and `blocking_note` instead. It also answers `host_hooks`: whether the panel filter, the `list_agents` filter and the slot credit installed, how many tombstoned ids they strip, and why one is absent. |
| `wait_members` | Block this turn until a member's live status changes or a timeout expires, and report which member changed and into what. Bounded: 30 seconds by default, at most one hour. It answers `no_progress` at once when no member is running or provisioning, never wakes anyone, and does not wait for board writes or message processing. |
| `message_member` | Deliver one message to a live member and optionally replace its recorded assignment; an unloaded continuable member is cold-resumed from its own Session, a one-shot child cannot be. A message never changes a lifetime: messaging a one-shot member re-opens it (its finished-evidence is dropped, and the result says `reopened: true` with the unchanged `lifetime`), so the next sweep leaves it alone until it has run and stopped again. |
| `stop_member` | Cancel the member's current turn; the activation and inbox are kept, so a later message resumes it. |
| `retire_member` | Drain, tombstone, move the persisted Session into the trash (or hide it through the workspace archive when no artifact can be moved) and enforce the retention cap. A repeat is a no-op that says so. **What one call may do depends on what the standing member still carries**: with a recorded assignment, an open row or evidence it was re-tasked, it answers `retired: false, reason: "needs-confirmation"`, names what it found in `carries`, and retires on the next call carrying the person's answer in `confirmed`, quoted verbatim; with none of the three it is housekeeping, and a non-empty `reason` retires it in one call — a call that states no reason answers `reason: "needs-reason"`. A one-shot member, and a successor a replacement installs, need no confirmation. |
| `restore_member` | Move a trashed Session back to its recorded path and return the record to `active`; a pruned artifact is a typed refusal. |
| `compact_member` | Force one compaction on a resident, idle member, answering `done`, `busy`, `not-resident`, `nothing-to-compact` or `failed`. |
| `handoff_template` | Read, set or clear the brief a successor receives: omit `template` to read the effective one and its `source` (`file`, `stored` or `builtin`), pass a template to store it, pass an empty string to return to the built-in. A `team/team.md` in the Lead's project wins while it exists, so a store or clear is refused with that file's path and the instruction to edit it. |
| `task_board` | This Lead's own work board: `create`, `list`, `update`, `release` or `delete` a task by its `action`. A task has an id, a title, a bounded body (what "done" means and where the work stopped), `open` or `done`, and an optional member `owner`; the open ones move with a replacement, body included. |
| `list_my_tasks` | **A member's own tool, not the Lead's**: the read-only rows whose `owner` is that member's own target, each with its id, title, body, status and timestamps, and how many are still open. It takes no argument — the caller's Session is the selector. A member owning nothing gets an empty list, not an error; another member's rows, unowned rows and the Lead's whole board are invisible. Only the Lead writes the board, so a member reports finished work and the Lead marks it done. |

**A member starts on this Session's API, even when you name no model at all.** With no
`spawn_options.agent_options`, `spawn_member` resolves the Lead's current `provider` and `model` from the
Session itself and forwards them, so the member uses the API of the Session that started it; the same
route the plugin forwarded is recorded on the member and reported back on its row.
`started_with.route_source` says which path ran — `caller` when the call (or its definition) named the
route, `plugin` when the plugin resolved and forwarded it, `inherited` when nothing could be forwarded.
Only that last path leaves the Harness to resolve inheritance itself, and its `route.select_reason` says
why: `no-session-route` (the Session exposes no readable route yet) or `capability-absent` (the spawn
provider does not advertise `agentOptions`). **`reasoning_effort` is never added**: forwarding the Lead's
own route keeps the Lead's effort in the merge anyway, and sending an effort for a model this plugin never
asked about is what would fail a child's first request.

**A member can start somewhere else, on another model, with fewer tools.** `spawn_member.spawn_options`
forwards three things the Harness already supports, and every field omitted inherits the Lead's value —
with one exception: `provider` or `model` without `reasoning_effort` lets the new route resolve its own
default instead. `cwd` selects a separate checkout or worktree (a relative path resolves against the
Lead's directory, and the child keeps the Lead's permission roots, so a directory outside the sandbox
grant stays denied); `agent_options` carries `provider`, `model`, `reasoning_effort` and `max_tokens`,
the last a token limit and the place a cheaper model is chosen; and `agent_preset` selects a narrower
tool set — the *only* route to a read-only member, because the Harness has no per-call tool allow/deny,
and preset ids come from the profile's bundle patches rather than a directory path. `started_with` is a
receipt for what the plugin forwarded, not a confirmation of what the child resolved: it echoes the
supplied fields unresolved and unread, so a model choice has to prove itself on the member's first
request, not on this field. A start the Harness refuses comes back as `started: false` with a
reason and the way out; and a refusal for a stale target names the live holder of that name in
`current_holder`, so a Lead whose member was replaced can retarget the old name.

**A member started before a model switch keeps the old route, and the roster says so.** Nothing re-routes
a live member: its provider and model were written into its own Session's request header when it started,
and a message or a wake reuses them. So `list_members` compares each member's recorded `route` with the
Lead's current one and marks the ones that differ with `route_stale: true` and a `route_note` that names
both routes. That flag is the answer to "which of my members is still billing the old API". **The way to
clear one is to replace it**: `spawn_member { replace: "<target>" }` starts a successor on the current
route and hands the predecessor's open work over in the same call (ADR 0009, ADR 0017), and the stale row
then leaves `list_members` as retired. There is deliberately no reroute tool: the work has to move with
the person anyway.

Three host-side effects make a retired member leave the built-in lists and this plugin's members appear in
them. The projections strip retired ids from `subagentCatalog` and `agentTeam` frames at the session-list
exits, so the **子智能体** picker and the built-in **成员** panel stop rendering a retired member (no host
source change, no Web rebuild); the same `agentTeam` value gains this Lead's live members, so the panel
lists the members this plugin spawned, with a click opening each member's real chat. A retired member
leaves that panel — it is not rendered as a row marked retired, because the panel's phase vocabulary has no
such value. The shipped roster read behind the `list_agents` tool drops the same retired ids. While a spawn
runs, the shipped roster's effective `maxMembers` rises by that Lead's retired count, so one retirement
buys back one slot. All three are gated on the service they wrap, so a profile that publishes
`sessionController` after this plugin activates still gets the filter instead of losing it silently;
`list_members` answers `host_hooks` with `installed`/`absent` per hook and the number of ids being
stripped, so an absent hook is explained rather than guessed at (ADR 0025). Separately, the patch enables
the shipped `compaction-basic` row with `disabled: false`, so automatic compaction covers every agent in
the process, subagents included.

## In use

There is no interface to open: you ask the model in ordinary language and it calls these tools, so the
roster is managed by conversation. Every operation in this README is a tool call the model makes on your
behalf, never a panel you operate. Below is one real exchange: a member is spawned with an assignment and
told to stand by, then replaced.

```
> Give the sum to a helper and tell it to stand by.
spawn_member { name: "handoff-probe", label: …, prompt: …,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else." }
← target: "handoff-probe", generation: 1, phase: "active",
  assignment: "Compute 6 * 7 and reply with the single number, nothing else.", …

> I don't need it any more. Replace it with a successor and retire it.
spawn_member { replace: "handoff-probe", label: …, prompt: … }
← target: "handoff-probe-g2", generation: 2, replaced: "handoff-probe",
  predecessor_retired: true,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else.",
  message: "Successor handoff-probe-g2 started from the handoff brief and the predecessor "handoff-probe" is retired. …"

handoff-probe-g2, which never saw its predecessor, replies: 42
```

The walkthrough is abridged from an acceptance run recorded in [PROGRESS.md](PROGRESS.md).

## Defining a member

A member can be a file instead of a paragraph in a tool call: `spawn_member` with
`definition: "<name>"` reads a definition from `team/` under the Lead's working directory. The file is
committed with the project, reviewed and versioned like any other source, and the roster stays runtime
state — the split this plugin's vocabulary comes from. The plugin only reads these files; you write them
with your own file tools (ADR 0018).

```markdown
---
name: reviewer
label: Review the diff
assignment: Check every changed file for behaviour changes
model: a-cheaper-model
---
You review changes. Report only findings that change behaviour, with the file and the line.
```

The block between the two `---` lines is flat frontmatter and the markdown below it is the member's
prompt. `name` and `label` are required, and every other accepted field is one `spawn_member` already
takes that describes the role: `assignment`, `cwd`, `provider`, `model`, `reasoning_effort`, `max_tokens`
and `agent_preset`. **A definition cannot declare a lifetime**: `lifetime` is not an accepted field and
`ephemeral` was removed in v0.25.0, so a file that carries either is refused by name with the reason and
the call that replaces it. A lifetime is a declaration about one member — the person's consent to it
leaving on its own — and a file describes the role, so inheriting one on a `replace` would retire the
successor and orphan the work it had just been handed. That list is the whole subset — a nested value, an
anchor, a block scalar, a list, a duplicate key or an unknown field is refused with the file and the line
rather than guessed at, and a quoted value loses its quotes without any escape being interpreted.

**The call wins, and the result says so.** Every field passed to `spawn_member` overrides the file's, and
the answer's `definition` object names the file, what came from it (`from_file`) and what you overrode
(`overridden`). Two fields have a source the call is not. `prompt` is the one the call cannot replace: the
body is the member's standing prompt and the call's `prompt` is appended after it, which
`definition.prompt` reports as `file+call`. And on a `replace` the assignment recorded on the predecessor
outranks the file's, because a successor inherits the work and not the role — the file's applies only when
the predecessor recorded none — and `definition.assignment` reports which of `call`, `predecessor` or
`file` won. The file's `cwd`, model route and preset do apply to a successor; the predecessor's are not
inherited, because they are start options and not record fields (ADR 0019).

**One bad file does not hide the others.** A malformed definition is reported by path and line in
`definition.problems` on an otherwise successful spawn, and the valid definitions still work. A name
declared by two files is usable from neither, because a lookup that quietly picked one would make the
other file's edits invisible. The caps refuse rather than truncate: 16 KiB per file, and 64 files per
scan — a directory past that refuses the whole scan instead of serving a partial set. The path is never
guessed either: a profile that mounts no `workingDirectory` service answers `started: false` with
`reason: "working-directory-unavailable"` and reserves no member.

`team/team.md` is reserved for the team scope, not a member definition: a member may still declare
`name: team` in another file, but the filename itself is skipped by the definition scan. That is what
keeps one file from being reported as a broken definition on every spawn (ADR 0021).

## The lifecycle

**A member is a division of labour, not a task.** Retirement answers “this role is not needed any more”, never
“this piece of work is finished”: a member that completed one piece of work may be needed again next round, so
an idle member between rounds is not a candidate. When that is a judgement call rather than a decision already
made, the Lead asks the person before retiring.

| Step | Behaviour |
|---|---|
| Stop | `retire_member` drains the child: its turn ends, and its activation and capacity slot are released. |
| Move | Its persisted Session is moved to `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`, with the original path and artifact kind recorded. Recovery is a directory move back. That directory keeps its pre-rename name, because every recorded `trashPath` lives under it (ADR 0014). |
| Tombstone | The record becomes `retired` and keeps the assignment and the paths; the next generation of the name can then be spawned. The projections stop serving the member, and a repeated retirement is a no-op that says so. |
| Archive fallback | When no artifact can be moved, the workspace archive hides the Session instead, and the record and the result say so (`archived: true`). |
| Retention | A retirement that moved an artifact in removes the oldest entries past the effective per-Lead cap in the same call and reports the count in `pruned`; the cap is enforced only there — no timer and no read-time sweep for it. The platform has no Session-deletion API, which is why the plugin deletes only its own trash copies (ADR 0011); the cap and its refusal are in Configuration below. |
| Pruned | A pruned tombstone keeps its `trashPath` — it still says where the artifact went — and its `trashState` becomes `pruned`. The bytes are gone, so `restore_member` refuses with `reason: "pruned"` and never calls the workspace. |
| Restore | `restore_member` moves the artifact back to its recorded path and clears the tombstone. It refuses when a live member already owns the target, and its result names the branch that actually ran. |

## Replacing a member

`spawn_member` with `replace: <target>` is the whole replacement. The successor's prompt is composed from
the predecessor's record — its name, the target and label, the recorded assignment, the fact that the
predecessor is gone, its open tasks by id and title, and a pointer to this Lead's own board that names the
member's read tool. The successor inherits the assignment unless the model records a different one.

**What a retirement does to the work.** The work is not a sentence: since v0.13.0 it is rows on this
plugin's own board, and the two lifecycle events treat them as the point of the operation. A replacement
moves every open task of the predecessor to the successor, in the same call that retires it, and the
successor's brief names them — so a successor starts with the ids it now owns instead of a pointer at
someone else's board. A retirement **without** a successor instead leaves those rows `open` and unowned,
and reports `unowned` with their ids, because the work is still owed and now nobody carries it; `task_board`
with `action: list` reports the same set, and a restore says how much of it is waiting. `done` tasks never
move: finished work stays on the record that finished it, and it is `task_board` with
`action: update, status: done` that makes a task stop being inherited.

Since v0.18.0 a task also carries a **body** — up to 2000 characters of what "done" means for it and
where the predecessor stopped — set with `create` or `update` and cleared with `body: null`. The brief
still names only the id and the title, because a cold child pays for every word and five maximal bodies
would break the line's bound; the successor reads the bodies from the board with `list_my_tasks`, which
returns exactly the rows it owns and nothing else (the Lead reads the same bodies with `task_board`). And a
board write can no longer undo a handover: `update` applies only the fields the call named, so a task whose
owner a replacement just changed keeps that owner, and a `release` or `delete` whose row changed since the
call read it answers `changed: false` with the row it found — naming the owner that took it — instead of
un-owning or removing work the successor has just been given. Repeating the call from a fresh read does
what you asked (ADR 0020).

- **The successor starts first and the predecessor is retired second, in the same call.** A failed start
  leaves the predecessor untouched, with the failed reservation recorded as the successor's `failed`
  record; a failed retirement answers `predecessor_retired: false`, so one more `retire_member` completes
  it (ADR 0009). A target that is already retired is accepted, and its tombstone supplies the brief.
- **The assignment is durable and capped.** `spawn_member.assignment` sets it, `message_member.assignment`
  replaces it, both capped at 1000 characters (refused, never truncated); `list_members` reports it and the
  tombstone keeps it.
- **The brief's shape can be fixed in two places, and the file wins.** Commit `team/team.md` beside the
  member definitions, with an empty frontmatter block and the template in the body; it is the project's
  shape, so two Leads working in one project share it. Or use `handoff_template` to store one on this
  Lead's roster record. The order is file, then stored template, then built-in, and the read form reports
  which one is in effect in `source`. The same placeholders apply to both — `{successor}`,
  `{predecessor}`, `{label}`, `{assignment}` and `{task_board}` — and a template that does not reference
  `{assignment}` is refused, because a successor that never learns what it inherited has not been handed
  anything; an unknown placeholder is refused by name, and the 1000-character template cap refuses rather
  than truncates. While the file exists, `handoff_template` refuses a store or clear and names the file
  to edit: the file would shadow the write, so accepting it would be a silent no-op. A bad file is
  reported in `file_problem` and does not become the effective template; the stored template is next,
  and the built-in shape is last. A Lead with neither gets exactly the words it got before (ADR 0015,
  ADR 0021).

## Member lifetime

A member is a division of labour, not a task. `spawn_member` therefore asks how long it lives, in one
field: `lifetime: "standing"` (the default) is a role you expect to use again, and `lifetime: "one-shot"`
is a member created for one piece of work. `ephemeral: true` is the older spelling of `one-shot` and keeps
working; passing both is accepted when they agree and refused when they do not. `list_members` reports
`lifetime` on every row.

**A standing member is never retired automatically.** It is not eligible for the sweep however long it
idles. Whether `retire_member` needs the person's words depends on what the member still carries, because
the gate protects the person's decision to end a *role*, not every act of housekeeping:

- It **carries something** — a recorded `assignment`, an `open` task on this Lead's board, or evidence it
  was handed work at least twice — and then the first call retires nothing and answers
  `retired: false, reason: "needs-confirmation"`, naming what it found in `carries` and giving you the
  `question` to put to the person (with `owns_tasks` and `assignment` when it has them). Put that question
  to them, then call again with `confirmed` set to their answer **quoted verbatim** — their sentence, not a
  paraphrase and not a boolean, because this plugin has no human surface of its own (ADR 0008), so a flag
  the model sets about itself asks nobody. The quoted sentence is echoed back into the result, where it
  stays in the transcript.
- It **carries nothing** — no assignment, no open row, never re-tasked — and then it is bare residue, and
  housekeeping is yours: pass a non-empty `reason` and it retires in one call, asking nobody. The result
  says in words that it carried nothing and was removed as housekeeping. A call that states no reason
  answers `retired: false, reason: "needs-reason"` and changes nothing — the
  reason is what the tombstone keeps, so a later reader can tell why the residue was cleared.

A one-shot member needs no confirmation, because declaring it one-shot was the person's prior consent, and
so does a successor a replacement installs, because a replacement continues the role rather than ending it.
A record that never became a role is exempt too: one in `failed` never started, and one already `retired`
has no life left to end. Nothing here adds a config switch or a third lifetime value: the narrowing is by
what the member in front of the call carries, so the rule is about the member rather than about a profile's
policy.

**One-shot is the fan-out case.** The plugin receives no completion event, so the sweep that retires such a
member runs at the start of `list_members` and `spawn_member`, and it requires three things at once: the
member started, it is no longer resident, and it owns no `open` task on this Lead's board. A member that
never started is never swept, one still running is never swept, and one still holding work is not swept
either — the board is a **veto**, and an empty board is never the trigger, because neither a missing row nor
a member's `inactive` status can tell finished work from work nobody wrote down. A vetoed member stays
listed and the read says why: `blocked` counts them, `blocking_tasks` names the row ids, and
`blocking_note` names the one `task_board { action: "update", … }` call that clears each. Closing the work
is what makes a one-shot member eligible to leave; it is never what proves the member finished.

A swept member goes through the ordinary retirement path, so its tombstone stays listed and its slot is
credited back. The triggering call reports `swept` and `swept_targets`, and adds nothing when the sweep
retired and blocked nobody.

**A message re-opens a one-shot member; it does not re-declare it.** Sending it work again drops the
evidence the sweep relies on, so it will not be swept until it has run and stopped again, and its lifetime
stays `one-shot` — the result says `reopened: true`. A one-shot member messaged at least twice is flagged on
its row as `retasked: true`, with a note saying it is probably a standing role and naming the call that
declares that. Nothing converts it automatically: a lifetime is the person's consent, and the plugin only
reports its own count.

**A definition cannot declare a lifetime.** `lifetime` is not an accepted frontmatter field and `ephemeral`
was removed in v0.25.0; a file carrying either is refused by name with the reason. A file describes the
role, so a role-declared one-shot would be inherited by every successor of a replacement — and a successor
that retires itself at the end of its turn would orphan the very work the replacement had just handed it.
Declare it on the `replace` call instead (ADR 0026).

## Limits and deliberate omissions

Five things this bundle does not do, each decided rather than forgotten.

- **One record per Lead, and no cross-process lock.** The roster and this Lead's board live in one JSON
  document in a `storageDomain` domain keyed by the Lead Session id (ADR 0003). The facility has no
  cross-process lock (ADR 0010), so two Harness processes over one store are last-writer-wins: if both
  write the same Lead, the later write replaces the earlier one and the update it never read is lost.
  That is correct for one running Harness, which is how subagents themselves work; the plugin adds no
  second lock and no merge protocol.
- **No browser half of its own.** There is no plugin panel, HTTP bridge or client bundle.
  v0.3's Settings panel was never rendered in a real profile and its clicks did not work, so v0.4 deleted
  it rather than repairing it (ADR 0008). What the panel shows is overlaid at the host's session-list
  exit (ADR 0023): its **成员** section lists this plugin's live members, and a retired member leaves the
  panel rather than being marked. The overlay only reads: it can neither retire nor replace anything, and
  it cannot write the Session log, which is why the shipped fold's closed phases (ADR 0001) do not apply
  to it. Every operation remains a model-facing tool, and a future UI is a new decision that starts from
  the operations in `actions.js`.
- **The shipped `agent-team` service row stays mounted.** Adoption, the membership test and the
  projection filter read it, so the patch cannot disable it — and that service publishes three
  model-facing tools of its own, `list_agents`, `send_message` and `interrupt_agent`, which therefore
  remain in a Lead's tool list. The patch retires the shipped *tool* row (`tool-agent-team`); removing
  those three would take the service, and this plugin's adoption, with them (ADR 0017).
- **A pruned tombstone cannot be restored.** A retirement that moves an artifact in enforces the
  per-Lead trash cap and removes the oldest entries past it. The tombstone keeps its `trashPath` and
  records `trashState: pruned`, but the bytes are gone, so `restore_member` refuses with
  `reason: "pruned"` and never calls the workspace (ADR 0011). Configure a larger cap before a
  long-lived team needs more than 20 recoverable sessions.
- **The task board is a handover channel, not a project tracker.** A task has an id, a title, a bounded
  body, `open`/`done` and an optional owner, and deliberately no priorities, dependencies, comments,
  sub-tasks or due dates (ADR 0017, ADR 0020). Dependencies would need a graph and an ordering rule, and a
  handover would then have to decide what to do with a task whose dependency is still open; that order
  stays the Lead's judgment. The board answers one question: what work does the successor carry now?

## Costs and model routes

**The suspicion this section answers, and the measurement that confirmed it.** After a relay provider was
connected, the owner's account was still billed. An inventory of 60 session logs found 18 sessions still on
`deepseek-official/deepseek-flash`, several of them members of a live team, while the live Lead sessions ran
on the relay: a member's provider and model were written into its own Session's request header when it
started, so nothing about a later switch reaches it. Below is what this plugin chooses, what the Harness
chooses for it, and the one component in this profile that follows an endpoint of its own instead of the
session's route.

### What chooses a member's model

**The plugin states the route now, and records it.** With no `spawn_options.agent_options`, `spawn_member`
resolves the Lead's current `provider` and `model` from `session.requestHeader().config` — the seam's own
inheritance source — and forwards them as the request's `agentOptions`, so the member is started on the API
of the Session that started it and the plugin is what names it (ADR 0024). An explicit
`spawn_options.agent_options` still wins field by field, and the field the caller did not name is completed
from the same read, so `started_with.route_source` can say the route came from the call (`caller`), was
resolved by the plugin (`plugin`), or was inherited unresolved (`inherited`).

- **`reasoning_effort` is never forwarded.** The seam drops the parent's effort when the route it resolved
  differs from the parent's (`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:88-90`); forwarding the
  Lead's own route is exactly the case where it does not differ, so the Lead's effort survives the merge
  without being sent. A caller who names `reasoning_effort` still gets it forwarded — that is the caller's
  own field.
- **Every failure to resolve is a fallback, not a failed spawn.** A Session whose route cannot be read
  (`no-session-route`) and a provider that does not advertise `agentOptions` (`capability-absent`, the gate
  at `@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`) both forward nothing, record
  `route.source: "inherited"` with that reason, and let the Harness inherit as it did before. The request
  in that case is exactly `{ prompt, parent }`; a spawn is never broken to fix a route.
- **A live member cannot be re-routed.** Its route lives in its own recorded request header. That is why
  `list_members` flags a member whose recorded `route` is not the Lead's current one
  (`route_stale: true`, with a `route_note`), and why the remedy is one replacement:
  `spawn_member { replace: "<target>" }` starts a successor on the current route and hands its open work
  over (ADR 0009, ADR 0017).

The plugin does not preflight the route through `ctx.llm` the way the shipped subagent tool does
(`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`, and the Session route allowlist at `:89-96`): that
preflight validates a *caller-chosen* route against the profile's allowlist, while what is forwarded here is
the route the Session is already issuing requests on — proven rather than proposed.

### No LLM call, and the compaction row follows the session

The bundle makes no model call of its own: no Host module reaches `ctx.llm`, and no code path calls
`prepareCall`. The row the patch enables, `compaction-basic`, resolves its summarization target as
`configured ?? session.requestHeader().config ?? agent.options`
(`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`) — the session's own route — so enabling it started
no new billing in the measured profile.

### The exception: web search pins its own endpoint

`web_search` is not this plugin's, and it is the one component here that does not follow the session route.
The base bundle's patch selects `searchProvider: deepseek-official`
(`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`), and `dsh-web-search-deepseek` pins
`https://api.deepseek.com/anthropic/v1` with `deepseek-v4-flash`
(`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`) and sends there whatever the chat route is
(`:319-320`). In the measured profile it produced 107 official requests, two of them after a session had
already switched to the relay.

**Why it cannot simply be pointed elsewhere.** That plugin requires retrieval to happen server-side: it reads
`web_search_tool_result` blocks and throws `WEB_PROVIDER_ERROR` when there are none
(`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:61-62`). A relay endpoint that speaks an Anthropic-shaped
Messages API can still hand the search back: a direct test of the relay's `/v1/messages` answered 200 and,
given the `web_search` tool, answered `stop_reason: "tool_use"` — the same rejected shape — while its
`/anthropic/v1/messages` path answered 404.

**The two honest options.** Disable that row (or the `web` row) in the profile, and no request leaves for
that endpoint — search is simply not available; or point it at an endpoint that executes native search. One
request tells them apart: send a Messages request carrying the `web_search` tool and read the answer. A
`web_search_tool_result` block, or a finished turn with results, means the endpoint runs the search; a
`tool_use` stop means it is asking the caller to run it, and this plugin rejects that answer.

The boundary in one sentence: **the session's route governs every chat request; a component that pins its own
endpoint is the exception, and this plugin is not one.**

## Requirements and compatibility

**To run**, the bundle needs the installed Harness and the shipped packages it reads — not npm
dependencies: it is linked into a profile and imports no `@deepseek-ai/*` package (ADR 0002), so what
runs is this working tree. It reads the subagent seam (`startActivation`, `drainChildren`,
`sendMessage`, `interrupt`, `listDescendants`), the shipped `agent-team` service (adoption and the
membership test), `sessionController` (the projection filter and the panel overlay; a host that never
publishes it reports `panel_filter: "absent"` instead of losing the hook silently), `agentTeams.listMembers`
(the shipped `list_agents` read this plugin filters), the token meter (context pressure), the storage-domain facility, and the agent registry with its
`agent/status` event (the wait). `compact_member` additionally needs a mounted compaction backend, which the patch's
`compaction-basic` entry enables. The host-side effects are capability-probed and each installs when the service it wraps exists: a Harness whose shape
changed skips that effect and says so in `list_members`, rather than failing the load. A profile that does not mount the experimental
team bundle has no `tool-agent-team` row for the patch to disable; the Loader warns about the missing
target and skips that entry.

**To develop**, the test suite needs Node 24 and the flag CI pins: `.github/workflows/ci.yml` sets
`node-version: "24"` and runs `node --test --test-isolation=none tests/*.test.mjs`. The flag is not
optional. Node 22 documents it as `--experimental-test-isolation`, so the spelling itself fixes the
major version; and the default runner spawns one process per test file, which the sandbox on the
author's machine refuses. CI runs the same command as the local machine, so a local pass is the same
statement as a green run.

## Upgrading from v0.13 or earlier

v0.14.0 disabled the shipped `tool-agent-team` row, so a profile that used it loses the tools below.
v0.13.0's roster and board are otherwise unchanged: the storage domain, the patch row id, the trash
directory, the pre-rename environment variable and the record shape all carry over, so upgrading needs
no migration (ADR 0014).

| Removed in v0.14.0 | Call instead |
|---|---|
| `spawn_teammate` | `spawn_member`; `spawn_member` with `replace` starts the successor and retires the predecessor in one call. |
| `wait_agent` | `wait_members` (v0.15.0): a bounded wait on the members' live status. It does not wake anyone, and answers `no_progress` at once when no member is running or provisioning. |
| `team_task_create` | `task_board` with `action: "create"`. |
| `team_task_list` | `task_board` with `action: "list"`. |
| `team_task_get` | `task_board` with `action: "list"`, then read the row by id. |
| `team_task_update` | `task_board` with `action: "update"` (status and owner), `"release"` (clear the owner) or `"delete"`. Dependency, priority and comment edits have no replacement: the owned board has none of those fields (ADR 0017). |

The shipped board's rows are not migrated and not readable from this plugin. A Lead that kept work
there re-creates it with `task_board`, which is a couple of `create` calls rather than a migration. The
shipped `list_agents`, `send_message` and `interrupt_agent` are **not** among the removed tools: the
`agent-team` service row publishes them and stays mounted.

## Install and verify

```
plugin_manager  install_bundle  target: <absolute path to this repository>
```

The install links this directory into the profile rather than copying it, so what runs is this working
tree — there is no build step. Verification after installing is live calls, not `check.mjs` results:

- the patch row activates with `application: applied` and no warnings;
- `list_members` is callable from a Lead session and reports context pressure for a resident member;
- `list_members` answers `host_hooks` with `panel_filter`, `roster_filter` and `slot_credit` as
  `"installed"` and a non-zero `stripped_ids` once this Lead has retired someone; a hook that never
  installed reads `"absent"` and its `message` names the service it waited for;
- `retire_member` returns `trashed: true` and a `trash_path` for a session that has an artifact;
- `spawn_member` with `replace` returns `predecessor_retired: true` and a successor at the next
  generation; when the predecessor owned open tasks, the result also reports `transferred` with their ids,
  and the successor's brief names them;
- `spawn_member` with `spawn_options` returns `started_with` echoing exactly what was passed plus
  `route_source`, or `started: false` with a `reason` when the profile's provider or preset registry
  refuses it;
- a plain `spawn_member` answers `started_with.route_source: "plugin"` in a profile whose Session route is
  readable, the member's own Session `request/header` names that same provider and model, and
  `list_members` reports the same pair on the row; the row of a member started before a route switch is
  marked `route_stale: true` until it is replaced;
- `wait_members` answers `no_progress` when nothing is running; after `message_member` wakes a member,
  it returns that member's target with `status: "idle"` when the turn ends, within its timeout;
- a Lead's tool list contains this plugin's tools — `wait_members` included — and no `spawn_teammate`,
  shipped `wait_agent` or `team_task_*` tool, and the three the `agent-team` service still publishes:
  `list_agents`, `send_message` and `interrupt_agent`;
- the shipped team panel's **成员** section lists a member started with `spawn_member`, an idle one reads
  未运行 (not running), a click opens its chat, and after `retire_member` the row is gone rather than
  relabelled; the **子智能体** picker and the shipped `list_agents` tool lose the same retired member;
- `include:compaction-basic` reports status `schema`, not `inactive`.

## Configuration

The plugin's data directory is `~/.dsh/team-roster`, overridable with `DSH_TEAM_DATA_DIR` (the
pre-rename `DSH_TEAM_ROSTER_DATA_DIR` still works; ADR 0014); its
`trash/` holds retired sessions, while the roster lives in a `storageDomain` domain (ADR 0003).

One Lead's trash keeps at most **20** retired sessions. The cap is the `trashLimit` field of the bundle's
patch row, so a profile changes it in its own `cordis.patch.yml` by id:

```yaml
- id: team-roster
  config:
    trashLimit: 7
```

That `id` is frozen at `team-roster` while the package is `dsh-team`: it is the key a profile uses
to address this row, so renaming it would silently stop the override from matching (ADR 0014).

The field must be an integer of at least 1; `0`, negatives, fractions, numeric strings, `NaN` and an
explicit `null` are refused, not clamped, at load, before any tool is registered. The refusal reads
`dsh-team: config field "trashLimit" must be an integer >= 1 (minimum 1); received 0`, and a
retirement that moved an artifact in enforces the resolved cap; omitting the field keeps the default of 20.

The entry declares no `Config` **schema**, so the provider reports `include:dsh-team` as `absent`: the
schema projection, not configurability — the field is validated in `apply`. Only a native Schemastery schema
projects, and a zero-import bundle (ADR 0002) cannot import one (ADR 0012).

## Model-facing only

No browser half, no HTTP bridge, no client bundle; the v0.3 Settings panel was never rendered and did not
work in use, so it was removed rather than repaired (ADR 0008). The only in-app view is the shipped team
panel, which this plugin overlays read-only at the host's session-list exit: its **成员** section lists
this plugin's live members, and a retired member leaves that list (ADR 0023). `list_members` is the
control surface: it covers the shipped roster's members and every child spawned with the shipped
`subagent` tools, and every other Lead tool works from what it reports — the target-taking tools take a
row's `target`, while `task_board`, `handoff_template` and `wait_members` read or write the Lead's own
record and the live state those rows describe.

The other scope is the member's. `list_my_tasks` is registered on a member Agent, not on the Lead, takes
no argument, and is read-only: the caller's Session picks the roster row and therefore the rows, so a
member sees the work it owns and the Lead's tool list is unchanged. That is what makes "a successor reads
the bodies from this board" true — a successor with rows no longer has to ask the Lead or read the
plugin's storage file (ADR 0022).

The shipped team tool row is disabled by the patch (P2-07), so the roster calls a Lead has are this
plugin's own ten tools. The row's `spawn_teammate`, `wait_agent` and `team_task_*` tools are gone —
calling one now answers `unknown tool` — and each has a replacement here: `spawn_member`,
`message_member`, `list_members`, `stop_member` and `task_board`, plus `wait_members` for `wait_agent`
(v0.15.0). `wait_members` blocks on the Harness's own `agent/status` for the members on this roster,
where the shipped wait could not see them, and it observes changes only after the call starts, so an
idle member still has to be woken with `message_member`. Three tools remain, and the patch cannot remove
them: `list_agents`, `send_message` and `interrupt_agent` are published by the shipped `agent-team`
*service* row, which stays mounted because adoption, the membership test and the projection filter read
it. `list_members` still reports the members the shipped roster created, and that is the same service at
work; what is gone is the shipped row's own tool set.

## Development

```sh
node --check index.js actions.js roster.js definitions.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

The Node 24 requirement and why `--test-isolation=none` is not optional are in
[Requirements and compatibility](#requirements-and-compatibility) above; the three commands are the
whole local gate.

## Repository layout

| Path | What |
|---|---|
| `index.js` | Host plugin entry: tool definitions, argument validation, Lead-only authority check |
| `actions.js` | The roster operations behind the tools |
| `roster.js`, `trash.js` | Durable roster (phases, name generations, adoption, migration) and the session trash with its restore and retention cap |
| `definitions.js` | The `team/` layer: the flat-frontmatter parser, the member-definition scan and its caps, the team file's handoff template, and the working directory both are resolved from |
| `host-hooks.js` | Projection filter (strip retired ids, add this plugin's live members to the team panel), shipped roster-read filter, roster slot credit, and the deferred install of all three |
| `tests/`, `scripts/check.mjs` | Unit tests, and the repository checks CI runs |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg`, `.github/` | The bundle, its CI workflow and templates |
| `PLAN.md`, `PROGRESS.md`, `docs/` | Open tasks, the append-only change log, and the design documents (bilingual) with the ADRs |

## Documentation and contributing

[docs/INDEX-en.md](docs/INDEX-en.md) is the document map; the design is
[docs/architecture-en.md](docs/architecture-en.md); the ADRs are under [docs/adr/](docs/adr/).
[AGENTS.md](AGENTS.md) is for AI assistants; [CONTRIBUTING.md](CONTRIBUTING.md) covers branches, commits
and CI.
