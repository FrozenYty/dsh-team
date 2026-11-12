# 0019 — A definition's assignment yields to the recorded one on a replace, and the file still describes the role

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —
- **Adjusts [0018](0018-member-definitions.md) for point 4 only** — the merge now names the predecessor's
  recorded assignment as a source on a `replace`, and the file's assignment applies only when there is
  nothing to inherit. The rest of 0018 stands: the `team/` path, the flat frontmatter subset and its
  refusals, the caps, the typed refusal and the one-parameter surface.

## Context

**A verified defect, found by reading the code.** `spawnMember` merged a definition into the call's fields
*after* it had read the file and *before* it resolved the member a `replace` names. The file's
`assignment` therefore became indistinguishable from an assignment the model had written, and the
predecessor's recorded assignment — the one ADR 0009 point 4 says a successor inherits — lost to a
sentence that is true of every holder of the role. The successor was started from a handoff brief built
from the file's standing sentence, so a Lead that replaced a member with `spawn_member { definition: …,
replace: … }` was told the work had been handed over while the successor was told the job's description.
This defeats the two things the plugin claims: ADR 0009's inheritance, and "only the person changes, not
the work".

The defect existed because two decisions were each correct on their own and were never joined. ADR 0018
point 4 wrote the merge for a fresh spawn: the call wins, field by field, and the result reports the
merge. ADR 0009 point 4 wrote the replacement: the successor inherits the predecessor's assignment unless
the model records a different one. Neither ADR named the predecessor's record as a *source in the merge*,
so the code had no place to put it, and the merge silently made the file equivalent to the call.

**The rest of the matrix was never written, and one field has a consequence nobody would predict.**
`assignment` is not the only field a definition carries. `ephemeral`, `cwd` and the four model fields have
no per-event decision: the project's own rule (AGENTS.md §4.8) is that a lifecycle bug is a cell nobody
filled in. The one that bites is `ephemeral`: a definition that declares a role one-shot would make a
*replaced* member self-retire at the end of its turn, which — because a replacement hands its open tasks
to the successor (ADR 0017) — un-owns the very work the replacement just moved. That is exactly the kind
of surprise a matrix exists to prevent, and it was undocumented in either direction.

## Decision

**On a `replace`, the predecessor's recorded assignment outranks the definition's, the call's assignment
outranks both, and the result says which one won; the rest of a definition applies on a replace as the
file's description of the role, with its consequences written down.**

1. **The precedence is `call` → `predecessor` → `file`.** An explicit `assignment` on the spawn call is
   used. Otherwise, when the call names a `replace` target, the assignment recorded on that member is
   used. The definition's `assignment` applies only when there is nothing to inherit — a fresh spawn, or a
   predecessor that recorded none. Nothing changes for a fresh spawn: the call wins and the file fills
   what the call omitted, exactly as ADR 0018 point 4 says.
2. **The winner is reported, in the report's own vocabulary.** The result's `definition` object gains
   `assignment` with the value `call`, `predecessor` or `file`, present only when an assignment applies at
   all. It sits beside `prompt`, which already reports its own source the same way (`file` or
   `file+call`), and it stays inside the existing `definition` report, so `spawn_member`'s declared
   two-branch result `oneOf` is unchanged in shape. `from_file` and `overridden` keep their existing
   meaning: `from_file` names the fields whose values came from the file, `overridden` names the file's
   fields the call replaced. A file assignment that lost to the predecessor is named by
   `definition.assignment`, and is deliberately not called "overridden by the call", which it was not.
3. **The rest of the definition is the role, and it applies on a replace.** `ephemeral`, `cwd`,
   `provider`, `model`, `reasoning_effort`, `max_tokens` and `agent_preset` are merged exactly as they are
   on a fresh spawn: the call overrides them field by field, and the file supplies the rest. `ephemeral`
   in particular **applies to a successor**, and the table in `docs/architecture-en.md` §4.3.3 (and its
   Chinese pair) states the consequence plainly: a one-shot successor is retired by the next lazy sweep
   once it has run and stopped, and the open tasks it holds — including the ones the replacement just
   handed it — lose their owner and are reported in `unowned`/`unowned_tasks` (ADR 0017). A Lead that
   wants the successor to keep the work messages it once, which clears the flag, or passes
   `ephemeral: false` on the replace call.
4. **The predecessor's `cwd` and model route are not inherited, and cannot be.** They are start options,
   not record fields: `started_with` is a receipt on a tool result, not durable state (§4.2). A successor
   therefore takes the file's or the call's values, and the matrix says so rather than leaving it to be
   discovered.
5. **`message_member` never reads a definition.** A message acts on a member that already started, so the
   file contributes nothing there: the assignment it records can be replaced by the call, an accepted
   message clears a one-shot flag (ADR 0013), and every other field of the file is fixed for that
   member's life — a different `cwd`, model or preset needs a new spawn or a replacement.
6. **The matrix is in the architecture document, in both languages, one cell per field.** It is
   `docs/architecture-en.md` §4.3.3 and `docs/architecture-zh.md` §4.3.3, next to the state matrix and the
   transfer matrix it interacts with, not in a comment.

## Rationale

- A definition is a job description. It is true of every holder of the role, which is exactly why it
  cannot be what a successor is told its predecessor was doing. The recorded assignment is the only
  durable statement about one holder, and it is what the brief is composed from.
- The call still wins because the Lead is the authority on the work, and because "I explicitly said this"
  must not be defeated by a file — the failure ADR 0018 named.
- Reporting the winner is what makes the rule checkable. A model that believes it overrode a definition
  and did not is the failure the whole report exists to prevent, and the same applies to a model that
  believes the file applied and it did not.
- Reading the file's other fields on a replace, rather than special-casing them, keeps one rule for one
  artifact: the file describes the member, and a replacement starts a member. The consequences of that
  rule are stated where a consequence would otherwise be a surprise.
- Writing `message_member`'s non-reading into the matrix turns an implicit fact of the lifecycle into a
  cell that can be wrong and therefore checked.

## Alternatives rejected

- **Ignore the file's `assignment` on a replace entirely.** Simple, and it makes a file unable to supply a
  standing assignment to a successor whose predecessor recorded none — where the definition is the only
  description of the work that exists. The precedence keeps that case and fixes the case that was wrong.
- **Ignore the file's `ephemeral` on a replace, so continuity wins.** Argued as the safer half: a
  successor should not orphan the work it was just handed. Rejected because the definition *is* the role:
  a one-shot role does not stop being one-shot when its first holder is replaced, and special-casing one
  field on one event makes the file mean different things depending on how the member was started — which
  is the class of invisible difference this ADR exists to remove. The cost is not hidden: the sweep
  reports the tasks it orphans, `list_members` reports `ephemeral: true`, and the escape hatch is one
  explicit field or one message.
- **Refuse a replace when both the file and the predecessor declare an assignment.** It turns a merge the
  tool can resolve into a repair the model must make, on the most common case (a role file plus a member
  that was doing work), and a reusable definition would have to be stripped before every replacement.
- **A parameter (`inherit_assignment: false`, or a field mask).** A second way to say what the precedence
  already says, on a surface whose smallness is deliberate (ADR 0017, ADR 0018).
- **A result-level `assignment_source` field.** It exists only because a definition was named, so it would
  have to be absent on every spawn that names no file — the same conditional field, in a worse place. The
  `definition` report is where a definition's contribution belongs.
- **Composing the brief from the file's text while inheriting the record's.** Two assignments for one
  member, and a brief that says two different things about the same work.
- **A new tool for a definition-based replacement.** The replacement is already one call, and the whole
  point of `replace` is that the work moves with it (ADR 0009).

## Consequences

- `actions.js`: the definition merge runs after the predecessor is resolved, and `applyDefinition` takes
  the predecessor and resolves `assignment` with its source. A definition that cannot be read is still
  loaded — and refused — before the sweep and before any reservation, so a refused file still changes
  nothing (ADR 0018).
- `index.js`: `DEFINITION_REPORT` gains one optional property (`assignment`), and the `assignment` and
  `definition` parameter descriptions state the precedence. The declared output schema stays a
  two-branch root `oneOf`, so exactly one branch still matches every answer.
- Every definition-backed replacement result carries the new field; a fresh definition spawn carries it
  with `file`, so the source of a definition's assignment is visible in both cases. A spawn that names no
  definition is byte-identical to the previous release.
- `tests/definitions.test.mjs` covers each cell: the recorded assignment wins over the file, the call wins
  over both, the file applies when the predecessor recorded none, a fresh spawn is unchanged, the source
  is reported, the file's `ephemeral` applies on a replace and the sweep orphans what it held, and a
  message replaces the assignment and clears the flag. `tests/entry.test.mjs`'s conformance test
  validates a replace-from-definition answer against the declared schema, which is the check an undeclared
  result field needs.
- The version moves to `0.17.0`: which assignment a successor receives is behaviour, not a comment.
- The live `spawn_member { definition: …, replace: … }` call remains the owner's install check; the suite
  runs against the real filesystem and a `workingDirectory` fake, and never loads the Harness.

## Revisit when

The Harness records a member's start options durably, at which point a replace could inherit `cwd` and the
model route from its predecessor exactly as it already inherits the assignment; a definition gains a field
that is explicitly about one holder rather than the role, which would need its own precedence rather than
a row in §4.3.3; or the Harness ships its own replacement primitive, in which case this rule has to be
stated there as well.
