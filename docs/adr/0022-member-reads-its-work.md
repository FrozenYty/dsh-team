# 0022 — A member reads the work it owns, and the board keeps one writer

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —
- **Adjusts [0009](0009-replacement-handoff.md) point 4, [0015](0015-handoff-template.md) point 4 and
  [0020](0020-task-body-and-write-integrity.md) point 4 in wording only** — the `{task_board}` pointer now
  names this plugin's board and the member's own read tool instead of the shipped board and "ask the
  Lead". Every decision in those ADRs stands; only the sentence a successor is given changed.

## Context

ADR 0020 gave a task a `body`: what "done" means for it and where the predecessor stopped. `task_board`'s
description, the README pair and that ADR all said the handoff brief stays short on purpose, "so a
successor reads the bodies from this board". A live install showed that this was false. Every tool in
`index.js` called `requireLead`, and `apply` installed tools only in a Team Lead's Agent scope, so a
member received no roster tool at all. A successor enumerated its tools, found no `task_board`, and read
`~/.dsh/storages/team_roster.json` directly to discover the body it had inherited. The body was therefore
readable only by the Lead, which made it far less useful than ADR 0020 claims, and it pushed a member into
the plugin's private storage file.

The same live brief carried a second defect. `{task_board}` rendered as "the shared team task board under
the name …", a board whose tools were disabled in v0.14.0, followed by "ask the Lead for their ids if you
cannot read the board" — which becomes wrong the moment a member can read its own rows, and in the
meantime invites exactly the storage-file workaround above. A template that appended its own period made
the rendered brief end `board..`.

## Decision

**One member-scoped, read-only tool, `list_my_tasks`, returns the rows whose `owner` is the caller's own
target; the Lead remains the board's only writer; and the handoff pointer names this board and this tool.**

1. **The tool is `list_my_tasks`, it takes no parameter, and it answers one flat object.** `target` is the
   caller's model-facing handle, `tasks` is the row projection the Lead's `task_board list` already uses
   (id, title, body when present, status, owner, timestamps and the read-time `problem`), and `open`
   counts the rows still owed. The row shape is not widened: the member is reading the same rows, and a
   second vocabulary would let the two answers drift.
2. **The filter is the whole authority: `task.owner === caller's target`, and nothing else.** Another
   member's row and every unowned row are absent, as is a row whose owner is a different generation of
   the same base name. The target is read from the roster row the caller's Session matched, never from an
   argument, because a caller-supplied name would be a second, unverified way to address someone else's
   work. Both open and done rows the member owns are returned: a finished task is still part of the record
   it is reporting on, and `status` is what tells the two apart.
3. **A member that owns nothing gets an empty list, not an error.** Owning no work is a normal state, and
   an error would tell a member its tool is broken. The answer is `tasks: []`, `open: 0` and a sentence.
4. **A caller the board cannot place is refused.** The Lead does not receive this tool at all — its whole
   board is `task_board` — and a child that no roster names is refused with that alternative in the
   sentence. The read never adopts: adoption is a Lead write that already runs on `list_members` and
   `spawn_member`, and a member's read must not silently write a record onto a Lead it cannot see.
5. **The member scope is the Agent scope, installed the same way as the Lead's.** At `apply` for every
   live non-root Agent, and on `agent/created` for each later one, `installMember` registers on that
   Agent's own `ctx`; `agent/disposed` and plugin unload remove it. The Lead's `install` is untouched, so
   the Lead's tool set does not change, and a member whose Session is not this process's Lead still
   receives its tool. Whether the caller is on a roster is decided at call time, not at registration.
6. **The board keeps exactly one writer, the Lead.** A member that finishes a task says so in its report;
   the Lead closes the row with `task_board`. The alternative — a status parameter on this tool — was
   rejected because the board's guarantees are properties of one serialized writer: a handover is one
   mutation that re-addresses rows before a tombstone, the transfer matrix (§4.3.2) is answerable because
   every transition has exactly one owner, and `release`/`delete` can rely on the premise they read. A
   member write would need a second authority rule, a second compare-and-set story against that
   handover, and a reviewer who cannot tell "the member marked its own work done" from "the Lead accepted
   it". A finished member's report and the Lead's transition are two different facts; keeping them
   different is worth more than one saved round-trip.
