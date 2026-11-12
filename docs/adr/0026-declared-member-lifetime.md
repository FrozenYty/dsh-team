# 0026 — A member's lifetime is declared on the spawn call, the board is a veto, and a standing role leaves only on the person's words

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** point 5 of [0013](0013-ephemeral-members.md) — a message no longer clears the one-shot
  flag — and the `ephemeral` row of ADR 0018 point 3 and ADR 0019 point 3: a definition can no longer
  declare a lifetime.
- **Adjusts [0013](0013-ephemeral-members.md) points 2 and 3** — the sweep's candidate now needs a third
  condition, and `startedAt` can be re-established after a message. The rest of 0013 stands: no completion
  event exists, the sweep is lazy, and retirement is the one existing protocol.

## Context

**The owner's rule, which this ADR exists to stop losing.** A member is a division of labour, not a task.
Ending a role is a decision about the role; finishing a piece of work is not a reason to make it. ADR 0013
had already written that into the `retire_member` description as advice to the model — "a member is a
division of labour, not a task … when that is a judgement call, ask the person" — and v0.9.0's
`ephemeral` flag had a self-retiring half. Both were rules a model had to remember. The owner asked for the
rule to stop depending on that.

Three defects made it worse than an unkept promise:

1. **`message_member` silently deleted the flag.** Sending a one-shot member more work re-declared it as
   standing (ADR 0013 point 5). That was written to stop a sweep eating a just-delivered message, and it
   solved that problem by erasing the declaration instead — so a member the Lead had declared one-shot
   became permanent, and nothing in any result said the lifetime had changed.
2. **`retire_member` had no gate at all.** The advice in its description was the only thing standing
   between a model and the retirement of a member that was idle between two rounds of work.
3. **The sweep's evidence was too thin to be worth trusting.** `startedAt` plus "not resident" proves a
   member ran and then unloaded; it does not prove the work the member owned is finished, and the sweep
   happily retired a member that still owned open tasks, reporting them afterwards as `unowned`.

**What was verified before deciding, and where.** Read out of the installed packages in
`resources/app.asar`, not from memory:

- A descendant row's `activity` is produced by one expression,
  `@deepseek-ai/dsh-subagent/lib/index.js:2435`:
  `sessions.get(entry.id) === void 0 ? "inactive" : "running"`. The installed
  `@deepseek-ai/dsh-experimental-agent-team/README.md:62` states what the word means for a member:
  `inactive` is "no turn is executing, whether loaded or stored". So it describes residency, not an
  outcome — it is exactly as true of a child that has not run yet as of one that has finished. There is no
  completion signal in this Harness (`docs/member-lifecycle-en.md` §1, ADR 0013), and the same README makes
  no promise that a member marks anything done.
- The upstream Claude Code agent-teams feature documents the matching failure in its own troubleshooting
  guidance: teammates do not reliably mark their tasks completed, and the work has to be checked rather
  than inferred from the board. That guidance is why "the board is empty" cannot be read as "the work is
  done": a row's absence is evidence of nobody having written it, which is the same fact whether the work
  finished or the member never got to it.
- This repository's own board already refuses to pretend otherwise: a done row never moves (`docs/task-board-en.md` §2), a
  member never writes the board (ADR 0022), and only the Lead closes a row.

## Decision

**A member has a declared lifetime. `standing` is the default and is never retired automatically; `one-shot`
is retired by the sweep only when it has started, has stopped, and owns no open row. A standing member's
retirement needs the person's words, quoted. The board can only veto, never trigger.**

1. **The lifetime is declared on the spawn call, and nowhere else.** `spawn_member` takes
   `lifetime: "standing" | "one-shot"`. `ephemeral: true` keeps working as the pre-v0.25 spelling of the
   same declaration, because every stored record and every existing caller uses it; a call that passes both
   inconsistently is refused rather than tie-broken, because resolving it would make one of the two fields
   a silent lie. An omitted declaration is `standing`, which is the safe side: only a one-shot member is
   ever retired without asking.
