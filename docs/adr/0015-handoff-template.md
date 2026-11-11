# 0015 — The handoff brief's shape is a per-Lead template, set through one tool

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

ADR 0009 made `spawn_member` with `replace` compose the successor's brief from the predecessor's record:
who the successor is, the predecessor's target and label, the recorded assignment, the fact that the
predecessor is gone, and a pointer to the shared team task board. The wording was hard-coded. A Lead that
replaces members repeatedly therefore accepts the same shape every time, and the one thing it can vary is
the content the model records — not how the brief reads.

P4-02 asks for the shape to be storable, readable and clearable. Five constraints shaped the design, and
each had a candidate that was wrong for a reason worth writing down:

1. the smallest surface that works, without a durable setting becoming a side effect of spawning;
2. placeholders validated when the template is stored, because a typo that survives to runtime writes a
   literal `{asignment}` into a cold child's prompt and nobody sees it;
3. the template must carry the assignment, or the successor does not know what it inherited;
4. the built-in composition stays the default, byte for byte;
5. the template and the rendered brief both need a bound, because the brief's value is that it is short.

Two facts about the installed Harness decided the storage question. The roster is one record per Lead in
a `storageDomain` domain (ADR 0003), and the facility **validates every stored record when it opens a
domain**, failing the whole `open` with `invalid-record` and naming the table and key. A strict content
check on load would therefore let one Lead's brief preference hide every roster in the profile.

## Decision

**One Lead-scoped tool, `handoff_template`, storing one string on that Lead's roster record.**

1. **Get/set/clear through one parameter.** No `template` argument reads the stored template back; a
   template string validates and stores it; an empty string clears it. There is no second tool.
2. **The name is noun-only on purpose.** The house style is `verb_noun`, but this call has three
   behaviours chosen by its argument: `set_handoff_template` would promise a write on the call that only
   reads, and `get_handoff_template` would lie about the one that writes. The honest name is the resource
   it owns — the same way the record field is named — and the description says which call does which.
3. **Storage is the Lead's roster record, field `handoffTemplate`.** It is keyed by the Lead Session like
   every other piece of roster state, so two Leads cannot share one. `parseRoster` validates its **type**
   when a record loads; the **content** rules are enforced when it is stored and re-checked by the read
   form, which reports `valid` and `problem`. A stored value that no longer passes validation is reported
   rather than dropped, and the composition falls back to the built-in brief instead of interpolating the
   offending token. This is the deliberate exception to "validate everything on load": a brief shape is a
   preference, and a preference must not be able to brick a roster.
4. **The placeholder vocabulary is `{successor}`, `{predecessor}`, `{label}`, `{assignment}`,
   `{task_board}`** — the successor's target, the predecessor's target, its label, the assignment recorded
   for it, and the pointer to the shared team task board. `{assignment}` is required: refusing a template
   without it is what stops a "pretty" template from producing a successor that does not know what it
   inherited. An unknown placeholder, or a stray brace, is refused **at set time** with the token named.
5. **The built-in brief is the default template.** It is written in the same vocabulary (`{predecessor}`,
   `{assignment}`, …) and rendered by the same function, so a profile that stores nothing produces
   byte-identical briefs; a test pins the exact string. Clearing the field returns to it.
6. **The successor's own task is never a placeholder.** It is appended after the rendered template as its
   final line, so no template can silently drop the task the child was started for.
7. **Two caps, both refusals.** A stored template is at most 1000 characters (the order of `ASSIGNMENT_MAX`
   — it fixes a five-line shape, it is not prose), and the rendered brief is at most 2000 characters, so a
   maximal template plus a maximal assignment cannot become a wall of prose. The rendered cap is measured
   only when a template is stored; that is what keeps the no-template path byte-identical, and why the
   built-in brief is never refused. A refused replacement happens before the reservation and before the
   child starts, so nothing is left half-written.
8. **`list_members` rows are unchanged.** The template is one Lead's preference, not a member fact; a row
   that repeated it would put the same string on every line. The read form of the tool answers instead.

## Rationale

- A stored preference that changes as a side effect of `spawn_member` would be a surprise the tool schema
  could not express, and it would copy the template into every spawn call. A separate tool makes the write
  an explicit act, and the same tool makes reading it explicit too.
- Validating at write time is the only place the model can still fix the mistake; validating the rendered
  result is the only place the assignment's length is known. The two checks cover different failures.
- Keeping the built-in shape as the default — rather than as a special case beside the template path —
  means there is one renderer, so the "no template" promise is a property of the code, not of care.

## Alternatives rejected

- **A `template` parameter on `spawn_member`.** It makes a durable setting a side effect of spawning a
  member, and repeats the template on every call.
- **A bundle-patch config field (`config: { handoffTemplate }`).** It is per-profile, not per-Lead, so all
  of a profile's rosters would share one brief shape; and a patch override is a file edit the model
  cannot make.
- **Two tools (`set_handoff_template` + `get_handoff_template`).** Two names for one resource with three
  operations; clear would still need a third spelling.
- **A `handoffTemplates` table in the domain.** A second table and a second key space for one string per
  Lead, when the record already has a key and a schema.
- **Storing the template on every member row, or reporting it in `list_members`.** It is a Lead
  preference; duplicating it per row is noise and contradicts the task's "rows are unaffected".
- **Validating the content in `parseRoster`.** One malformed template would fail the domain open and hide
  every roster in the profile (`invalid-record`).
- **Truncating the template or the rendered brief.** A truncated template is a shape the model did not
  write, and a truncated assignment is handed to a successor as if it had been recorded that way.
- **A member-written brief, or a brief file.** Rejected in ADR 0009 and still rejected: it costs a model
  round-trip exactly when the predecessor may be unresponsive or already failed.

## Consequences

- Every Lead gets one more tool. Its result is flat lossless JSON: `template` (`''` when none is stored),
  `stored`, `valid`, `problem` (only when a stored value fails validation) and `message`.
- `spawn_member` with `replace` can now fail before anything starts when the rendered brief exceeds 2000
  characters; the error names the cap and says to shorten the template or the assignment. This is the one
  new refusal on the replacement path, and it exists only when a template is stored.
- A stored template is a durability-visible fact: it lives in the roster document, survives a Harness
  restart, and is not part of any Session. Deleting a Lead's Session does not delete it.
- `roster.js` gains the placeholder vocabulary, the two caps and the validator; `actions.js` gains the
  operation and one template parameter on `handoffPrompt`; `index.js` gains the tool. The record shape
  changes by one optional field, so no migration is needed and every earlier record loads unchanged.
- ADR 0009 remains accepted for the replacement ordering and the inherited assignment; only its
  "hard-coded brief" is now a default instead of the only shape. The version moves to `0.11.0`.

## Revisit when

P2-09 gives this plugin its own task board — the `{task_board}` pointer then names that board — or the
Harness ships a handoff primitive that makes the composed prompt unnecessary. A Lead needing more than
one template (per role, or per kind of member) is a new decision with a new ADR, not a parameter on this
one.
