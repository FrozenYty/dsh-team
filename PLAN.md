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
| C — UI | Settings panel, Host-to-Client bridge |

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
- [ ] **P2-05** `replace_member`: retire a member and spawn a successor addressed by the brief.
  Done when the successor starts from the brief pointer, not from the predecessor's transcript.
- [x] **P2-06** The model-facing surface: `list_members`, `message_member`, `stop_member`.
  Done when every roster tool refuses a retired member with a typed reason.
- [ ] **P2-07** (re-scoped) Retire the shipped team tool row, after an own task board exists (P2-09).
  Adoption made the shipped row unnecessary for removal, and disabling it today would remove the shared
  task board. Done when the shipped roster tools are absent from a Lead's tool list, the plugin's own
  task tools replace them, and nothing else regressed.
- [ ] **P2-08** Live end-to-end verification of a replaced member finishing its predecessor's task.
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

### P3 — Settings panel

- [ ] **P3-01** Choose the Host-to-Client data bridge.
  Done when an ADR names the mechanism and why the alternative was rejected.
- [ ] **P3-02** Read-only roster panel: name, generation, phase, live status, context pressure.
  Done when the panel renders the live roster and a change in the Host reaches the panel without a page
  reload.
- [ ] **P3-03** Retire and replace actions with confirmation.
  Done when the panel triggers the same operations as the model tools and reports their result.
- [ ] **Gate P3** — the roster is manageable without typing a tool call.

### P4 — Optional, only after the gate above

- [ ] **P4-01** Ephemeral members: auto-retire on completion.
- [ ] **P4-02** A stored, reusable handoff-brief template.
- [ ] **P4-03** File the missing lifecycle upstream with the evidence gathered here.