2. **It is never inherited.** A `replace` starts its successor as `standing` unless that call declares
   otherwise, and a member definition cannot declare a lifetime at all: `ephemeral` was removed from the
   accepted frontmatter, and a file that carries `ephemeral` or `lifetime` is refused by name with the
   reason and the alternative. A file describes the role, and under ADR 0019's precedence a file-declared
   one-shot would be inherited by every successor of a replacement — which would then retire itself at the
   end of its turn and orphan exactly the work the replacement had just handed over. ADR 0019 point 3 chose
   that consequence deliberately; this ADR removes it, because it is the same failure the owner's rule
   forbids.
3. **The record keeps `ephemeral: true`, and the tool surface says `lifetime`.** The stored field is not
   renamed: it is already in every roster this plugin has written, ADR 0013 named it, and a rename would
   need a migration over state that the storage facility validates on open. `lifetimeOf(member)` is the
   one translation — a record with `ephemeral: true` is `one-shot`, every other record is `standing` — and
   every `list_members` row reports `lifetime`, so "may this member retire itself?" is answerable from the
   read that shows the member rather than from a note in the documentation.
4. **Auto-retirement has three conditions, all required: it started, it is not resident, and it owns no
   `open` row on this Lead's board.** The first two are ADR 0013's evidence, unchanged. The third is this
   ADR's: a member whose turn ended but which still owns work is not eligible, because retiring it would
   leave that work unowned — and the plugin would then report `unowned` for a retirement nobody asked for.
   So a member that finishes its turn holding an open task stays, and the sweep says so instead of acting.
5. **The board is a veto, never a trigger.** An open row blocks a sweep; an empty board never causes one.
   The three conditions are sufficient, and none of them is "the board says it is done": the board cannot
   distinguish finished work from work nobody wrote down, by the evidence quoted above, and a member that
   never started owns nothing and would otherwise be swept on the spot. A blocked sweep reports itself —
   `blocked`, `blocking_tasks` and `blocking_note` — because a forgotten row must not strand a member
   invisibly: the count says how many stayed, the list carries the row ids, and the sentence names the one
   `task_board { action: "update", … }` call that clears each row. Closing the work is what makes a
   one-shot member eligible to leave; it is never what proves the member finished.
6. **A standing member's `retire_member` refuses until it carries the person's words, quoted.** The call
   returns `retired: false, reason: "needs-confirmation"` and retires nothing; it carries the `question` to
   put to the person, the `owns_tasks` the member still holds, the `assignment` it was doing, and a
   `message` saying what to do next. The retirement happens on the next call, which must pass
   `confirmed: "<their sentence>"`; the sentence is trimmed, echoed back in the result and therefore stays
   in the transcript. A one-shot member is exempt, because declaring it one-shot *was* the person's prior
   consent, and so is a `replace`, which continues the role with a new holder rather than ending it — both
   are the same `retireMember` with `consentRequired` false, so there is one retirement protocol and one
   gate. **A record that never became a role is also exempt, whatever lifetime it carries**: `retired` has
   no life left to end, and `failed` never started. Consent exists because ending a *role* is the person's
   decision, and a record whose spawn or start did not succeed never became one, so there is nothing to ask
   about and asking would turn cleanup into ceremony. This ADR first read the rule the other way — consent
   for every non-retired standing record, `failed` included, on the grounds that the rule is about the
   declared lifetime and not about the phase. That reading is the broader one and it is defensible, but it
   charges a question for removing a reservation that never held a role, and the narrower reading above is
   the one the owner chose. A `standing` member that actually ran is unaffected: its record is `active`
   while it lives, so retiring it still needs the quoted words. **Narrowed again in v0.25.1 to standing
   members that still carry something** — see *The gate narrows to what a member carries* below; the
   reading in this point is kept as the record of what this ADR decided first.
7. **A message re-opens a one-shot member instead of re-declaring it.** `message_member` leaves `ephemeral`
   alone and invalidates the finished-evidence by deleting `startedAt`; a later read that observes the
   child resident again re-stamps it, so "it ran and stopped" is only ever concluded from an observation
   made after the last time the member was handed work. The result says so (`reopened: true`) and reports
   the unchanged `lifetime`. The record counts what was written to it — `messageCount`, and
   `assignmentCount` when the assignment changed. Since v0.25.1 those counters are written for **every**
   member rather than only a one-shot one, because the retirement gate reads them to tell a member that was
   handed work again and again from bare residue; what stays one-shot-only is the *advice* drawn from them
   (point 8), which is a correction for a declaration rather than for a role.
