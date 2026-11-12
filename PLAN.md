# Tasks

> Owner: every lane · Revisit when: a task is delivered or re-scoped

Single source of truth for tasks. No issue tracker — this file is the contract.

Phase status lives here. Why it moved lives in `PROGRESS.md`.

## 1. How to use this file

- Every task has an ID (`P2-03`). Reference it in the PR title when the PR delivers that task:
  `feat(roster): retire a member (P2-03)`.
- Tick the box **in the same PR that delivers the task**. Nobody ticks it for someone else.
- A phase gate is a hard stop. The next phase does not start until every box in the current phase is
  ticked and the gate box is ticked too.
- Editing a task is a normal commit. Moving a **gate** needs the owner to agree first.

## 2. Lanes

| Lane | Scope |
|---|---|
| A — runtime | bundle patch, Host plugin, roster service, Harness integration |
| B — documents | README pair, `docs/`, ADRs, this file, `PROGRESS.md` |
| C — UI | retired with the Settings panel in v0.4 (ADR 0008); no UI work remains |

One owner: @FrozenYty. Lanes say where an agent may write, not who owns the repository.

## 3. Phases

### P0 — Repository

- [x] **P0-01** Initialise the repository with the v0.1 bundle and the document set.
  Done when the bundle files, README pair, AGENTS, CONTRIBUTING, PLAN, PROGRESS and `scripts/check.mjs`
  exist and `node scripts/check.mjs` passes.
- [x] **P0-02** Create the GitHub repository and push `main`.
  Done when `git ls-remote` shows `main` and a clean clone passes `node scripts/check.mjs`.
- [x] **P0-03** CI runs the repository checks on every pull request.
  Done when `.github/workflows/ci.yml` exists and a pull request shows the `check` job green.

### P1 — v0.1 context tooling

- [x] **P1-01** Enable the shipped compaction backend.
  Done when `include:compaction-basic` reports status `schema` instead of `inactive`.
- [x] **P1-02** `member_context` tool.
  Done when a Lead session call returns a row per member with `pressure_tokens`, `context_window` and
  `usage_ratio`.
- [x] **P1-03** `compact_member` tool.
  Done when a call on a resident idle member returns a structured result and the declared failure
  reasons (`busy`, `not-resident`, `nothing-to-compact`, `failed`) instead of throwing.
- [x] **P1-04** Live verification of P1-01..03 in the author's profile.
  Done when `member_context` reports `compactor: available` and real token numbers for the Lead and its
  teammates.
- [x] **Gate P1** — the tools are callable and the compactor is mounted.

### P2 — Own roster (v0.2): the lifecycle the shipped team lacks

- [x] **P2-01** Choose the durable store for the roster and write down the record shape.
  Done when `docs/roster-storage-en.md` names the service, the record fields and the key design, backed by
  a spike report rather than a guess.
- [x] **P2-02** Write the roster state matrix (phases × events) before implementing transitions.
  Done when `docs/member-lifecycle-en.md` contains the matrix with every cell decided, including
  retire-versus-spawn races and messages to a retired member.
- [x] **P2-03** Roster service: spawn a member with a generation-suffixed name through `ctx.subagents`.
  Done when a spawn returns a member record carrying the child Session id and the name is unique in the
  roster.
- [x] **P2-04** `retire_member`: drain, archive, tombstone. The handoff brief is deferred to P4-02.
  Done when a retired member stops receiving work, its record says `retired`, and its context is no
  longer reachable through the roster tools.
- [x] **P2-05** Replacement: retire a member and spawn a successor addressed by the brief.
  Done when the successor starts from the brief pointer, not from the predecessor's transcript.
  Delivered without a new tool name: `spawn_member` takes `replace` and retires the predecessor in the
  same call, after the successor has started; `spawn_member.assignment` and `message_member.assignment`
  record the work a successor is briefed with, capped at 1000 characters; and the brief points at the
  shipped team task board instead of copying it (ADR 0009). The suite covers the cap, the brief's
  content, the one-call replacement, both half-failures and the name generations. P2-08 still carries the
  live end-to-end check.
- [x] **P2-06** The model-facing surface: `list_members`, `message_member`, `stop_member`.
  Done when every roster tool refuses a retired member with a typed reason.
