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

- [ ] **P2-01** Choose the durable store for the roster and write down the record shape.
  Done when `docs/architecture-en.md` names the service, the record fields and the key design, backed by
  a spike report rather than a guess.
- [ ] **P2-02** Write the roster state matrix (phases × events) before implementing transitions.
  Done when `docs/architecture-en.md` contains the matrix with every cell decided, including
  retire-versus-spawn races and messages to a retired member.
- [ ] **P2-03** Roster service: spawn a member with a generation-suffixed name through `ctx.subagents`.
  Done when a spawn returns a member record carrying the child Session id and the name is unique in the
  roster.
- [ ] **P2-04** `retire_member`: handoff brief, drain, tombstone.
  Done when a retired member stops receiving work, its record says `retired`, and its context is no
  longer reachable through the roster tools.
- [ ] **P2-05** `replace_member`: retire a member and spawn a successor addressed by the brief.
  Done when the successor starts from the brief pointer, not from the predecessor's transcript.
- [ ] **P2-06** The model-facing surface: `list_members`, `message_member`, `stop_member`.
  Done when every roster tool refuses a retired member with a typed reason.
- [ ] **P2-07** Bundle patch disables the shipped team rows and documents the fallout.
  Done when the official roster tools are absent from a Lead's tool list and nothing else regressed.
- [ ] **P2-08** Live end-to-end verification.
  Done when, in one session, a member is retired and replaced and the successor finishes the
  predecessor's task.
- [ ] **Gate P2** — removal and replacement work in a live session.

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
