# 0017 — The board this plugin owns, and the handover that moves work rather than naming it

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —
- **Points 1, 4, 5, 6 and 11 and the dependency alternative adjusted by
  [0020](0020-task-body-and-write-integrity.md)** — the row gains a bounded `body` (so `update` reads three
  fields, not two), an id-addressed write is rebuilt from the record as stored (`release` and `delete` act
  only on the state they read), and `blocked_by` is refused with its reason. The rest of this ADR stands.

## Context

A member's work is one `assignment` string. So a retirement hands over a *description* of the work and
nothing else: a successor starts with a sentence, and any unfinished item the predecessor carried exists
only in prose (ADR 0009). The shipped Agent Teams plugin has a shared task board, but it is the shipped
roster's board. This plugin's members can be retired, and P2-07 exists to disable that shipped tool row —
so the shipped board cannot be the source of truth for work that outlives a member.

P2-09 asks for a board this plugin owns and for the two events that make it matter: a replacement transfers
the predecessor's open tasks to the successor, and a retirement without a successor leaves them unowned and
says so.

Five constraints shaped the design, and each had a candidate that was wrong for a reason worth writing
down:

1. **The record is one JSON document per Lead** in a single-file `storageDomain` domain (ADR 0003), and the
   facility **validates every record of every Lead when it opens that domain** (`invalid-record`, naming
   the table and key). A content rule enforced there lets one Lead's stale task hide every roster in the
   profile. `handoffTemplate` had already met this problem and answered it (ADR 0015); this ADR follows
   that answer.
2. **A tool schema is validated by the host, and a keyword outside its accepted subset does not fail one
   tool: it fails the plugin.** v0.12.0 shipped `minimum` on a shared object and every tool went missing
   while the unit tests stayed green. Every schema here is inside `type/oneOf/properties/required/
   additionalProperties/items/enum/const` plus annotations, and `scripts/check.mjs` refuses the rest.
3. **The surface is already eight tools**, and the house style is `verb_noun`. Five more names for one row
   shape is a surface the model pays for on every call.
4. **A brief is short by construction.** A cold child pays for every word, and a brief that inlines a
   backlog is no longer a brief. But a brief that carries only a pointer is the gap this task exists to
   close.
5. **A transfer has to be atomic with the record it belongs to.** A reader must never see a live successor
   beside work that still names a tombstone, and a crash must not lose a task into no-man's-land.

## Decision

**A task lives on the Lead's roster record; one tool reads and writes the board; a replacement hands the
board over; a retirement without a successor un-owns it and names it.**

1. **The shape is `{ id, title, status, owner?, created_at, updated_at? }`** on a `tasks` array on the
   Lead's roster record, next to `handoffTemplate`. `id` is a `randomUUID()` generated at create time,
   `title` is bounded display text, `status` is `open | done`, `owner` is a member **target** (the same
   handle every member-scoped tool takes), `created_at` is an ISO timestamp and `updated_at` appears after
   the first write. Optional, so every record written before this release loads and behaves as it did.
2. **The owner is a target, not a name and not a member id.** A target is unique among the members a Lead
   can address, so `owner: "reviewer"` can never silently come to mean generation 2 of that name — a
   generation-2 successor is `reviewer-g2`, a different handle. A retired member is still a valid owner
   handle, because a task may legitimately sit on a tombstone until a successor arrives.
3. **`done` never moves.** Finished work belongs to the record that finished it. Every handover, every
   retirement and every restore leaves `done` rows exactly as they are, which is what keeps the matrix in
   `docs/task-board-en.md` §2 answerable in three columns.
4. **One tool, `task_board`, with an `action` enum: `list`, `create`, `update`, `release`, `delete`.**
   The alternative was five `verb_noun` tools (`create_task`, `list_tasks`, …) at a cost of five names,
   five descriptions and five result schemas for one row shape and one refusal vocabulary. The enum is
   readable: one string, five actions, and at most two optional fields that each action reads — `title` for
   create, `task_id` for the id-addressed actions, `status` and `owner` for update. `action` is the only
   required parameter, so the schema states what the call does and nothing else.