- [x] **P2-07** (re-scoped) Retire the shipped team tool row, after an own task board exists (P2-09).
  Adoption made the shipped row unnecessary for removal, and disabling it today would remove the shared
  task board. Done when the shipped roster tools are absent from a Lead's tool list, the plugin's own
  task tools replace them, and nothing else regressed.
  **P2-09 landed in v0.13.0, so this blocker is cleared.** The plugin's own board (`task_board`) now holds
  a member's work and a replacement hands it over (`docs/task-board-en.md` §2, ADR 0017), so the shipped row is no longer the
  only board.
  Delivered (v0.14.0, bundle patch): the patch overrides `tool-agent-team` with `disabled: true`, so
  `spawn_teammate`, `wait_agent` and the shipped `team_task_*` tools are no longer registered; this
  plugin's own roster and task tools serve the same Lead. The `agent-team` service row is deliberately
  untouched, because adoption and the projection filter read it — and that row publishes three
  model-facing tools of its own (`list_agents`, `send_message`, `interrupt_agent`), which therefore
  remain in a Lead's list. `wait_agent` is the one tool with no equivalent here: a Lead re-reads
  `list_members` and wakes a member with `message_member` instead of blocking. The live check this task
  could not run locally — the shape of a real Lead's tool list — was measured in v0.14.1 (`listTools`
  before and after the install): the row's spawn, wait and task tools are gone, and the three service
  tools remain.
- [x] **P2-08** Live end-to-end verification of a replaced member finishing its predecessor's task.
  Done when, in one session, a member is retired, a successor starts from a handoff brief, and the
  successor completes the predecessor's task without redoing it.
- [x] **P2-09** Own task board: create, list, read, compare-and-set, dependencies.
  Done when the four task tools are served by this plugin and P2-07 can proceed.
  Delivered (v0.13.0, ADR 0017) with three deliberate reductions, each recorded in that ADR's rejected
  alternatives: **one** tool (`task_board`, an `action` enum of `list`/`create`/`update`/`release`/`delete`)
  instead of four names, because the operations share one row shape and one refusal vocabulary; **read**
  is `action: list`, so it does not need a tool of its own; and **compare-and-set is the transition
  itself** — only `status` and `owner` can change, every action answers `changed: false` with the current
  row when the write would change nothing, so re-running any action is safe and no separate guard
  parameter is needed. **Dependencies are deliberately absent**: a task is `{ id, title, status, owner?,
  created_at, updated_at? }`, and what a handover needs is what is still owed, not an ordering rule for it.
  The transfer matrix is in `docs/task-board-en.md` §2: every cell is written down, including the two
  half-failures, the already-retired predecessor, a retirement with no successor, restore, the ephemeral
  sweep, and a reused owner name. Caps are refusals: 200 characters per title (`TASK_TITLE_MAX`) and 200
  tasks per Lead (`TASK_LIMIT`). The brief carries the successor's inherited tasks by id and title, bounded
  at 5 rows and 600 characters, and a member with no tasks still gets the byte-identical brief a test pins.
  A bad stored task is reported on read, never thrown on load. The live tool call is the owner's
  install check.
- [x] **P2-10** Session trash: move a retired member's persisted session into a recoverable directory.
  Done when retirement reports `trashed` and a `trash_path`, and a missing artifact falls back to the
  workspace archive with a reported reason.
- [x] **P2-11** Projection filter: retired ids are stripped at the host session-list exits.
  Done when a retired member is absent from `list`/`projections` and the `control`/`follow` frames, and
  the wrappers restore exactly on unload.
- [x] **P2-12** Roster slot credit: one retirement buys back one shipped budget slot for its own Lead.
  Done when the effective `maxMembers` is raised only while that Lead spawns, and the patch is skipped
  when the roster has no such shape.
- [x] **P2-13** `restore_member`: move a trashed session back and return the record to `active`.
  Done when a retired member with a `trashPath` can be restored and appears in `list_members` again.
- [x] **Gate P2** — removal and replacement work in a live session.
- [x] **P2-14** Model control of every subagent, not only the shipped roster's members (v0.4).
  Done when `list_members` reports children spawned with the shipped `subagent` / `subagent_fork` tools,
  every row carries the child Session id, adoption of an unknown descendant is idempotent, and removing
  the UI leaves the tools unchanged. Delivered: `ensureAdopted` also reads
  `ctx.subagents.listDescendants`, `memberRow` adds `child_id`, the Settings panel and its bridge are
  deleted in the same change (ADR 0008), and the suite covers adoption with fakes. A live install is
  the owner's decision.