7. **The handoff pointer is corrected to name the board that exists and the read the member has.** The
   `{task_board}` value is now `this Lead's own task board under the name "<target>"; read it with
   list_my_tasks and take those tasks over instead of redoing finished work`. It is a fragment that fits
   the built-in line, carries no final period (a stored template commonly writes `{task_board}.`), and no
   longer tells the successor to ask the Lead. The unrecorded-assignment fallback and the "and N more"
   remainder of the inherited-tasks line name the same board and the same tool.

## Rationale

- The body exists to be read by the person doing the work. A tool that only the Lead can call leaves the
  feature one scope short and teaches a member to read the storage file.
- The smallest useful surface is one read with no arguments. The caller's identity is already the
  selector, so a `target` parameter could only be a way to ask for the wrong rows or a second addressing
  mode to keep consistent with every Lead tool.
- Empty is an answer, not a refusal, because "you own nothing" is exactly what a member needs to report
  back. Refusing there would conflate an empty assignment with an authority failure.
- One writer is the invariant the board already has. Handing the member a write would trade that
  invariant for convenience on the one operation whose result is a review decision, and it would make the
  transfer matrix's "a transfer writes ownership, never status" harder to state.
- Registering on the Agent's context is the pattern the plugin already uses for the Lead; a second
  discovery path (a service, a scan at call time) would be a second place for authority to disagree.

## Alternatives rejected

- **A member mode on `task_board`.** The Lead's tool keeps its current shape, required by this delivery,
  and a mode would put a second authority inside one result schema; the member's read is smaller as its
  own name.
- **A `status` or `update` parameter on the member tool.** The convenience is one call; the cost is a
  second writer and a reviewed transition the Lead cannot see. Rejected in point 6.
- **Returning unowned rows as well.** Unowned work is the Lead's to assign; a member seeing it would read
  work it does not carry and could mistake it for its own.
- **A `target` argument.** It would let one member read another's rows and would duplicate the identity
  the Session already supplies.
- **Returning an empty list to any caller the roster does not know.** It is cheap, and it is a lie: a
  child that was never adopted may own work, and `tasks: []` would tell it the opposite. The refusal names
  the Lead's tool and the adoption trigger instead.
- **Registering the read in the Lead's scope so the Lead can forward it.** The successor would still have
  to ask, which is the failure the live run found.
- **Having the member read the storage file (what the live run did).** It bypasses the row projection,
  couples the member to the domain's private shape, and cannot apply the read-time `problem` rule.

## Consequences

- `index.js` gains `installMember`, `memberScopeOf`, `requireMember` and `MY_TASKS_VALUE`; `actions.js`
  gains `listMyTasks`; the Lead's ten tools and their schemas are unchanged, and the member receives
  exactly one tool.
- `tests/entry.test.mjs`'s two scope assertions now expect the member context to hold `list_my_tasks`
  and the Lead context not to; its conformance test drives a real member answer through the declared
  schema; a new test proves a member sees its own rows only, that an empty owner gets an empty list, and
  that the Lead and an unknown child are refused.
- The task body is now readable by the member that needs it, so "a successor reads the bodies from the
  board" is true as written. The README pair, `docs/architecture-*.md`, `task_board`'s description and
  `docs/adr/0020`'s wording are corrected where they promised the same thing.
- The live call from inside a real member Session is the owner's install check: the suite registers on a
  fake Agent context and never loads the Harness.
- The version moves to `0.20.0`.

## Revisit when

A member needs to write a progress note the Lead should read (that is a message, not a board write); the
Harness ships a member-scoped task primitive this plugin could adopt; or a task gains a field whose
visibility differs between the Lead and its owner, at which point the single row projection needs a
visibility rule rather than a second schema.