5. **Compare-and-set is the transition itself, and it is idempotent.** An earlier draft of `PLAN.md`
   mentioned a compare-and-set for the board. It is not a parameter: the only state a board row has is
   `status` and `owner`, the actions that change them are named (`update`, `release`), and every one of
   them answers `changed: false` with the current row when the write would change nothing. A caller that
   already believes the task is done therefore gets an answer, not an error, and re-running any action is
   safe.
6. **The caps are refusals, never truncation.** `TASK_TITLE_MAX = 200`, matching `LABEL_MAX` — a title and a
   label are the same kind of display text, and the shipped roster bounds a member description at the same
   number. `TASK_LIMIT = 200` tasks per Lead, `done` included, because the whole array is what the
   single-file domain rewrite pays for; it is an order of magnitude above a plausible handover backlog and
   two orders above the largest brief this plugin renders. Both refuse with the number and the way out, like
   `checkAssignment`, `checkLabel` and `resolveTrashLimit`.
7. **The handover is a replacement's first write after the start, and it hands over exactly two things:**
   the open tasks that name the predecessor as owner, and every open task that names nobody. Unowned work
   is work a successor is for. The write happens before the predecessor's tombstone, so a retirement whose
   tombstone write then fails leaves a live predecessor whose work already belongs to its successor — a
   partial lifecycle whose next step is one more `retire_member`, not a lost task. A failed *start* moves
   nothing, because the handover comes after it.
8. **A retirement with no successor clears the owner instead of deleting the row.** The work is still owed,
   so it stays `open`; the result reports `unowned` and `unowned_tasks`, and `task_board` `list` reports the
   same, so orphaned work is visible from two directions. There is no auto-assignment anywhere: no read
   ever writes an owner.
9. **`restore_member` assigns nothing.** Whether a returning member should get its old work back depends on
   who took it over while it was gone, and the record cannot tell "the successor carries this" from "nobody
   does" without guessing across a handover. The restore reports `unowned`/`unowned_tasks` — a fact — and
   changes no owner.
10. **The brief carries the board, bounded.** The composition adds one line naming the predecessor's open
    tasks by id *and* title: an id alone is a round-trip for a successor that cannot look the task up, and a
    title alone cannot be marked done. The line is bounded at 5 rows and 600 characters, and a list that
    would not stay under either bound is dropped entirely, leaving the `{task_board}` pointer sentence — so
    a successor whose predecessor owned no open task gets the byte-identical brief the previous release
    produced, which a test pins.
11. **Load-time validation is structural; content problems are reported on read.** `parseRoster` refuses a
    `tasks` value that is not an array, a row that is not an object, an `id` that is not a non-empty string,
    an unknown `status`, a present-but-empty `owner`, and a duplicated id — because a roster that cannot
    represent a task cannot answer for one. It does **not** enforce the title cap or the task cap: a stored
    row that breaks either loads, is served by `list` with `problem` on the row, and is left in place.
    Refusing the domain there would hide every roster over one Lead's task list.

## Rationale

- The board is durable state about a Lead's team, and the roster record is the thing that already survives a
  member's retirement. Putting tasks anywhere else would need a second key space, a second lifecycle and a
  second answer to "what happens when the owner is retired".
- The owner is a target because the target is the handle the whole tool surface already uses; a member id
  would be a second addressing mode, and a base name would be ambiguous the moment a name has a successor.
- Writing the handover before the tombstone is the same reasoning as the tombstone-before-move rule
  (ADR 0004) with the failure direction reversed: there, a crash must not leave a session behind an `active`
  record; here, a crash must not leave work behind a tombstone. In both cases the durable record is written
  on the side that a later call can finish.
- One tool with an enum is the smallest surface that still names each operation. The refusal vocabulary
  (`no task with the id`, `status must be "open" or "done"`, `no member named …`) is shared by every action,
  which is what makes five schemas unnecessary.

## Alternatives rejected