8. **Advice, never automation.** A one-shot member that has been re-tasked at least twice
   (`RETASK_MIN`) is flagged on its `list_members` row as `retasked: true` with a note saying it is
   probably a standing role and naming the one call that declares that. Nothing converts it, and the sweep
   does not spare it: a lifetime is the person's consent, and a plugin that inferred consent from a counter
   would be making the decision it exists to hand back.

## The gate narrows to what a member carries (v0.25.1)

**Live acceptance passed, and then the owner widened it.** Their words: *"我觉得我们这方面不一定非要做的这么死，可以适当给Lead一些权限让他也能自动判断退役."* Read with what they had said earlier — *"如果我说文档检查我们暂时不用做了，那就可以询问我的意见，然后退役掉他"* — the two statements agree, and they draw the line this section implements: **the gate protects the person's decision to end a role, not every act of housekeeping.**

Point 6 as written above refuses every standing record that became a role, whether or not anything is at
stake. That is stricter than the principle it invokes. A probe the Lead spawned yesterday, which has no
assignment, owns no work and was never used again, is not a role anyone is still deciding about: asking the
person about it is ceremony, which is exactly what the owner objected to.

1. **The refusal now depends on what the member carries, and there are three carriers.** A standing member
   is asked about only when it has a recorded `assignment`, or owns at least one `open` row on this Lead's
   board, or was re-tasked at least `RETASK_MIN` times. Those are the cases where ending it is a decision
   about a role: something is recorded about what it was doing, someone still owes work this Lead is
   tracking, or the Lead has already handed it work more than once.
2. **A standing member that carries nothing retires in one call, and that call must state a `reason`.** It
   answers nothing, asks nobody, and the reason is what the tombstone keeps — the one trace a removal of
   bare residue otherwise leaves. A call that states no `reason` on such a member answers
   `retired: false, reason: "needs-reason"` and changes nothing — a `confirmed` does not substitute for it,
   because there is nobody whose words it could be and no reason left on the tombstone — which is the same
   refuse-rather-than-guess rule the rest of this plugin uses. The successful result says in words that the
   member carried nothing and was removed as housekeeping, so the transcript shows the Lead acted alone and
   on what.
3. **Both refusals say which rule stopped the call.** The consent refusal gains `carries`, the same phrases
   the sentence uses ("a recorded assignment", "1 open task", "being re-tasked (2 messages)"), and keeps
   `question`, `owns_tasks` and `assignment`; the reason refusal carries `carries: []`, which is the
   statement that the member carries nothing. The two are distinguishable by `reason`
   (`needs-confirmation` against `needs-reason`), so a reader can tell "a role with something behind it"
   from "residue that needs a sentence" without parsing prose. `owns_tasks` and `assignment` keep their
   existing rule — present only when they exist — so an absent field still reads as "nothing there".
4. **The counters had to reach standing members for the third carrier to exist.** `message_member` counted
   only one-shot members (point 7 as first written), so a standing member's `messageCount` was permanently
   zero and "was re-tasked" could never be true for the members this gate is about. The counters are now
   written for every accepted message on every member. The *advice* built from them stays one-shot-only,
   because "this is probably a standing role" is a correction for a one-shot declaration; a standing member
   already is one. No row shape changes: the two counters were already optional and validated on load.
5. **No config field and no new lifetime value.** The narrowing is by what the member carries, not by a
   policy switch, and a policy field is the next step if the owner ever wants latitude beyond this rule —
   not this one. A third lifetime value would be a second vocabulary for one field and would have to be
   honoured by the sweep, the gate, the veto and the row together.
6. **What does not change.** `lifetime` and its two values, the board veto, `blocked`/`blocking_tasks`/
   `blocking_note`, the sweep's three conditions, the one-shot and `replace` paths, and the `failed`/
   `retired` exemption are all exactly as they were. The gate is the only thing that moved, and it moved
   from "every standing member that became a role" to "a standing member that still carries something".

## Rationale