- [x] **P2-15** Restore a blocking wait on this plugin's own surface (`wait_members`, v0.15.0).
  Done when a Lead can block inside one turn until one of its members changes live state or a bounded
  timeout expires, the wait reports what changed, it observes only changes that happen after the call
  starts, it never wakes a member, it refuses a non-Lead caller and an out-of-range timeout, and a roster
  with nothing running answers `no_progress` instead of blocking.
  Delivered: one tool, `wait_members`, on the Harness's own `agent/status` event (`idle` ⇄ `running`),
  filtered by this Lead's roster child ids — not on the shipped `agentTeams.waitForChange`, which is
  notified from that same event but only for an agent its own membership test resolves, and a member
  spawned through `ctx.subagents` is not in its journal (`dsh-experimental-agent-team`
  `lib/types/roster.js:75-79`; its observer is `lib/index.js:1477-1480`). The timeout defaults to 30 s and
  is refused above 1 h; the description and the README state what it does not wait for. The live
  subscription is the owner's install check.
- [x] **P4-03** Retention: bound the session trash and the tombstone list.
  Done when a documented policy exists for `~/.dsh/team-roster/trash` and for tombstones whose Lead
  Session no longer exists, and running it twice leaves the same state.
  Delivered (v0.7.0, ADR 0011): the trash is bounded by a fixed per-Lead cap (`TRASH_LIMIT`, 20),
  enforced only inside a retirement that actually moved an artifact in — oldest first by the
  `<memberId>-<ms>` stamp, skipping a `pending` move, touching only direct children whose name and
  tombstone both parse. A pruned tombstone keeps `trashPath` and records `trashState: 'pruned'`,
  `restore_member` refuses with `reason: 'pruned'` and never calls the workspace, and the retirement
  reports `pruned`. Pruning twice leaves the same state. The tombstone half is a decision rather than a
  deletion: a tombstone is never dropped, because the drained row still sits in the parent's catalog and
  removing the tombstone re-adopts the member as a live ghost — ADR 0011 records why that alternative was
  rejected.
  Changed in v0.8.0 (ADR 0012): the cap is no longer the `TRASH_LIMIT` constant. `apply(ctx, config)`
  resolves the effective limit from the `trashLimit` field of this bundle's patch row, refuses a value that
  is not an integer of at least 1 at load — before any tool is registered — and the retirement enforces and
  prints that value. The documented default is `DEFAULT_TRASH_LIMIT` (20), so a profile that configures
  nothing behaves exactly as the v0.7.0 delivery above describes.

- [x] **P4-06** Member definitions on disk (v0.16.0).
  Done when a member can be started from a markdown file under `team/` in the Lead's working directory
  instead of from the call, the call's own arguments win over the file's and the result reports which
  parts came from where, an unknown field or a construct outside the documented flat frontmatter subset
  is refused by file and line, a malformed file does not stop a valid one, the size and count caps refuse
  rather than truncate, a Lead whose working directory cannot be resolved gets a typed refusal, and no
  create/update/delete tool is added for the files.
  Delivered with one new published module (`definitions.js`) and one optional `spawn_member` parameter,
  `definition`. The path is `<Lead working directory>/team/*.md`, resolved through
  `ctx.get('workingDirectory').ensure(leadAgent, signal)` — the service and method the installed spawn
  seam uses for a relative `cwd` — and never from `process.cwd()`; an absent service, a rejected `ensure`
  or a non-absolute answer is `reason: 'working-directory-unavailable'` with nothing reserved. The
  accepted frontmatter is `name` and `label` (required) plus `assignment`, `ephemeral`, `cwd`, `provider`,
  `model`, `reasoning_effort`, `max_tokens` and `agent_preset`; the body is the prompt. Nesting, list
  items, block scalars, anchors/aliases, merge keys, flow collections, duplicate keys, an unknown field, a
  key with no value and an empty body are refused with the file and the line (ADR 0018). Precedence is
  per field and reported: `definition.from_file` and `definition.overridden` name the fields, and
  `prompt` is the one the call cannot replace — the call's text is appended after the body and
  `definition.prompt` says `file` or `file+call`. A refused file is a `definition.problems` row on a
  successful spawn and a `problems` row on a refusal; a name two files declare refuses both; caps are
  16 KiB per file (refused per file) and 64 files per scan (refused per directory, never a partial set).
  `spawn_member`'s output schema is a two-branch `oneOf` (the member row, or the typed refusal), and the
  suite covers a definition supplying what it says, an explicit argument overriding it with the report,
  the four refused frontmatter shapes, an unknown field, a duplicate name, a malformed file beside a valid
  one, both caps, and the unresolvable working directory. The live start from a definition is the owner's
  install check.

