# dsh-team

English | [中文](README-zh.md)

[![ci](https://github.com/FrozenYty/dsh-team/actions/workflows/ci.yml/badge.svg)](https://github.com/FrozenYty/dsh-team/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![build step](https://img.shields.io/badge/build-none-brightgreen)

> Only the person changes, not the work.

A DeepSeek Harness profile bundle for the one thing the shipped agent-team roster cannot do: let a member
go. A Lead can retire one, restore it from a trash it controls, or replace it with a successor that
inherits the assignment, the work still in flight, and a pointer to the Lead's own task board. It owns
the roster and has no browser half.

[github.com/FrozenYty/dsh-team](https://github.com/FrozenYty/dsh-team)

## Status

- Current version: v0.28.2.
- **Exercised in a real profile on this machine.** Retirement, restore, message, stop, a replacement whose
  successor finished the predecessor's work, the trash cap and its refusal at load, the handoff template,
  spawn options and the forwarded route, the task board and its transfer, the three host hooks, and the
  one-shot sweep with the consent gate — recorded field by field in `PROGRESS.md`'s 2026-11-13 entry. The
  plugin's own state move is no longer a plan: this profile's roster is a file, `<workspace>/.agents/team/
  roster.json`, imported from the storage domain with a marker beside it, and the migration ran against
  that live data — **110 records, 20 artifacts moved, 4,913,598 bytes verified at the destination, 46
  tombstones reconciled to `pruned`, 44 left alone by reason, 0 refused.** The backup manifest and the
  destination directory agree on the byte total, `4,913,598` both ways across 20 files, which is the only
  reason the word "verified" is used here.
- **Checked with something stronger than a reading.** **247 tests** pass and `scripts/check.mjs` prints
  `check passed`; between them they cover the write-time caps, a retirement during an in-flight spawn,
  overlapping roster writes, the route fallbacks, the definition chain, the member-scope read, and the
  lifetime sweep and consent gate. The defect this release fixed was also **reproduced live before it was
  fixed**: for a record whose bytes the retention cap had deleted, `restore_member` answered
  `reason: "pruned"`, and for a spawned one it answered `trash-missing` with **no `reason` field at all**.
  Both answers are in `PROGRESS.md`, and the trash held 20 directories before and after each probe.
- **Not covered yet**: activation in anyone else's profile — `scripts/check.mjs` never loads the Harness,
  so no repository can prove that; a Harness build whose services or storage layout differ from the
  installed one; and the `rename` fast path of the trash move, which this machine never took, because its
  data roots sit on different volumes and every move was the verified copy path (`EXDEV`) instead.
- Release list: [CHANGELOG.md](CHANGELOG.md). Append-only history: [PROGRESS.md](PROGRESS.md).

## Install and verify

```
plugin_manager  install_bundle  target: <absolute path to this repository>
```

The install links this directory into the profile rather than copying it, so what runs is this working
tree and there is no build step. Verification afterwards is live calls, not `check.mjs` output:

- the patch row activates with `application: applied` and no warnings;
- `list_members` is callable from a Lead session, reports context pressure for a resident member, and
  answers `host_hooks` with `panel_filter`, `roster_filter` and `slot_credit` as `"installed"` and a
  non-zero `stripped_ids` once this Lead has retired someone — a hook that never installed reads
  `"absent"` and its `message` names the service it waited for;
- `retire_member` returns `trashed: true` and a `trash_path` for a session that has an artifact, and
  `spawn_member` with `replace` returns `predecessor_retired: true` with the successor at the next
  generation, reporting `transferred` with the task ids when the predecessor owned open work;
- a plain `spawn_member` answers `started_with.route_source: "plugin"` in a profile whose Session route
  is readable, and the member's own Session `request/header` names that same provider and model;
- `wait_members` answers `no_progress` when nothing is running, and returns a member's target when a
  message you sent it ends its turn;
- a Lead's tool list holds this plugin's tools and none of `spawn_teammate`, the shipped `wait_agent` or
  `team_task_*` — while `list_agents`, `send_message` and `interrupt_agent` remain, because they come
  from the shipped service row this patch keeps mounted;
- the shipped **成员** panel lists a member started here, and after `retire_member` the row is gone rather
  than relabelled; the **子智能体** picker and the shipped `list_agents` lose the same member.

## First use

There is no interface to open: you ask in ordinary language and the model calls the tools, so the roster
is managed by conversation. One real exchange — a member is spawned with an assignment, then replaced:

```
> Give the sum to a helper and tell it to stand by.
spawn_member { name: "handoff-probe", label: …, prompt: …,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else." }
← target: "handoff-probe", generation: 1, phase: "active", …

> I don't need it any more. Replace it with a successor and retire it.
spawn_member { replace: "handoff-probe", label: …, prompt: … }
← target: "handoff-probe-g2", generation: 2, predecessor_retired: true,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else.", …

handoff-probe-g2, which never saw its predecessor, replies: 42
```

Three commands cover most of the surface: `spawn_member` starts a member — with `replace` it hands a role
over instead of growing the team — `list_members` shows every member the Lead controls with its live
state, and `retire_member` (or `restore_member`) ends a role or takes it back. Abridged from an
acceptance run recorded in [PROGRESS.md](PROGRESS.md).

## Why the shipped roster is not enough

The shipped experimental Agent Teams roster cannot let a member go. It is a fold over the Lead Session's
append-only event log with closed phases `provisioning | active | failed`: the projection throws on any
transition out of a terminal phase and records that throw as a permanent failure, so a synthetic
"retired" record poisons the projection rather than failing safely. `maxMembers` (16) is checked against
a list that never shrinks, names are never reused, and upstream's redesign still defers deletion
(ADR 0001). This plugin supplies the missing half without forking the shipped roster: its own roster on
the Harness subagent substrate, a real `retired` phase, a reusable name at the next generation, and a
session trash that is a move rather than a deletion.

## The tools

| Tool | What it does |
|---|---|
| `spawn_member` | Starts a named member as a continuable child. `definition` starts it from a file, `spawn_options` gives it its own directory, route or preset, `replace` starts a successor and retires the predecessor in one call, and `lifetime` says whether the role is `standing` or `one-shot`. |
| `list_members` | Every member this Lead controls, with phase, generation, assignment, lifetime, route, live state and context pressure — and a sweep of finished one-shot members before it answers. |
| `wait_members` | Blocks this turn until a member's live status changes, or a bounded timeout expires. |
| `message_member` | Delivers one message to a live member, optionally replacing its recorded assignment. |
| `stop_member` | Cancels the member's current turn and keeps its activation and inbox. |
| `retire_member` | Ends a role: drain, tombstone, move the persisted Session to the trash, enforce the retention cap. A standing member that still carries something needs the person's answer first. |
| `restore_member` | Moves a trashed Session back to its recorded path and returns the record to `active`. |
| `compact_member` | Forces one compaction on a resident, idle member. |
| `handoff_template` | Reads, stores or clears the brief a successor receives. |
| `task_board` | This Lead's own work board: `create`, `list`, `update`, `release` or `delete` a task. |
| `list_my_tasks` | **A member's own read**, not the Lead's: the rows whose `owner` is that member. |

The authoritative table — every result field, every refusal, the consent gate, the workspace overlay —
is [docs/architecture-en.md](docs/architecture-en.md) §5; the model also sees each tool's own description
at call time. What that table does not answer is which model a member runs on: that is
[docs/routes-en.md](docs/routes-en.md).

## A member is a division of labour

`spawn_member` asks how long the member lives. `standing` (the default) is a role you expect to use
again: never retired automatically, and ending it is the person's decision. `one-shot` is the fan-out
case — a member built for one piece of work, which the sweep retires by itself once it has run, stopped
and owns no open task. Messaging a one-shot member re-opens it rather than converting it, and the plugin
never converts one on its own count.

Ending a `standing` member that still carries something — a recorded assignment, an open task, evidence
it was re-tasked — needs the person's answer, quoted verbatim; one that carries nothing is housekeeping
and retires on a stated reason. A member can also be a file on disk instead of a paragraph in a call:

```markdown
---
name: reviewer
label: Review the diff
assignment: Check every changed file for behaviour changes
model: a-cheaper-model
---
You review changes. Report only findings that change behaviour, with the file and the line.
```

The whole subject is [docs/member-lifecycle-en.md](docs/member-lifecycle-en.md) — the four phases, the
state matrix, the sweep's three conditions and the consent gate — with the file format in
[docs/architecture-en.md](docs/architecture-en.md) §6. Replacing a member is
[docs/handoff-en.md](docs/handoff-en.md) for the brief, and
[docs/task-board-en.md](docs/task-board-en.md) for the work it hands over.

## Limits and deliberate omissions

Five things this bundle does not do, each decided rather than forgotten.

- **One record per Lead, and no cross-process lock.** The roster and this Lead's board live in one JSON
  document — `roster.json` under `.agents/team/` in the Lead's workspace (ADR 0027). Nothing serializes
  two processes over it (ADR 0010), so two Harness processes over one workspace are last-writer-wins: if
  both write the same Lead, the later write replaces the earlier one and the update it never read is lost.
  That is correct for one running Harness, which is how subagents themselves work; the plugin adds no
  lock file, and the second writer is reported as `foreign_write_at` when this process next reads or
  writes.
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
  per-Lead trash cap and removes the oldest entries past it. The tombstone keeps its `trashDir` and
  records `trashState: pruned`, but the bytes are gone, so `restore_member` refuses with
  `reason: "pruned"` and never calls the workspace (ADR 0011, ADR 0028). Configure a larger cap before a
  long-lived team needs more than 20 recoverable sessions.
- **The task board is a handover channel, not a project tracker.** A task has an id, a title, a bounded
  body, `open`/`done` and an optional owner, and deliberately no priorities, dependencies, comments,
  sub-tasks or due dates (ADR 0017, ADR 0020). Dependencies would need a graph and an ordering rule, and a
  handover would then have to decide what to do with a task whose dependency is still open; that order
  stays the Lead's judgment. The board answers one question: what work does the successor carry now?

## Configuration

The plugin keeps its data under `.agents/team/` in the Lead's workspace — `roster.json`, and a `trash/`
holding retired sessions. A profile that sets `DSH_TEAM_DATA_DIR` (or the pre-rename
`DSH_TEAM_ROSTER_DATA_DIR`) uses that directory instead, and the frozen `~/.dsh/team-roster` is still the
last place an artifact written by an earlier release is looked for. A Session with no resolvable
workspace keeps being served from the storage domain, which is the import source and the rollback path
rather than a second home (ADR 0014, ADR 0027, ADR 0028).

One Lead's trash keeps at most **20** retired sessions. The cap is the `trashLimit` field of the bundle's
patch row, so a profile changes it in its own `cordis.patch.yml` by id:

```yaml
- id: team-roster
  config:
    trashLimit: 7
```

That `id` is frozen at `team-roster` while the package is `dsh-team`: it is the key a profile uses to
address this row, so renaming it would silently stop the override from matching (ADR 0014). The field
must be an integer of at least 1 — `0`, negatives, fractions, numeric strings, `NaN` and an explicit
`null` are refused at load, before any tool is registered, with a message that names the field, the value
and the minimum. The entry declares no `Config` **schema**, so the provider reports `include:dsh-team` as
`absent`: that is the schema projection rather than a statement about configurability, because only a
native Schemastery schema projects and a zero-import bundle (ADR 0002) cannot import one (ADR 0012).

## Requirements and compatibility

**To run**, the bundle needs the installed Harness and the shipped packages it reads — not npm
dependencies: it is linked into a profile and imports no `@deepseek-ai/*` package (ADR 0002), so what runs
is this working tree. It reads the subagent seam, the shipped `agent-team` service, `sessionController`
(the projection filter and the panel overlay; a host that never publishes it reports
`panel_filter: "absent"` instead of losing the hook silently), `agentTeams.listMembers`, the token meter,
the storage-domain facility, and the agent registry with its `agent/status` event. `compact_member` also
needs a mounted compaction backend, which the patch's `compaction-basic` entry enables. Every host-side
effect is capability-probed and installs only when the service it wraps exists, so a Harness whose shape
changed skips that effect and says so in `list_members` rather than failing the load. A profile that does
not mount the experimental team bundle has no `tool-agent-team` row to disable; the Loader warns about the
missing target and skips that entry.

## Development

```sh
node --check index.js actions.js roster.js definitions.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

The three commands are the whole local gate. `--test-isolation=none` is not optional: Node 22 spells it
`--experimental-test-isolation`, so the flag itself fixes the major version at Node 24, and the default
runner spawns one process per test file, which this machine's sandbox refuses. CI pins Node 24 and runs
the same command, so a local pass is the same statement as a green run. `scripts/check.mjs` cannot prove
the plugin works — it never loads the Harness.

## Repository layout

| Path | What |
|---|---|
| `index.js` | Host plugin entry: tool definitions, argument validation, Lead-only authority check |
| `actions.js` | The roster operations behind the tools |
| `roster.js`, `trash.js` | Durable roster (phases, name generations, adoption, migration) and the session trash with its restore and retention cap |
| `definitions.js` | The definition layer: the flat-frontmatter parser, the scan across the definition chain and its caps, the team file's handoff template, and the working directories all are resolved from |
| `host-hooks.js` | Projection filter (strip retired ids, add this plugin's live members to the team panel), shipped roster-read filter, roster slot credit, and the deferred install of all three |
| `tests/`, `scripts/check.mjs` | Unit tests, and the repository checks CI runs |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg`, `templates/`, `.github/` | The bundle, the five role templates it ships, its CI workflow and templates |
| `PLAN.md`, `PROGRESS.md`, `docs/` | Open tasks, the append-only change log, and the design documents (bilingual) with the ADRs |

## Where everything else lives

| Question | Document |
|---|---|
| How does a member move between phases, and what do a retirement and a replacement do in what order? | [docs/member-lifecycle-en.md](docs/member-lifecycle-en.md) |
| The work board, the handover, and why a board write cannot undo one | [docs/task-board-en.md](docs/task-board-en.md) |
| The brief a successor receives, and which template wins | [docs/handoff-en.md](docs/handoff-en.md) |
| The stored record, the trash and the retention cap | [docs/roster-storage-en.md](docs/roster-storage-en.md) |
| Layers, the Harness substrate, the full tool surface, the risks | [docs/architecture-en.md](docs/architecture-en.md) |
| Which model a member runs on, and what bills what | [docs/routes-en.md](docs/routes-en.md) |
| Upgrading from v0.13 or earlier | [docs/upgrading-en.md](docs/upgrading-en.md) |
| Why a decision is what it is | [docs/adr/](docs/adr/), indexed in [docs/INDEX-en.md](docs/INDEX-en.md) |
| What changed, release by release | [CHANGELOG.md](CHANGELOG.md) for the summary, [PROGRESS.md](PROGRESS.md) for the evidence |

[AGENTS.md](AGENTS.md) is for AI assistants; [CONTRIBUTING.md](CONTRIBUTING.md) covers branches, commits
and CI.