- **The declaration is where the consent can be checked.** The plugin has no human surface (ADR 0008), so
  a flag the model sets about itself asks nobody. A lifetime declared at spawn is a prior decision the
  person's Lead embodied in a call, and a quoted sentence is a fact that survives in the transcript. Both
  are checkable; "the model said the person agreed" is not.
- **Carrying something is what makes an ending a role-level decision.** Nothing in this plugin can read
  intent, but it can read the three things a person would want a say in: what the member was recorded as
  doing, work the Lead is still tracking, and evidence it was used more than once. A member with none of
  them has nothing for the person to decide about.
- **A stated reason is the cheap substitute for a question.** Housekeeping needs no consent but it does need
  a trace: the reason lands on the tombstone, so a later reader can tell why the residue was cleared. That
  is one string for the caller to write, against one round-trip to the person it would otherwise cost.
- **Three conditions rather than one strong one.** Each is a different fact from a different source — the
  plugin's own start record, the live registry, and the board — and the sweep is the only place in this
  plugin that retires something without being asked. The cheap direction to be wrong in is to leave a
  member listed.
- **The veto is the whole difference between "nobody wrote a row" and "the work is done".** The upstream
  guidance and the installed README agree that neither the board nor `activity` carries an outcome. Using
  the board as a trigger would have converted a missing row into a retirement, which is precisely the
  mistake the owner's rule is about.
- **Not renaming the stored field.** `ephemeral` is the durable spelling of one lives-in-every-record fact;
  `lifetime` is the vocabulary of the call and the row. Two words for one fact is a cost, and a migration
  over every roster is a larger one, for a field no user types.
- **Re-opening beats re-declaring.** ADR 0013 point 5 solved "a sweep must not eat a just-delivered message"
  by clearing the flag, which silently changed the declaration. Invalidating the evidence solves the same
  problem and keeps the declaration, so a one-shot member that is needed again becomes sweepable again
  after it has run — not permanent.
- **Advice is enough for the counter.** The counter is the plugin's only evidence about re-use, and it is
  weak: two messages may be one clarification each. Reporting it lets the Lead correct its own declaration;
  acting on it would let a counter decide a role's lifetime.

## Alternatives rejected

- **`confirmed: true`, or a `consent` enum.** The model would be asserting that a person agreed, which is
  unverifiable and exactly the class of self-set flag ADR 0008's model-only surface cannot support. A
  quoted sentence can be read back by the person it supposedly came from.
- **Ask the person through a tool result on every retirement.** That is what the gate does; the rejected
  variant is refusing to retire at all without a second surface, which would leave a Lead unable to act on
  an answer it already has.
- **A `team/*.md` field for lifetime, applied only on a fresh spawn.** The special case is the defect:
  the same file would mean different things depending on how the member started, which is the invisible
  difference ADR 0019 exists to remove — and the precedence rule would still hand it to a successor the
  moment somebody read the matrix quickly. The file has no lifetime, and the refusal says so by name.
- **Keep ADR 0013 point 5 and let a message clear the flag.** It makes a one-shot permanent by accident,
  which is the defect this ADR fixes; and once a lifetime is a declaration, no message can change it
  without a spawn.
- **Let the sweep retire a member that owns open work and report `unowned`.** P4-01 shipped that, and its
  own result names the orphans. Reporting an orphan is not the same as not creating one, and the owner's
  rule is that the work survives the person.
- **Convert a re-tasked one-shot member to standing automatically.** A counter is evidence about messages,
  not about intent, and the conversion would be invisible in the transcript. The row says "probably", the
  Lead decides, the next spawn declares it.
- **A `finished`/`dormant` phase written by the sweep.** Rejected in ADR 0013 and still rejected: it needs
  a writer, and the only writer would be the same lazy observation, so it would add a stored claim this
  plugin cannot verify.
- **Require consent for a `replace`.** Then the ordinary way of changing a member's person would need a
  person's sentence, and a Lead could no longer replace a member inside one turn. A replacement does not
  end the role; it moves the work to a new holder, which is the operation the plugin exists for.
- **Delete `ephemeral` from the call surface entirely.** Every caller and every stored record uses it, and
  a profile that passed `ephemeral: true` yesterday must not start spawning standing members today. It stays
  as an alias, with a description that says which field to prefer.