- [x] **P4-07** A task body, and a board write that cannot undo a handover (v0.18.0).
  Done when a task carries a bounded body that `create` and `update` set and `update` clears, a body past
  the cap is refused rather than truncated, `list` returns it and a stored body outside the read rules is
  reported on the row, the handover brief still carries the id and title only, and an `update`, `release`
  or `delete` computed before a handover lands cannot undo it.
  Delivered (ADR 0020, which adjusts ADR 0017 from a new record): the field is `body`, capped at
  `TASK_BODY_MAX` (2000) and refused past it by `checkTaskBody`, with `body: null` as the way to clear it
  and the read path reporting an over-long or empty stored body as `problem` on the row while still
  serving it. The brief's line still names the id and the title only — the composition says so, and a test
  pins that a maximal body neither enters it nor grows it past its six lines. Every id-addressed board
  write is now built inside the serialized mutation from a fresh lookup of the record: `update` applies
  only the fields the call named, so a status or body change keeps the owner a handover gave the row, and
  `release`/`delete` — whose effect is subtraction — write nothing and answer `changed: false` with the row
  they found when its `status`/`owner` is no longer the one the call read. No revision parameter is added
  (ADR 0017 point 5 stands). `blocked_by`/readiness is refused again for the reason the ADR records —
  the shipped board's field only gates starting work and never participates in carrying it — with
  `context` (the tasks whose output this one uses) named as the shape to copy if ordering is ever wanted.
  The interleaving cannot be produced by real concurrency in a test, so `tests/task-detail.test.mjs`
  injects the handover through the table's serialized `update` hook for all three actions; the live
  `task_board` call is the owner's install check.

- [x] **P4-08** Team-scope settings in a versioned file (v0.19.0).
  Done when a Lead's handoff template can come from one optional file beside the member definitions,
  that file wins over the stored template and the built-in, the read form reports which of the three is
  in effect, a store or clear through the tool is refused while the file exists with the file named,
  the file's body is held to the placeholder rules, the reserved filename cannot be mistaken for a
  member definition, and a profile with no file renders the built-in brief byte for byte.
  Delivered (ADR 0021): the file is `<Lead working directory>/team/team.md`, resolved through the same
  `workingDirectory` service and `team/` join as a member definition, and parsed by the same frontmatter
  reader with no accepted field. Its body is the template, so the placeholder vocabulary, the required
  `{assignment}`, the unknown-token refusal and the 1000-character cap are the ones `handoff_template`
  already enforces; a file that fails them is reported in `file_problem` and falls through to the
  stored template, then the built-in. `team.md` is skipped by the definition scan, so a member may
  declare `name: team` in another file but the reserved filename is never a definition. The read answer
  keeps `template`, `stored`, `valid` and `problem`, adds `source` (`file`, `stored` or `builtin`),
  `file` and `file_problem`, and stays inside its declared schema. A set or clear while the file exists
  answers `handoff_template: the team file "<path>" is in effect, so a stored template would be
  shadowed and this write would change nothing. Edit that file to change the brief, or remove it to use
  handoff_template again.` Tasks remain on the Lead's roster record: they are lifecycle state written
  with a tombstone, unlike a template, which is a shape preference the project can version. The suite
  pins the file-over-store precedence, the refusal for both forms, the placeholder fallback, the
  reserved name, the no-file built-in brief and the unresolved-directory path; the live read/write stays
  the owner's install check.

- [x] **P4-09** A member reads the work it owns (v0.20.0).
  Done when a member Session that is not the Lead's can read the rows whose `owner` is its own target with
  one read-only tool registered in the member scope, a member owning nothing gets an empty list rather than
  an error, a caller that is neither the Lead nor a member is refused, the Lead's own tool set is
  unchanged, and the board keeps exactly one writer.
  Delivered (ADR 0022): `list_my_tasks`, no parameters, registered through `installMember` on every live
  and subsequently published non-root Agent. It returns the member's own `target`, its rows (id, title,
  body, status, timestamps and the read-time `problem`) and how many are open, filtered by
  `task.owner === caller's target` resolved from the caller's Session id — never from an argument. The
  Lead does not receive it (`task_board` is its whole board) and a child no roster names is refused, with
  the adoption trigger named; the read never adopts. The `{task_board}` brief pointer and the
  unrecorded-assignment fallback now name this Lead's own board and the member tool instead of the shipped
  board and "ask the Lead". `tests/entry.test.mjs` carries the owner-scope, empty-answer and non-member
  refusals and the schema conformance of a real member answer; the live call from inside a real member
  Session is the owner's install check.

