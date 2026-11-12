# 0021 — The handoff template can be a team file, and a stored write is refused while it exists

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —
- **Adjusts [0015](0015-handoff-template.md)** — the stored template stops being the only non-built-in
  source: a `team/team.md` in the Lead's project outranks it, and a store or clear is refused while that
  file exists. The placeholder vocabulary, the caps, the read-time reporting and the one-tool surface of
  0015 stand.

## Context

A read-only survey compared this plugin with CrewAI, which now splits a crew into `crew.jsonc` (team
fields) and `agents/<name>.jsonc` (member fields), both on disk. This plugin already had the member scope
on disk (ADR 0018) but the team scope lived only in the per-Lead `storageDomain` record. The one team
setting that shapes a handover — the brief template (ADR 0015) — was therefore the only team setting with
no diff, no review, and no sharing between two Leads working in the same project.

ADR 0018 had already answered the questions a file raises for a member: which directory, which parser,
which precedence, and why a file is better than a create/update tool. The team scope needed the same
answers for one artifact, plus three this ADR records:

1. **A team file and a member definition share one directory.** Both are `team/*.md`, and the member scan
   refuses any `.md` file that does not declare a `name`. A team file whose body is a template would
   therefore be reported as a broken definition on every spawn unless the collision is decided.
2. **A file can silently shadow a stored setting.** The file wins, so a `handoff_template` write while it
   exists would be accepted and then have no effect. A model that believes it changed the brief is the
   failure this feature has to prevent, and it is worse than a refusal because nothing looks wrong.
3. **The team scope is not all the same kind of state.** A template is a shape preference true of the
   project; a task is lifecycle state written in the same breath as a tombstone (ADR 0017). The split has
   to say which side each thing is on, or the first shared directory becomes a bug report about a task.

The constraints that shaped the design are ADR 0018's: the bundle imports nothing outside Node builtins
(ADR 0002), so the parser is the documented subset and a construct outside it is refused with the line; a
bad file must not be able to hide the valid ones or brick a roster; and the tool surface stays as small as
it can be.

## Decision

**One optional `team/team.md` beside the member definitions; its body is the handoff template; the file
outranks the stored template, which outranks the built-in; and a store write or clear is refused while
the file exists.**

1. **The path is the one ADR 0018 already resolves: `<Lead working directory>/team/team.md`.** It uses the
   same `workingDirectory` service and the same `team/` join, so there is no second path story. A profile
   that cannot resolve the directory cannot see a team file; its stored template keeps working exactly as
   before, which is what keeps a profile with no file byte-identical.
2. **The body is the template; the frontmatter is empty for now.** A brief is multi-line prose, so a flat
   `key: value` frontmatter cannot express it; the body can, and the existing placeholder rules then
   apply unchanged. The frontmatter is parsed by the same subset parser with no accepted field, so a team
   setting nobody asked for is refused by name and line instead of silently carried. A future team setting
   is a field added to that set, not a new parser.
3. **`team.md` is reserved.** The member-definition scan skips that exact filename, so a `team.md` can
   never be mistaken for a member definition. A member may still declare `name: team` in any other file:
   the filename is not an identity (ADR 0018), and the reservation covers one path, not one name. The
   alternative — treating a `team.md` that declares `name` as a member file and one that does not as the
   team file — was rejected because a typo (`label:` without `name:`) would silently turn the team file
   into a refused definition and the stored template back on.
4. **The precedence is `file` → `stored` → `builtin`, and the read form reports the source.** The read
   answer keeps its existing fields (`template`, `stored`, `valid`, `problem`) and gains `source`, the
   file's path when one exists, and `file_problem` when the file is not usable. No second read tool is
   added. The built-in shape remains the default template rendered by the same code, so a profile with
   neither source is byte-identical to the release before this change, and a test pins it.
5. **The file's body goes through `handoffTemplateProblem` where it is parsed.** An unknown placeholder is
   refused by name, a template without `{assignment}` is refused with the reason, and the 1000-character
   cap is a refusal rather than a truncation. A file that fails any of these is reported and does not
   become the effective template: the stored template is next and the built-in shape is last. That is the
   same fallback a stored value that no longer validates already gets (ADR 0015), and it is what stops a
   file from being a way around the placeholder rules.
6. **A store or clear is refused while the file exists, and the refusal names the file and the edit.**
   Both forms answer `handoff_template: the team file "<path>" is in effect, so a stored template would
   be shadowed and this write would change nothing. Edit that file to change the brief, or remove it to
   use handoff_template again.` The rule holds even when the file is itself unusable: it still shadows
   the store the moment it is fixed, so accepting the write would only move the surprise later.
