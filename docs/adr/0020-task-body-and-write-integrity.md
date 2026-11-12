# 0020 — A task carries a bounded body, and a board write cannot undo a handover

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —
- **Adjusts [0017](0017-own-task-board.md) for points 1, 4, 5, 6 and 11 and one rejected alternative** — the
  row gains a bounded `body` (so `update` reads three fields, not two), an id-addressed write is rebuilt
  from the record as stored, `release` and `delete` act only on the state they read, and `blocked_by` is
  refused a second time with its reason. The rest of 0017 stands: the board lives on the Lead's roster
  record, the owner is a target, `done` never moves, one tool with an action enum, the tenure of a
  handover, and the caps as refusals.

## Context

A read-only survey of the installed Harness and of other agent frameworks produced three findings. Each
was then verified in this repository's own code before anything was changed, because the survey read
`actions.js`, not a running system.

**1. The row carries a name and nothing else.** The shipped board's row has a `description` of up to
16384 characters, it is presented to the model as the task's complete details and acceptance criteria, and
its update action can amend it. This board's row is `{ id, title, status, owner?, created_at,
updated_at? }` with a 200-character title that **no action can change after create**: `taskBoard`'s
`update` reads `status` and `owner` only. The consequence is the one the whole feature exists for. A
successor is handed the work's *name* — the brief names an id and a title (ADR 0017 point 10) — so it
never receives the acceptance criteria for the task and never learns where the predecessor stopped. A
predecessor carrying three open rows cannot describe them anywhere either: the only durable prose about a
member is its `assignment`, capped at 1000 characters (`ASSIGNMENT_MAX`), and that is one statement about
the member, not three statements about three tasks. Renaming the title to "description" would not have
helped; the field has to exist and `update` has to be able to amend it.

**2. The write path can undo the handover it exists to move.** `taskBoard` read the roster once
(`readRoster`), decided against that snapshot, and wrote the whole row into whatever the record held by the
time the write reached the front of the table's chain. In the pre-change revision of `actions.js` the read
was at the top of `taskBoard`, the snapshot was `const next = { ...existing }` in the `update` branch, and
the write was `writeTask(existing.id, next)`, which did `withTask(current, next)` — the *snapshot*, not the
row it had just found. (The survey put these near lines 1616, 1686 and 1639–1641; those offsets were of
the revision it read, and the shape it described is what this confirms.) A handover landing between the
read and the write is then undone by the next board call:

- an `update` computed before the handover writes the snapshot's owner back, so the work returns to the
  predecessor's tombstone;
- a `release` writes the snapshot minus its owner, so work the successor has just taken becomes unowned;
- a `delete` removes the row outright, so a replacement that moved the work a moment earlier no longer has
  anything to move.

Two decisions were each correct on their own and were never joined. ADR 0017 point 5 made the transition
itself the compare-and-set, and every member mutation already rebuilds from the record the write lands on
(`updateRoster` hands its mutation the current record; `messageMember` says so in a comment). The board's
two subtractive actions were written as a rewrite of a snapshot instead.

**3. `blocked_by` and readiness are not adopted.** The shipped board gates *starting* a task on its
dependencies and computes a readiness flag; it never participates in carrying a task across a retirement.
It orders work rather than moving it, and this board's one question is what a successor carries *now*.
The rejection is written out below with the shape to copy if it is ever wanted.

## Decision

**A task carries a bounded `body` that `create` and `update` set and `update` clears; the brief still
carries the id and title only; every id-addressed board write is built inside the serialized mutation from
the record as stored; and `blocked_by` remains absent.**

1. **The field is `body`, capped at `TASK_BODY_MAX = 2000` characters, refused past the cap and never
   truncated** — the pattern `checkTitle`, `checkLabel`, `checkAssignment` and `checkHandoffTemplate`
   already use, with the length in the message and the way out. 2000 is twice `ASSIGNMENT_MAX` (a body
   carries two things — what "done" means and where the work stopped — where an assignment carries one
   sentence about a member) and eight times below the shipped `description` of 16384, because this board is
   one JSON document per Lead whose whole task array is rewritten by every spawn, retirement and task
   write (ADR 0017 point 6). 200 rows of maximal bodies stay inside the order of magnitude that cap was
   chosen for.
2. **`create` and `update` set it, `update` amends it, and `body: null` clears it.** `null` is the same
   vocabulary `owner` already uses for "nobody holds this"; an empty or blank string is refused rather than
   stored, because the write path never produces one (so a stored empty body is a stored value outside the
   accepted set, and the read reports it like any other). A `create` with `body: null` is refused: a new
   task either has a body or omits the field.
3. **`list` returns the body, and a stored body the read rules refuse is reported, not dropped.** A body
   past the cap, or not a non-empty string, is served on the row with `problem` naming it — exactly as an
   over-long title already is (ADR 0017 point 11) — because the storage facility validates every record of
   every Lead when the domain opens, so a content rule enforced on load would let one Lead's long body hide
   every roster. `parseRoster` keeps checking only structure.
4. **The handover brief still carries the id and title only, and says why where it is composed.** A
   maximal body beside a maximal title would blow the 600-character bound that keeps the inherited-work
   line a brief; the line names the work, and the successor reads the bodies from `task_board` with
   `action: list`, which is the same board the pointer sentence already sends it to. The line's own
   comment in `inheritedTasksLine` states this, so the next reader sees the body is excluded on purpose
   rather than forgotten.
5. **An id-addressed write is computed from the record the write lands on.** The mutation looks the row up
   in the record `updateRoster` hands it and builds the next row from *that*:
   - `update` applies only the fields the call named to the row it finds. A field the call did not name is
     never rewritten from a snapshot, so an `update` that changes only a status keeps the owner a handover
     gave the row, and one that only amends the body keeps everything else.
   - `release` and `delete` are subtraction, so they act only on the state the call read: when the stored
     row's `status`/`owner` is no longer what the snapshot held, they write nothing and answer
     `changed: false` with the row they found and a message naming what moved and how to do it again.
   - A row that vanished between the read and the write is the same refusal the read would have given
     (`no task with the id "…"`), raised from inside the mutation.
6. **No model-facing revision parameter is added.** ADR 0017 point 5 deliberately refuses making the model
   track revisions, and this rule needs none: the plugin holds its own read, compares it inside the
   serialized write, and the schema is unchanged. The parameter would also be unanswerable — the model
   cannot know a revision it never read.
7. **`blocked_by` is refused.** It gates *starting* work in the shipped board and never participates in
   carrying work across a retirement, so it answers an ordering question this board does not ask: the
   successor's question is "what do I carry now", and the Lead's answer to "in what order" is judgment,
   which ADR 0017 already left to the Lead. A field that only a scheduler reads would be a second state
   machine to keep true through every handover. If it is ever wanted, the shape to copy is a `context`
   list — **the tasks whose output this one uses** — rather than a bare blocked-by: it names the
   dependency by what crosses it, so a handover can say whether the successor already holds that output
   instead of carrying a pointer to a task nobody owns.

## Rationale

- A successor that is handed a name and no criteria re-does work or asks for it; both cost more than the
  2000 characters the body is bounded to. The title cap (200) is right for a recognisable label and wrong
  for acceptance criteria — which is why the field is separate rather than the cap raised.
- The body belongs in the same guarded place as the rest of the task: on the Lead's roster record, moved
  by the same handover write, read by the same tool. A second store would need its own lifecycle and its
  own answer to "what happens when the owner retires".
- Building the write from the stored record is the same rule `updateRoster` and `messageMember` already
  follow, and it is what makes "only the person changes, not the work" true under concurrency rather than
  only in sequence. The cost is one lookup inside a mutation the plugin already performs.
- The premise rule for `release`/`delete` is narrower than it looks: a board call and a handover are the
  only writers of `status`/`owner`, both go through the same serialized chain, and the window is the
  caller's own read. When it fires, the caller gets the row and one more sentence, not a lost task.
- Writing the refusal down is what stops the next session from adding `blocked_by` because the shipped
  board has one.

## Alternatives rejected

- **Raising `TASK_TITLE_MAX` so a title can hold criteria.** It makes a title unreadable in the brief and
  in `list`, and it is the same tradeoff the shipped board already settled by keeping the two fields
  apart.
- **Naming the field `description` and capping it at the shipped 16384.** The name invites prose that is
  not the task's own statement, and 16384 × 200 rows is megabytes rewritten on every spawn in a
  single-document domain. 2000 is sized for two facts, not a document.
- **Truncating a body to the cap, or dropping the row past it.** A body the model did not write is one it
  cannot recognise; a dropped row is work that vanished. Both are the failures every cap in this plugin
  already refuses.
- **Enforcing the body cap when the record loads.** One Lead's long body would fail the domain open and
  hide every roster (`invalid-record`), the failure mode ADR 0017 point 11 exists to avoid.
- **Putting the body in the handover brief.** The bound exists because a cold child pays for every word;
  five maximal bodies would be 10000 characters of context the successor has not asked for, and the ids
  and titles already give it the round-trip it needs.
- **A model-facing `revision`/`etag` parameter, or a read-modify-write retry loop.** A revision the model
  never read is a value it cannot supply; a retry loop re-decides a call whose answer is simply "the row
  moved, here it is".
- **Refusing the whole `update` when the row changed.** The fields the call named are still its decision,
  and a status change does not depend on who owns the row. Merging into the fresh row is the honest
  reading of "apply what I asked"; only the subtractive actions have a premise to lose.
- **Letting `delete` remove a row a handover just claimed, and reporting it.** Simple, and it is exactly
  the defect: the replacement moved the work and the next call made it disappear. A model that still wants
  it gone says so once more, from a fresh read.
- **A separate `body`-only action or tool.** One more name on a surface whose smallness is deliberate; the
  field rides on the two actions that already write a row.
- **`blocked_by` / readiness.** Rejected for the reason in the Decision; the shape to copy is a `context`
  list of the tasks whose output this one uses.

## Consequences

- `roster.js` gains `TASK_BODY_MAX` and `checkTaskBody`, and `planTask` takes an optional `body`;
  `actions.js` gains `taskBodyProblem`, the body on the row projection, and the rebuilt `taskBoard` write
  path; `index.js` gains one parameter and the `body` property on `TASK_ROW`, so a body-carrying answer is
  inside the declared schema.
- The record shape gains one optional field on a task row, so no migration is needed: a record written
  before this release loads and behaves exactly as it did, and a task with no body is byte-identical to
  one written before.
- An `update` that names no field the row already has now answers `changed: false` with `owner` and `body`
  in the comparison, so a repeat write stays visible as one; `delete` answers `changed: true` when it
  removed a row, and `changed: false` with the kept row when the row moved since the read.
- `tests/task-detail.test.mjs` is new: the three interleavings (a handover injected between the read and
  the write, for `update`, `release` and `delete`), the body's create/amend/clear path, both caps, the
  stored-value read rule, and the brief's exclusion of the body. `tests/entry.test.mjs`'s conformance test
  creates, amends and clears a body through the tool wrapper, which is the check an undeclared result
  field needs.
- The live `task_board` call remains the owner's install check: the suite runs `actions.js` and the
  wrappers against a table fake and never loads the Harness.
- The version moves to `0.18.0`.

## Revisit when

The Harness gains a task primitive with a first-party long field this plugin could adopt instead of its
own `body`; a body is wanted on a *member* rather than on a task (a standing note about the work, which is
what `assignment` already is and would need its own cap decision); a Lead needs ordering, at which point
the `context`-shaped dependency above is the shape to copy rather than `blocked_by`; or the storage
facility gains a per-record partial validation that would let the body cap live on load instead of on read.