### P3 — Settings panel (cancelled in v0.4)

> **Cancelled by [ADR 0008](docs/adr/0008-model-only-surface.md).** The panel and its HTTP bridge were
> removed: the panel was never rendered in a real profile and the owner reported its clicks did not
> work. The tasks below were delivered in code — P3-04 never was — and the surface they served is gone.
> The replacement is the model-facing work in P2-14, not a repair of P3.

- [ ] **P3-01** Choose the Host-to-Client data bridge. **Cancelled (v0.4):** the bridge was deleted with the panel.
  Done when an ADR names the mechanism and why the alternative was rejected. Delivered by ADR 0005: one
  loopback-only prefix route on the Host web server plus a client bundle registered into the settings
  section; the RPC registry, a duplicated operation body, a `resource` route and a push stream were the
  rejected alternatives.
- [ ] **P3-02** Read-only roster panel: name, generation, phase, live status, context pressure. **Cancelled (v0.4):** the browser half was deleted.
  Done when the panel renders the live roster and a change in the Host reaches the panel without a page
  reload. Delivered in code (a browser half plus `GET /api/team-roster/state`, polled while open); the
  live render is part of P3-04 because the bundle has not been reinstalled.
- [ ] **P3-03** Retire and replace actions with confirmation. **Cancelled (v0.4):** the panel was the second caller; `actions.js` stays.
  Done when the panel triggers the same operations as the model tools and reports their result. Delivered:
  the tool bodies moved to `actions.js`, and both `POST /retire` and `POST /restore` call those functions.
- [ ] **P3-04** Live verification of the Settings panel. **Cancelled (v0.4):** there is no panel left to verify.
  Done when a reinstalled bundle serves the client half, Settings → Team roster renders the live roster, the
  panel opens on the session the user is in and switches through the picker (with the "no roster" sentence
  for a session that has none), a change made through a tool appears within one poll, and a retire plus a
  restore from the panel return the same result objects the tools return. Not done: installing the bundle is
  the user's decision. This is the task that recorded the risk the owner then hit in real use.
- [ ] **P3-05** Scope the panel to one Lead Session. **Cancelled (v0.4):** the per-Lead-session roster model it relied on survives.
  Done when `GET /state` answers exactly one roster, `GET /sessions` answers a counts-only index, the panel
  opens on the session the user is in, offers a picker over the sessions that have a roster, and says so
  plainly when the current session has none. Delivered in code: `buildSessionState` and
  `buildSessionsIndex` in the deleted route module (the index owns the default-selection rule), the
  deleted panel resolved the current session from the shell's own session catalog and joined titles
  there (ADR 0006), and six tests pin both read shapes, the missing/unknown id answers and the rule. The
  live render stays with P3-04.
- [ ] **Gate P3** — the roster is manageable without typing a tool call. **Cancelled (v0.4):** the gate asked for a UI the owner no longer wants; the roster is managed by the model through `list_members`.

### P4 — Optional, only after the Gate P2 above

- [x] **P4-01** Ephemeral members: auto-retire on completion.
  Done when a member spawned with `ephemeral: true` leaves the roster through the normal retirement path
  once it has run and stopped, without a `retire_member` call, while a member that never ran and one still
  running are never retired.
  Delivered (v0.9.0, ADR 0013): `spawn_member.ephemeral` records the flag, `list_members` reports it, a
  lazy sweep at the start of `list_members` and `spawn_member` retires a member that carries `startedAt`
  and is no longer resident, `message_member` clears the flag, and a triggering result reports `swept`
  and `swept_targets` when it retired anything. The sweep is the existing `retire_member` protocol. There
  is no completion event to hook: the installed seam's descendant `activity` is only
  `running | inactive`, and `inactive` also covers a child that never started, so the sweep requires the
  plugin's own `startedAt` plus a non-resident live registry (`dsh-subagent` 0.2.2-rc.1
  `lib/index.js:2435`). The live end-to-end check on a real profile is the owner's install decision.
