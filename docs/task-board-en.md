# Task board

> Owner: @FrozenYty · Revisit when: a task row, a board action, or a handover rule changes

The work board this plugin owns: the rows on the Lead's roster record, the caps and load rules that
apply to them, what a board write guarantees when two calls overlap, and the matrix that decides what
happens to a member's open work on replace, retire and restore. The record those rows live on is
`docs/roster-storage-en.md` §1; the brief that names them is `docs/handoff-en.md` §1.
Decisions: ADR 0017, ADR 0020, ADR 0022.

## 1. The board: rows, caps, and what a load refuses

`tasks` follows the same split as the stored template (`docs/handoff-en.md` §3), and goes one step
further. Its **structure** is
validated on load — an array, every row an object with an `id` string, a known `status`, a non-empty
`owner` when present, and no id twice — because a roster that cannot represent a task cannot answer
for one. Its **content** is not: a title or a body that is merely too long, or a list that grew past
the write-time cap before this release existed, loads and is reported by the read (`problem` on the
row, `docs/architecture-en.md` §5) rather than refusing the domain. That is the `handoffTemplate`
precedent applied where it matters most: one Lead's stale task would otherwise hide every roster in
the profile, including the retirement that exists to repair that team. The three write-time caps are
refused, never truncated: `TASK_TITLE_MAX` (200), `TASK_BODY_MAX` (2000) and `TASK_LIMIT` (200 tasks
per Lead, `done` included).

## 2. The transfer matrix (P2-09)

The work a member carries is not only its `assignment`. It is the open tasks on this Lead's board
that name it as their owner (`docs/roster-storage-en.md` §1), and what happens to those rows at each
event is decided here, before the code (AGENTS.md §4.8). Three questions per cell, and all three
have an answer:

- what happens to the member's **open** tasks;
- what the call **reports** about them;
- whether its **done** tasks move.

**No cell moves a `done` task.** Finished work belongs to the record that finished it, so a `done` row
keeps its owner through every event in the table, including the events that retire that owner. That is the
one rule the whole matrix rests on: a handover hands over *work still owed*, not a history.

| Event | The member's open tasks | Result fields | Done tasks |
|---|---|---|---|
| `spawn_member` with `replace` succeeds, and the predecessor retires | re-addressed to the successor before the tombstone is written: the same rows, a new `owner` | `transferred` (count) and `transferred_tasks` (ids); the retirement record contributes no second copy | stay with the predecessor's tombstone |
| `spawn_member` with `replace` on an **already-retired** predecessor | re-addressed to the successor, together with every other open task nobody owns — the work was left unowned by the earlier retirement, and this is the successor it was waiting for | `transferred` and `transferred_tasks`, and the message names them; the retire half answers `already-retired` and adds nothing | stay where they are |
| a **failed successor start** | nothing moves: the predecessor is untouched and still live | the thrown error says the predecessor was **not** retired, and no task field appears because no task moved | unchanged |
| a **failed retirement behind a started successor** | already moved: the handover is the first write, so the successor the caller started still carries its work | `predecessor_retired: false`; `transferred` is **absent**, because this call transferred nothing (a previous attempt did) | unchanged |
| `retire_member` with **no successor** | the owner is cleared: the rows stay `open` and become unowned, because the work is still owed | `unowned` (count), `unowned_tasks` (ids), and the message says nobody will carry them | stay with the tombstone |
| **restore** of a member whose tasks were transferred | unchanged: a restore recovers a lifecycle record and an artifact, it does not re-assign work | `unowned` / `unowned_tasks` report the work still waiting for an owner — a fact, not a claim; no owner is written | unchanged |
| retirement by the **one-shot sweep** | the owner is cleared, through the same retirement the model would have called — and only for a member that owned nothing when the sweep looked, because an owned open row is the veto that stops it (`docs/member-lifecycle-en.md` §2) | the triggering call's `swept`/`swept_targets`; `unowned`/`unowned_tasks` appear only if a row was created for that member between the veto read and the retirement | stay with the tombstone |
| an open task whose **owner name was later reused** by a new generation | nothing happens by name: `owner` is a *target*, and generation 2 of a name is `reviewer-g2`, a different target. A new generation inherits nothing by name alone, and the old target still resolves for re-assignment because a retired member is a valid owner handle | none | unchanged |
| a task carrying a **`body`** through a handover | the row is re-addressed like any other one: the body moves with it, because the body belongs to the task and not to the member that happens to hold it | the same `transferred` / `transferred_tasks`; the brief names the id and title only, so the successor reads the body from the board with `list_my_tasks` (`docs/architecture-en.md` §5.2) | stays with the predecessor's tombstone |
| a **`task_board` write racing a handover** (`update`, `release` or `delete` computed before it lands) | `update` applies only the fields it names to the row as stored, so a status or body change keeps the successor's owner; `release` and `delete` find a row whose `status`/`owner` is no longer the one they read and write nothing at all | `changed: false` with the row as stored and a message naming what moved and how to repeat the call; `delete` also omits `deleted` | unchanged |

