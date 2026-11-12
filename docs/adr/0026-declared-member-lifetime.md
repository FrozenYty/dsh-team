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
  completion signal in this Harness (`docs/architecture-en.md` §4.3, ADR 0013), and the same README makes
  no promise that a member marks anything done.
- The upstream Claude Code agent-teams feature documents the matching failure in its own troubleshooting
  guidance: teammates do not reliably mark their tasks completed, and the work has to be checked rather
  than inferred from the board. That guidance is why "the board is empty" cannot be read as "the work is
  done": a row's absence is evidence of nobody having written it, which is the same fact whether the work
  finished or the member never got to it.
- This repository's own board already refuses to pretend otherwise: a done row never moves (§4.3.2), a
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
   while it lives, so retiring it still needs the quoted words.
7. **A message re-opens a one-shot member instead of re-declaring it.** `message_member` leaves `ephemeral`
   alone and invalidates the finished-evidence by deleting `startedAt`; a later read that observes the
   child resident again re-stamps it, so "it ran and stopped" is only ever concluded from an observation
   made after the last time the member was handed work. The result says so (`reopened: true`) and reports
   the unchanged `lifetime`. The record counts what was written to it — `messageCount`, and
   `assignmentCount` when the assignment changed — and those counters exist only on a one-shot member.
8. **Advice, never automation.** A one-shot member that has been re-tasked at least twice
   (`RETASK_MIN`) is flagged on its `list_members` row as `retasked: true` with a note saying it is
   probably a standing role and naming the one call that declares that. Nothing converts it, and the sweep
   does not spare it: a lifetime is the person's consent, and a plugin that inferred consent from a counter
   would be making the decision it exists to hand back.

## Rationale

- **The declaration is where the consent can be checked.** The plugin has no human surface (ADR 0008), so
  a flag the model sets about itself asks nobody. A lifetime declared at spawn is a prior decision the
  person's Lead embodied in a call, and a quoted sentence is a fact that survives in the transcript. Both
  are checkable; "the model said the person agreed" is not.
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

## Consequences

- `roster.js` gains `LIFETIME`, `RETASK_MIN`, `lifetimeOf` and `declaredLifetime`; record validation covers
  the two optional counters; `planMember`'s last parameter is a boolean named `oneShot`.
- `definitions.js` no longer accepts `ephemeral`, and the two frontmatter keys `ephemeral` and `lifetime`
  are refused with the reason and the call that replaces them.
- `actions.js`: `spawnMember` resolves one declaration before it reads anything and never consults the file
  or the predecessor; `sweepEphemeral` gains the veto and the blocked report; `retireMember` gains the gate
  and echoes the quoted words; `messageMember` no longer deletes the flag and counts re-tasks;
  `memberRow` reports `lifetime` and the retask advice.
- The tombstone reason a swept member carries now reads
  `one-shot member: it ran and stopped and owned no open task`. It is display text — nothing parses it —
  and the old spelling stays on the tombstones that already carry it.
- `index.js` declares every new field: `lifetime` on a member row (required) and on the message and
  retirement results, `retasked`/`retasked_note`, `blocked`/`blocking_tasks`/`blocking_note`, and the
  consent refusal's `question`/`owns_tasks`/`assignment`. A field the operation returns but the schema does
  not declare is dropped by the host after the side effect has happened.
- The version moves to `0.25.0`. `tests/lifetime.test.mjs` covers the seven decisions — the declaration and
  its refusal, the three sweep conditions, the standing member that is never swept, the veto report, the
  consent gate both ways, the message that re-opens without re-declaring, and the advice that never
  converts — and `tests/definitions.test.mjs`, `tests/task-board.test.mjs` and `tests/entry.test.mjs` are
  updated for the removed field and the declared ones. The live sweep on a real profile is the owner's
  install check; no unit test loads the Harness.

## Revisit when

The Harness publishes a durable outcome for a child's run — a settled result a plugin may read, rather than
residency — which would let the third condition be evidence instead of a veto; or the upstream agent-teams
feature starts guaranteeing that a teammate marks its tasks, which would make a board row usable as a
trigger; or a profile gains a person-facing surface this plugin may ask through, which would replace the
quoted-sentence consent with a real answer.