- [x] **P4-02** A stored, reusable handoff-brief template.
  Done when a Lead can store a brief template, read it back and clear it, a replacement renders it with the
  predecessor's real values, and a profile that stores none produces the built-in brief byte for byte.
  Delivered (v0.11.0, ADR 0015): `handoff_template` reads (no `template`), stores (a validated template)
  and clears (an empty string) one template per Lead, held on that Lead's roster record. The placeholders
  are `{successor}`, `{predecessor}`, `{label}`, `{assignment}` and `{task_board}`; an unknown placeholder
  is refused at set time by name, a template without `{assignment}` is refused with the reason, and both
  the template (1000 characters) and the rendered brief (2000) are refused rather than truncated. The
  built-in brief is the default template rendered by the same code, so a profile that stores none is
  byte-identical, and `list_members` rows are unchanged — the read form of the tool answers. The live
  tool call and the rendered brief still need the owner's install check.
- [x] **P4-04** File the missing lifecycle upstream with the evidence gathered here. (Was labelled
  P4-03 until v0.8.0; that ID belongs to the retention task, and two tasks sharing one ID made the
  reference ambiguous.)
  Delivered (v0.14.0): `docs/upstream-lifecycle-gap.md` states the gap — the closed phases and the
  permanent projection failure, the absent Session-deletion API, the frozen stored names — with every
  claim cited by file and line to this repository's own evidence, plus one short section of suggestions.
  It is registered in both indexes. The document is the paste-ready issue text; opening the issue against
  the experimental packages is the owner's action, not something this repository can do.
- [x] **P4-05** Spawn capabilities: forward `cwd`, model options and an agent preset, and make a refusal
  say where a name went (v0.12.0).
  Done when `spawn_member` can start a member in its own working directory, on a chosen provider/model
  route and under a declared agent preset, each omitted field inheriting the Lead's value; a spawn that
  passes none of them composes the exact request it composed before; a Host capability refusal becomes a
  typed result (`started: false` with a `reason`) with no member left `provisioning`; the result reports
  what was applied in `started_with`; and a refusal for a stale target carries `current_holder` naming
  the live holder of that name.
  Delivered: one nested `spawn_options` parameter (`cwd`, `agent_options`, `agent_preset`), with
  `activationOptions` as the single place the tool vocabulary maps to the activation request; refusals
  routed on the seam's `error.code` (`UNSUPPORTED_CAPABILITY`, `PRESET_UNAVAILABLE`,
  `agent-preset/not-found`, `agent-preset/invalid`, `UNAUTHORIZED`); and `currentHolderOf` reported by
  the four target-scoped refusals (ADR 0016). The suite pins the exact no-argument request, each
  forwarded field, the typed refusals and the holder. The live start of a cwd/model/preset is the
  owner's install check.

- [x] **P4-10** The shipped team panel lists this plugin's live members (v0.21.0).
  Done when every host exit that carries an `agentTeam` value — the `projections` baseline, a `list` row,
  the `control` baseline map, a `control` change frame and a `follow` snapshot — serves this Lead's live
  members as the four fields the strict wire schema requires; a member already present is neither
  duplicated nor re-roled; a retired member is still absent from every exit; a member with no recorded
  child id is not added; a host without `sessionController` is skipped; and dispose restores every
  wrapped method.
  Delivered (ADR 0023): the existing projection filter gains `mergeLiveMembers` beside
  `stripRetiredMembers`; `index.js` supplies `livePanelMembers(roster)` (phase `active` plus a child id,
  `name` = the model-facing target) through a synchronous roster-table read; and the synthesised row is
  exactly `{ id, name, role: 'teammate', phase: 'active' }`. Retirement stays absence, the Session log is
  never written, and the shipped task section is deliberately not overlaid (ten wire fields this board
  does not have). The suite pins all five shapes, the duplicate case, the strip-and-merge order, the
  no-op, the missing-child-id filter and the disposer; the rendered panel is the owner's install check.

