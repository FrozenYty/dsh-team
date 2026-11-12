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

- Current version: v0.14.1.
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
  with no options carrying no `started_with`; the task board (v0.13.2) — a task created and owned by a
  member, `spawn_member` with `replace` answering `transferred: 1` with the task id and the predecessor
  retired, the successor's brief naming that id and title, and `retire_member` with no successor answering
  `unowned: 1` with the id.
- **The tool surface, measured live** (v0.14.0, `listTools` read immediately before and after the
  install): the shipped row is retired, so `spawn_teammate`, `wait_agent` and the `team_task_*` tools are
  gone from a Lead's list and calling one answers `unknown tool`, while this plugin's `spawn_member` and
  `task_board` remain. Three tools are still there, and this patch cannot remove them: `list_agents`,
  `send_message` and `interrupt_agent` come from the `agent-team` *service* row, which the bundle keeps
  mounted because adoption, the membership test and the projection filter read it. `wait_agent` remains
  the one tool with no equivalent here; the replacement for it is under **Model-facing only** below.
- **Two failures only a live install could show**, each one line, each fixed inside the release that had
  it and each now covered: v0.12.0's bundle installed and did not activate until a schema keyword was
  removed (same version; `scripts/check.mjs` now refuses that keyword), and v0.13.0's replacement answered
  with a result the host refused until v0.13.2 declared the fields (`tests/entry.test.mjs` now validates
  every answer against its own tool's declared output schema).
- **Unit-tested only**, with no live profile having exercised them: the write-time `label` and
  `assignment` caps; a retirement during an in-flight spawn; the lost-update protection when two roster
  operations overlap; that a member still running is never swept; the exact request a spawn with no
  `spawn_options` composes; and the task board's write-time caps and the transfer-matrix cells a live run
  did not reach.
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
| `spawn_member` | Start a named member as a continuable child, optionally with its own working directory, model route or agent preset through `spawn_options`; with `replace`, start its successor from a handoff brief and retire the predecessor in the same call; with `ephemeral`, mark it one-shot, to be retired by a later sweep once it has run and stopped. |
| `list_members` | Every member and subagent this Lead controls: this roster, members the shipped roster created, and every child spawned with the shipped `subagent` / `subagent_fork` tools. A row carries target, child session id, phase, generation, label, assignment, `ephemeral` on a one-shot member, live state, `compactable` and — while resident — context pressure. |
| `message_member` | Deliver one message to a live member and optionally replace its recorded assignment; an unloaded continuable member is cold-resumed from its own Session, a one-shot child cannot be. |
| `stop_member` | Cancel the member's current turn; the activation and inbox are kept, so a later message resumes it. |
| `retire_member` | Drain, tombstone, move the persisted Session into the trash (or hide it through the workspace archive when no artifact can be moved) and enforce the retention cap. A repeat is a no-op that says so. |
| `restore_member` | Move a trashed Session back to its recorded path and return the record to `active`; a pruned artifact is a typed refusal. |
| `compact_member` | Force one compaction on a resident, idle member, answering `done`, `busy`, `not-resident`, `nothing-to-compact` or `failed`. |
| `handoff_template` | Read, set or clear the brief a successor receives: omit `template` to read the stored one, pass a template to store it, pass an empty string to return to the built-in. |
| `task_board` | This Lead's own work board: `create`, `list`, `update`, `release` or `delete` a task by its `action`. A task has an id, a title, `open` or `done`, and an optional member `owner`; the open ones move with a replacement. |

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

Two host-side effects run for every retirement, both capability-probed: the host's session-list exits strip
retired ids from `subagentCatalog` and `agentTeam` frames, so the top subagent picker and the built-in team
panel stop rendering the member (no host source change, no Web rebuild); and while a spawn runs, the
shipped roster's effective `maxMembers` rises by that Lead's retired count, so one retirement buys back one
slot. Separately, the patch enables the shipped `compaction-basic` row with `disabled: false`, so
automatic compaction covers every agent in the process, subagents included.

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

## The lifecycle

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
predecessor is gone, and its open tasks by id and title. The successor inherits the assignment unless the
model records a different one.

**What a retirement does to the work.** The work is not a sentence: since v0.13.0 it is rows on this
plugin's own board, and the two lifecycle events treat them as the point of the operation. A replacement
moves every open task of the predecessor to the successor, in the same call that retires it, and the
successor's brief names them — so a successor starts with the ids it now owns instead of a pointer at
someone else's board. A retirement **without** a successor instead leaves those rows `open` and unowned,
and reports `unowned` with their ids, because the work is still owed and now nobody carries it; `task_board`
with `action: list` reports the same set, and a restore says how much of it is waiting. `done` tasks never
move: finished work stays on the record that finished it, and it is `task_board` with
`action: update, status: done` that makes a task stop being inherited.

- **The successor starts first and the predecessor is retired second, in the same call.** A failed start
  leaves the predecessor untouched, with the failed reservation recorded as the successor's `failed`
  record; a failed retirement answers `predecessor_retired: false`, so one more `retire_member` completes
  it (ADR 0009). A target that is already retired is accepted, and its tombstone supplies the brief.
- **The assignment is durable and capped.** `spawn_member.assignment` sets it, `message_member.assignment`
  replaces it, both capped at 1000 characters (refused, never truncated); `list_members` reports it and the
  tombstone keeps it.
- **The brief's shape can be fixed once per Lead.** `handoff_template` stores a template that interpolates
  `{successor}`, `{predecessor}`, `{label}`, `{assignment}` and `{task_board}`. A template that does not
  reference `{assignment}` is refused when it is stored, because a successor that never learns what it
  inherited has not been handed anything; an unknown placeholder is refused there too, rather than written
  literally into a child's prompt. The built-in brief *is* the default template, rendered by the same code,
  so a Lead that stores nothing gets exactly the words it got before, and clearing the template returns to
  it (ADR 0015).

## Ephemeral members

`spawn_member` with `ephemeral: true` marks a member one-shot, and `list_members` reports `ephemeral: true`
on its row; the default is `false`. The plugin receives no completion event, so the sweep that retires such
a member runs at the start of `list_members` and `spawn_member`, and it retires only a member it has
positive evidence ran and then stopped: one that never started is never swept, and one still running is
never swept. A swept member goes through the ordinary retirement path, so its tombstone stays listed and
its slot is credited back. The triggering call reports `swept` and `swept_targets`, and adds nothing when
the sweep retired nobody.

Messaging an ephemeral member clears the flag: sending it work again is a declaration that it is not
one-shot after all, and without that rule a sweep could eat work a just-delivered message meant to keep.

## Install and verify

```
plugin_manager  install_bundle  target: <absolute path to this repository>
```

The install links this directory into the profile rather than copying it, so what runs is this working
tree — there is no build step. Verification after installing is live calls, not `check.mjs` results:

- the patch row activates with `application: applied` and no warnings;
- `list_members` is callable from a Lead session and reports context pressure for a resident member;
- `retire_member` returns `trashed: true` and a `trash_path` for a session that has an artifact;
- `spawn_member` with `replace` returns `predecessor_retired: true` and a successor at the next
  generation; when the predecessor owned open tasks, the result also reports `transferred` with their ids,
  and the successor's brief names them;
- `spawn_member` with `spawn_options` returns `started_with` echoing exactly what was passed, or
  `started: false` with a `reason` when the profile's provider or preset registry refuses it;
- a Lead's tool list contains this plugin's tools, no `spawn_teammate`, `wait_agent` or `team_task_*` tool,
  and the three the `agent-team` service still publishes: `list_agents`, `send_message` and
  `interrupt_agent`;
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
work in use, so it was removed rather than repaired (ADR 0008). `list_members` is the control surface: it
covers the shipped roster's members and every child spawned with the shipped `subagent` tools, and the
other six tools address any row it returns.

The shipped team tool row is disabled by the patch (P2-07), so the roster calls a Lead has are this
plugin's own nine tools. The row's `spawn_teammate`, `wait_agent` and `team_task_*` tools are gone —
calling one now answers `unknown tool` — and every one of them has an equivalent here (`spawn_member`,
`message_member`, `list_members`, `stop_member`, `task_board`) except `wait_agent`: there is no blocking
wait, so a Lead re-reads `list_members` for live state and uses `message_member` to wake a member it
needs, and reads `inactive` as "no turn is executing", never as "finished". Three tools remain, and the
patch cannot remove them: `list_agents`, `send_message` and `interrupt_agent` are published by the shipped
`agent-team` *service* row, which stays mounted because adoption, the membership test and the projection
filter read it. `list_members` still reports the members the shipped roster created, and that is the same
service at work; what is gone is the shipped row's own tool set.

## Development

```sh
node --check index.js actions.js roster.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

`--test-isolation=none` is required on Windows (the default runner spawns one process per file, which the
sandbox refuses) and fixes the Node major, which CI pins to 24 too; both sides run the same command.

## Repository layout

| Path | What |
|---|---|
| `index.js` | Host plugin entry: tool definitions, argument validation, Lead-only authority check |
| `actions.js` | The roster operations behind the tools |
| `roster.js`, `trash.js` | Durable roster (phases, name generations, adoption, migration) and the session trash with its restore and retention cap |
| `host-hooks.js` | Projection filter and roster slot credit |
| `tests/`, `scripts/check.mjs` | Unit tests, and the repository checks CI runs |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg`, `.github/` | The bundle, its CI workflow and templates |
| `PLAN.md`, `PROGRESS.md`, `docs/` | Open tasks, the append-only change log, and the design documents (bilingual) with the ADRs |

## Documentation and contributing

[docs/INDEX-en.md](docs/INDEX-en.md) is the document map; the design is
[docs/architecture-en.md](docs/architecture-en.md); the ADRs are under [docs/adr/](docs/adr/).
[AGENTS.md](AGENTS.md) is for AI assistants; [CONTRIBUTING.md](CONTRIBUTING.md) covers branches, commits
and CI.