What the cells depend on:

- **The handover is the first write of a replacement, before the tombstone.** A successful start, then one
  mutation that re-addresses the rows, then the retirement record. A failed start therefore moves nothing,
  and a failed tombstone leaves a live member whose work already belongs to its successor — a partial
  lifecycle whose next step is one more `retire_member`, not a lost task. The order is the reverse of the
  retirement's own tombstone-first rule (`docs/member-lifecycle-en.md` §3), and for the same reason: the operation that can fail must
  fail on the half that is recoverable.
- **Unowned work is adopted only by a replacement.** A retirement creates unowned rows and a replacement
  consumes them, so a `spawn_member` with `replace` picks up every open row nobody owns, including rows it
  did not orphan. Nothing else claims them, and no read ever assigns an owner.
- **A transfer writes ownership, never status.** A row stays `open` through a handover; only `task_board`
  with `action: update` turns it `done`, which is also the only way a row stops being inherited.
- **A board write is rebuilt from the row it lands on, and subtraction has a premise.** Every id-addressed
  task action re-reads the row inside the serialized mutation (`docs/roster-storage-en.md` §1): `update` merges the fields it names,
  and `release`/`delete` answer `changed: false` instead of removing an owner or a row that a handover
  changed since the call read it. That is what keeps the replacement row above true when the two calls
  overlap rather than merely follow one another (ADR 0020).
- **Two tools in one model turn.** Every task mutation is one atomic `update` on the roster table, like
  every member mutation (`docs/roster-storage-en.md` §1), so a `task_board` call and a replacement in the same turn see each other's
  write instead of overwriting it.
- **A definition-spawned successor cannot be one-shot, because a file cannot declare a lifetime.** A
  `replace` names `lifetime: "one-shot"` on the call if the successor really is fan-out work, and then the
  same veto applies as to any one-shot member: the work this matrix just moved to it keeps it on the roster
  until the Lead closes those rows (`docs/member-lifecycle-en.md` §2, `docs/architecture-en.md` §6.1, ADR 0026).

## 3. A board write is built from the row as stored

**A board write is built from the row as stored, inside the serialized mutation.** The read a `task_board`
call makes at its start states the *premise*, and is never a row to write back: the mutation looks the task
up again in the record `updateRoster` hands it and builds the next row from that. `update` therefore
applies only the fields the call named — a status change keeps the owner a handover gave the row, and a
body amendment keeps everything else — while `release` and `delete`, whose effect is subtraction, apply
only to the state the call read: when the stored row's `status`/`owner` is no longer the one in the
snapshot, they write nothing and answer `changed: false` with the row they found. A row that vanished
between the read and the write draws the same refusal an unknown id draws. That is what makes "only the
person changes, not the work" hold under concurrency and not only in sequence: a replacement's handover
cannot be undone by the next board call, and the model is asked to track no revision and no schema gains a
parameter (ADR 0017 point 5, ADR 0020).