- [x] **P4-11** A member runs on the API of the Session that started it, and a straggler is visible (v0.22.0).
  Done when a spawn that supplies no `spawn_options.agent_options` resolves the calling Lead's current
  `provider` and `model` from its own Session and forwards them as the activation request's `agentOptions`;
  an explicit caller option still wins and the result says which source the route had; `reasoningEffort` is
  never added; a route that cannot be resolved, and a provider that does not advertise `agentOptions`, both
  inherit exactly as before, report which of the two fallbacks ran, and never fail the spawn; the route is
  recorded on the member record and reported on the `list_members` row; and a row whose recorded route
  differs from the Lead's current one is flagged with a sentence naming the replacement that clears it,
  while a matching one is not, a later match clears the flag, and an unreadable Lead route flags nobody.
  Delivered (ADR 0024): `resolveSpawnRoute` reads `caller.session.requestHeader()?.config` — the seam's own
  inheritance source — behind a type check and a `try`, and the provider probe is
  `ctx.subagents.getProvider('spawn')?.capabilities.agentOptions === true`, so `UNSUPPORTED_CAPABILITY` is
  never reached. The record field is `route` (`{ source, provider?, model?, select_reason? }`,
  `source` = `caller` | `plugin` | `inherited`, `select_reason` = `no-session-route` |
  `capability-absent`), validated structurally on load and optional for every pre-v0.22.0 record; the row
  adds `route`, `route_stale` and `route_note`, and `started_with` gains `route_source`. The remedy is the
  existing replacement (`spawn_member { replace }`), documented in the README pair, with no new tool.
  `tests/route.test.mjs` covers the twelve cells and `tests/entry.test.mjs` validates the new fields against
  the declared schemas; removing the forwarding makes the main test fail (verified before and after). The
  route on a real child's own `request/header` is the owner's install check.