7. **Tasks stay on the Lead's roster record.** A task is lifecycle state: it is handed over by a
   replacement, un-owned by a retirement, and written in the same serialized mutation as the member rows
   it describes (ADR 0017). It belongs to one Lead's run, not to the project's source tree. The template
   is the opposite kind of state — a shape preference true of the team — and that is what a committed file
   is good at. The split is by kind of state, not by age: the file holds what two Leads in one project
   should share, and the record holds what only this run knows.
8. **The read form keeps reporting what it always reported about the stored value.** `stored` and `valid`
   continue to describe the `handoffTemplate` field, so an old stored value that no longer passes is still
   reported rather than hidden; `source` says whether the file, that stored value, or the built-in is what
   a replacement will actually render.

## Rationale

- The file is the same artifact ADR 0018 introduced for members, one directory up in scope. Reusing its
  path resolution and its parser means one set of rules and one set of refusals for both, and it is why
  the team file cannot drift from the member file's subset.
- Refusing the store write is the only honest answer while the file wins. A silent no-op is invisible
  precisely in the case that matters: the call succeeded and the brief did not change.
- Reporting `source` on the read is the same rule ADR 0019 applied to a definition's assignment: the
  model must be able to see which source won without inferring it from a rendered prompt.
- Keeping tasks in the record is not conservatism. A task is written atomically with a tombstone, and a
  file outside that mutation could not participate in the same write without a second consistency story.

## Alternatives rejected

- **`crew.jsonc`-style two structured files for the team scope.** The only team setting that exists is a
  multi-line template; carrying it in JSON would need escaping, a JSON parser the zero-import bundle does
  not have, and would put the prose in a string where a diff reads badly. The markdown body is the format
  the member layer already uses.
- **A second tool for the file (`get_team_file` / `set_team_file`).** The file has no writer tool for the
  same reason a definition has none: version control and an editor are better, and the read already
  reports what is in effect. One more name would be paid on every call.
- **Treating `team.md` as a member definition when it declares `name`.** Backward compatible for the rare
  profile with a `team.md` definition, and it makes a typo change which file the plugin thinks it is
  reading. Reserved is explicit and checkable.
- **Refusing the whole replacement when the team file is unusable.** It would make every replacement fail
  over one typo and would contradict the member layer's "one bad file never hides the valid ones"
  (ADR 0018). The fallback reports the file and renders something valid; the read names the problem.
- **Letting the stored template win while the file is broken.** That is what the fallback already does
  when the file cannot render, and it keeps a broken file from bricking the brief. The file still wins
  the moment it parses, which is why the write refusal is unconditional.
- **Moving the task board into the same file.** Tasks change per run and per replacement; a shared
  `team/` directory is exactly wrong for them. ADR 0017 stays the owner of the board, and this ADR says
  why the split is by kind of state.
- **A `source` field on `spawn_member`'s result instead of the read form.** The template can also be
  composed for a replacement the model did not read first, and the read is the operation whose whole
  purpose is to answer which template is in effect. ADR 0015 already put the read there.
- **Renaming `handoffTemplate` or removing it once a file exists.** An existing stored value must keep
  working for a profile that has no file, and removing it would need a migration in the same release.

## Consequences

- `definitions.js` gains `TEAM_FILE`, the shared `parseFrontmatter`, `parseTeamFile` and
  `loadTeamTemplate`, and its scan skips the reserved name. `actions.js` resolves the three sources and
  refuses a store write while the file exists; `index.js` declares `source`, `file` and `file_problem` on
  the `handoff_template` result. No published file is added, so the bundle still publishes ten files.
- The rendered brief is unchanged for every existing source: the file is a new first source, the stored
  template and the built-in shape render exactly as they did. A profile with no file renders the built-in
  brief byte for byte, pinned by a test, and the existing suite is not edited to accommodate the change.
- A team file is shared by every Lead working in that project, which is the feature; a stored template
  stays per-Lead. The read form's `source` makes the difference visible instead of ruling it.
- The live read/write through a real profile is the owner's install check. The suite drives
  `definitions.js`, `actions.js` and the tool wrappers against a real filesystem and a `workingDirectory`
  fake, and never loads the Harness.
- The version moves to `0.19.0`.

## Revisit when

A second team setting needs the frontmatter (then the accepted field set becomes real and this ADR's
"empty for now" is superseded), a Lead needs more than one brief template per project (per role or per
kind of member, a new decision rather than a second file), the Harness ships a first-party team-config
primitive this plugin could adopt instead of `team/team.md`, or the task board needs to be shared between
two Leads in one project, which would move §4.3.2's state into the file and need its own consistency
story.