- **A config field for "how strict is retirement".** The owner asked for latitude, and a `consent: "strict"
  | "relaxed"` row would be the obvious knob. Rejected for now because it makes the rule depend on a
  profile's configuration rather than on the member in front of the call: two Leads would get different
  answers about the same member, and the model would have to reason about a policy instead of about what it
  can see. A policy field is the next step if this rule turns out to be wrong, not the first.
- **A third lifetime value (`housekeeping`, or `dormant`).** It would be a second vocabulary for a field
  whose two values already answer the question, and every consumer — the sweep, the gate, the veto, the row
  — would have to learn it. What separates a role from residue is what the member carries, which changes,
  not what it was declared, which does not.
- **Key the gate on the phase instead of on what the member carries.** "Ask only about `active` members"
  looks simpler, but a standing member that ran and unloaded is exactly `active` — the phase cannot tell a
  role from a probe, which is the distinction the gate exists to make.
- **Make the `reason` optional, or invent one for the Lead.** A housekeeping removal that leaves no sentence
  behind is indistinguishable from a mistake later, and a plugin-written reason would be the model putting
  words in the caller's mouth. One parameter the caller already has is cheaper than both.
- **Count only assignment changes, not messages, as the third carrier.** A message is the cheapest way to
  hand work to a member and leaves no other trace, so counting only assignments would miss a member the Lead
  has been quietly driving for days.

## Consequences

- `roster.js` gains `LIFETIME`, `RETASK_MIN`, `lifetimeOf` and `declaredLifetime`; record validation covers
  the two optional counters; `planMember`'s last parameter is a boolean named `oneShot`.
- `definitions.js` no longer accepts `ephemeral`, and the two frontmatter keys `ephemeral` and `lifetime`
  are refused with the reason and the call that replaces them.
- `actions.js`: `spawnMember` resolves one declaration before it reads anything and never consults the file
  or the predecessor; `sweepEphemeral` gains the veto and the blocked report; `retireMember` gains the gate
  (narrowed in v0.25.1 to members that carry something) and echoes the quoted words; `messageMember` no
  longer deletes the flag and counts re-tasks on every member; `memberRow` reports `lifetime` and the retask
  advice.
- The tombstone reason a swept member carries now reads
  `one-shot member: it ran and stopped and owned no open task`. It is display text — nothing parses it —
  and the old spelling stays on the tombstones that already carry it.
- `index.js` declares every new field: `lifetime` on a member row (required) and on the message and
  retirement results, `retasked`/`retasked_note`, `blocked`/`blocking_tasks`/`blocking_note`, and the
  consent refusal's `question`/`owns_tasks`/`assignment`/`carries`. A field the operation returns but the
  schema does not declare is dropped by the host after the side effect has happened.
- The version moves to `0.25.0`. `tests/lifetime.test.mjs` covers the seven decisions — the declaration and
  its refusal, the three sweep conditions, the standing member that is never swept, the veto report, the
  consent gate both ways, the message that re-opens without re-declaring, and the advice that never
  converts — and `tests/definitions.test.mjs`, `tests/task-board.test.mjs` and `tests/entry.test.mjs` are
  updated for the removed field and the declared ones. The live sweep on a real profile is the owner's
  install check; no unit test loads the Harness.
- v0.25.1 narrows the gate and reports which half of it applied: the same test file gains a case per carrier
  (assignment, open row, re-tasking) plus the bare member that retires in one call on a stated reason, the
  bare member refused with `needs-reason` when the reason is missing, and the counters that had to reach
  standing members for the third carrier to exist. Widening the gate back to "every standing member" makes
  the bare-member cases fail, which is how the narrowing is pinned rather than asserted.

## Revisit when

The Harness publishes a durable outcome for a child's run — a settled result a plugin may read, rather than
residency — which would let the third condition be evidence instead of a veto; or the upstream agent-teams
feature starts guaranteeing that a teammate marks its tasks, which would make a board row usable as a
trigger; or a profile gains a person-facing surface this plugin may ask through, which would replace the
quoted-sentence consent with a real answer; or the owner wants latitude beyond "what the member carries",
at which point the policy field this section rejected becomes the next step rather than a second guess at
the carriers.
