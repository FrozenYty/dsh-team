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
  Done when `docs/architecture-en.md` names the service, the record fields and the key design, backed by
  a spike report rather than a guess.
- [x] **P2-02** Write the roster state matrix (phases × events) before implementing transitions.
  Done when `docs/architecture-en.md` contains the matrix with every cell decided, including
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
- [ ] **P2-07** (re-scoped) Retire the shipped team tool row, after an own task board exists (P2-09).
  Adoption made the shipped row unnecessary for removal, and disabling it today would remove the shared
  task board. Done when the shipped roster tools are absent from a Lead's tool list, the plugin's own
  task tools replace them, and nothing else regressed.
- [x] **P2-08** Live end-to-end verification of a replaced member finishing its predecessor's task.
  Done when, in one session, a member is retired, a successor starts from a handoff brief, and the
  successor completes the predecessor's task without redoing it.
- [ ] **P2-09** Own task board: create, list, read, compare-and-set, dependencies.
  Done when the four task tools are served by this plugin and P2-07 can proceed.
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

- [ ] **P4-01** Ephemeral members: auto-retire on completion.
- [ ] **P4-02** A stored, reusable handoff-brief template.
- [ ] **P4-04** File the missing lifecycle upstream with the evidence gathered here. (Was labelled
  P4-03 until v0.8.0; that ID belongs to the retention task, and two tasks sharing one ID made the
  reference ambiguous.)