- **A shipped-board passthrough.** Reading the shipped board through `ctx.agentTeams` would keep one board,
  but it is the shipped *roster's* board: P2-07 exists to disable that row, and a plugin whose source of
  truth is a row it is about to switch off has no source of truth. It also cannot be written atomically
  with this plugin's own retirement write.
- **Priorities, dependencies, comments, sub-tasks, due dates.** Each is a field, a validation rule, a
  result field and a test, and none of them is needed for the one question this board answers: *what work
  does the successor carry now?* Dependencies in particular would need a graph and an ordering rule, and a
  handover would have to decide what to do with a task whose dependency is still open — a decision P2-09
  does not need. `PLAN.md`'s "dependencies" is answered by the transfer: an id and a title are what the
  successor needs, and the dependency order stays the Lead's judgment.
- **Five `verb_noun` tools.** Triples the surface for one row shape; the enum states the same thing in one
  parameter.
- **A separate `transfer_tasks` tool.** The transfer is not an operation the model should have to remember:
  it is part of what `replace` means, and a model that forgets the second call loses the work.
- **Deleting the open tasks on retirement.** Simpler, and wrong: a retirement without a successor would
  silently drop the work, which is the defect P2-09 exists to fix.
- **Moving `done` tasks to the successor.** It would make the successor's board a history of its
  predecessor, and "what is still owed" would need a filter to read.
- **Enforcing the caps in `parseRoster`.** One Lead's long title would fail the domain open and hide every
  roster (`invalid-record`), exactly as a malformed `handoffTemplate` would have (ADR 0015).
- **Truncating a title, or dropping the oldest task at the cap.** A truncated title is one the model did not
  write, and a silently dropped task is work that vanished; both are the failures the other caps in this
  plugin already refuse.
- **Storing tasks in a new domain or a second table.** A second key space keyed by the same Lead Session, for
  state that must be written in the same breath as a tombstone.
- **Assigning unowned work on read.** A read that writes an owner has to guess, and the guess is invisible
  until someone checks. Only a call that says who acts does so.
- **Reporting the board in `list_members` rows.** It is the Lead's board, not a member fact; every row would
  repeat it. `task_board` answers instead (the same rule as ADR 0015 point 8).
- **Migrating the shipped board's rows.** There is no stable read of them from this plugin, and a migration
  that runs once and disagrees with the shipped board afterwards is worse than a Lead re-creating two rows.

## Consequences

- `roster.js` gains `TASK_STATUS`, `TASK_TITLE_MAX`, `TASK_LIMIT`, `checkTaskTitle`, `tasksOf`, `findTask`,
  `withTask`, `planTask`, `openTasksOf`, `reownerTasks` and the `tasks` structural validation; `actions.js`
  gains `taskBoard`, the handover and the un-owning path; `index.js` gains one tool and the three result
  shapes it answers with. The record shape gains one optional field, so no migration is needed.
- A replacement result can now carry `transferred` / `transferred_tasks`, and a retirement result can carry
  `unowned` / `unowned_tasks`; both are absent when the member owned no open task, so a profile with an
  empty board sees exactly the results it saw before.
- Orphaned work is durable and visible: it survives a Harness restart, `list` reports it, and any retirement
  or restore result that touched it names it. Nothing cleans it up automatically, which is deliberate — a
  task nobody owns is a decision the Lead has not made yet.
- The shipped task board's rows are untouched and unread. A Lead that keeps work on the shipped board gets
  the old behaviour (a pointer under the predecessor's name) until it moves the rows; P2-07 is what finally
  removes the shipped row, and it needs this feature to exist first.
- The version moves to `0.13.0`.

## Revisit when

The Harness ships a team-scoped task primitive this plugin could adopt instead of storing its own (then the
shipped row could be retired without a board of ours), the storage facility gains a per-record partial
validation that would let content rules live on load, or a Lead needs more than an owner per task — a
priority, a deadline, or a real dependency — which is a new decision with a new ADR, not a field added
quietly to this one.