- [x] **P4-12** A host hook installs when the service it wraps exists, and the plugin reports whether it did (v0.24.0).
  Done when a profile that publishes `sessionController` after this plugin activates still gets the
  projection filter, the shipped `list_agents` read drops a retired member, a hook that can never install is
  reported `absent` in `list_members` while every tool keeps working, a reload does not wrap twice, dispose
  restores every wrapped method, and a failed tombstone read is reported instead of serving every row.
  Delivered (ADR 0025): the three host effects are each gated with `ctx.inject([service], callback)` — the
  Cordis dependency mechanism, not a polling loop — so the projection filter waits for `sessionController`
  and the shipped roster read plus the slot credit wait for `agentTeams`; the callback's disposer unwinds
  the patch with this plugin's own fiber, and each installer keeps its reload mark, so a second load reuses
  the installed wrapper. `host-hooks.js` gains `createRetiredCache` (one tombstone set, with the last good
  set kept and the failure reported on a read that throws) and `installRosterFilter`, which replaces
  `agentTeams.listMembers` synchronously — the shipped `list_agents` tool maps the returned array without
  awaiting it — and drops only the retired ids, keeping `lead` and every live row. `list_members` answers
  `host_hooks` (`panel_filter`, `roster_filter`, `slot_credit` as `installed`/`absent`, `stripped_ids`,
  `tombstone_read_failed`, and a `message` naming the absent hook and its service), declared in that tool's
  output schema. `retire_member` also states on the model-facing surface that a member is a division of
  labour rather than a task, so a finished piece of work is not a reason to retire anyone and a judgement
  call asks the person first. `tests/hook-install.test.mjs` drives a fake of the Cordis gate and covers the
  deferred install, the never-appearing service, the reload, the dispose and both invalidations;
  `tests/host-hooks.test.mjs` pins the 37-row/5-tombstone strip, the 36-entry catalog frame and the failed
  read. Removing the deferred install makes the main test fail (verified before and after, with the test
  file's SHA-256 unchanged). The live install is the owner's install check.

- [x] **P4-13** A member's lifetime is declared, and ending a role asks the person (v0.25.0).
  Done when `spawn_member` takes `lifetime: "standing" | "one-shot"` with `ephemeral` still accepted as the
  older spelling; the declaration is never inherited from a predecessor or a definition file; the sweep
  retires a member only when it is one-shot, has started, is no longer resident **and** owns no `open` row,
  and reports the rows that vetoed it with the call that clears each; a standing member is never retired
  automatically and `retire_member` refuses it until the call carries the person's answer quoted verbatim;
  `message_member` re-opens a one-shot member without changing its declared lifetime; and a one-shot member
  handed work at least twice is flagged as probably standing without being converted.
  Delivered (ADR 0026, which supersedes ADR 0013 point 5 and removes `ephemeral` from the accepted
  definition fields that ADR 0018 and ADR 0019 point 3 wrote): `roster.js` gains `LIFETIME`, `RETASK_MIN`,
  `lifetimeOf` and `declaredLifetime`, and validates the two optional counters; `definitions.js` refuses a
  file-declared `lifetime` or `ephemeral` by name with the reason; `actions.js` resolves one declaration per
  spawn, gates the sweep on the board, refuses a standing retirement with `reason: 'needs-confirmation'` and
  the question to ask, echoes the quoted sentence on the retry, and re-opens rather than re-declares;
  `index.js` declares every new field — `lifetime` (required on a member row), `retasked`/`retasked_note`,
  `blocked`/`blocking_tasks`/`blocking_note`, `reopened`, and the refusal's `question`/`owns_tasks`/
  `assignment` — because a field the host does not see declared is dropped after the side effect. A `replace`
  and the sweep call the same retirement with `consentRequired` false: a replacement continues the role, and
  a one-shot member's declaration already was the person's consent. The gate also skips a record that never
  became a role — `failed` never started and an already-`retired` tombstone has no life left to end — so
  removing a reservation that never held a role stays cleanup. The stored field is deliberately not
  renamed, so every existing roster loads unchanged. `tests/lifetime.test.mjs` (replacing
  `tests/ephemeral.test.mjs`) covers the seven decisions, `tests/entry.test.mjs` proves the consent gate
  fires through the real `retire_member` tool, and `tests/definitions.test.mjs` and
  `tests/task-board.test.mjs` cover the removed field and the veto. Removing the board veto makes the veto
  test fail (verified before and after, with the test file's SHA-256 unchanged). The live sweep and a live
  consent refusal are the owner's install check.

- [x] **P4-14** The consent gate asks only when a standing member still carries something (v0.25.1).
  Done when `retire_member` refuses a standing member without quoted words only if that member has a
  recorded `assignment`, owns at least one `open` row on this Lead's board, or shows the `retasked` evidence;
  a standing member with none of the three retires in one call on a stated `reason`; a call stating no
  reason is refused as `needs-reason`; both refusals name the rule that stopped them;
  and no config field or third lifetime value is added.
  Delivered (ADR 0026 gains *The gate narrows to what a member carries* and keeps the earlier, stricter
  reading as its record, per the owner's decision after live acceptance): `carriedBy` reads the three
  carriers from the record and the board, the gate branches on it and returns either the consent refusal
  (now carrying `carries`) or a new reason refusal, and a housekeeping retirement says so in its result.
  The third carrier needed one change outside the gate: `message_member` counted only one-shot members, so a
  standing member's counters were permanently zero and "was re-tasked" could never be true — they are now
  written for every accepted message on every member, while the `list_members` advice built from them stays
  one-shot-only. `lifetime`, the veto, `blocked`/`blocking_tasks`, the sweep's three conditions and the
  `failed` exemption are unchanged, and the sweep path was not touched, so `swept` still appears on a read as
  well as on a spawn. `tests/lifetime.test.mjs` covers all five required cases; widening the gate back to
  "every standing member" makes the bare-member cases fail (verified before and after, with the test file's
  SHA-256 `69C1F7DA94F593CA2C9175B6C53DD9D136CBD952295C9491897E33322A6FF42A` on both sides). The live
  refusal and the live housekeeping retirement are the owner's install check.

- [x] **P4-15** The bilingual-pair check is a rule over `docs/`, not a list of pairs (v0.25.2).
  Done when a new `docs/foo-en.md` without `foo-zh.md` fails the check by name in either direction, a
  deliberate single-language document cannot pass unless it is declared with a reason, `*-en-zh.md` is
  proven to hold both languages rather than merely named so, root documents are handled explicitly rather
  than falling through the scan, and the rule is stated in `CONTRIBUTING.md`.
  Delivered (the external review's §3): `scripts/check.mjs` classifies every top-level `docs/*.md` and fails
  the ones it cannot, with `SINGLE_LANGUAGE_DOCS` as the only escape — one entry today,
  `upstream-lifecycle-gap.md`, because that document is the issue-ready statement of the gap addressed to the
  English-language upstream tracker. The allow-list was chosen over a naming convention because it carries
  the reason, fails closed, and detects a stale entry. Only `scripts/check.mjs` and `CONTRIBUTING.md`
  changed; no `docs/` file was touched, which leaves the parallel split of `docs/` to be classified by the
  new rule when it lands. All four branches were proved able to fail by temporary probes that each named
  their file, and `scripts/check.mjs` hashed
  `A98F2B9F2BAE655F2E92DAC2AB442698A0F95436ECD4F9B05913FE90FB6FA4BB` before and after the probe session.

