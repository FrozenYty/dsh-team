# 0018 — A member is a file on disk, and the frontmatter subset is refused rather than approximated

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —
- **Point 4 adjusted by [0019](0019-definition-precedence-on-replace.md)** — on a `replace` the
  assignment recorded on the predecessor outranks the file's, and the result reports which source won.
  The rest of this ADR stands: the path, the frontmatter subset and its refusals, the caps, the typed
  refusal and the one-parameter surface.

## Context

Every member this plugin has ever created was improvised in a tool call: the prompt, the label and the
assignment lived in that call and in the Lead's roster record, and nowhere else. Three consequences:

1. **A team cannot be reviewed, versioned or shared.** The team is the interesting artifact of a project,
   and it was the one part of the work that had no diff.
2. **The same member is retyped every session.** "Reviewer" is a prompt the author already wrote, twice.
3. **The record is the only copy.** A roster record is durable, but it is a `storageDomain` document keyed
   by a Lead Session id (ADR 0003): it is not in the repository, not in a review, and not in a clone.

The model this plugin's vocabulary comes from solves it the other way round: the member is a **file on
disk with frontmatter**, committed with the project, and the orchestrator is runtime state. P3-01 in that
model's own terms. This ADR adopts that split, and had to answer four questions the split raises.

**Why one parameter and not three tools.** A file has no create/update/delete tool in the editor that
reads it, and a plugin that adds `create_definition` gets a second writer of the same bytes with a second
validation path. The model already has file tools. What the model cannot do for itself is read the file
*as a member* — resolve the directory, validate the fields against the caps the roster enforces, and merge
them with the call — so that is the whole new surface, and it is one parameter.

**Which directory.** A definition has to live at a path both the model and the plugin can name.
`spawn_options.cwd` already documents that a relative path resolves against the Lead's working directory,
and the installed seam resolves it through `ctx.workingDirectory.ensure(agent, signal)`
(`dsh-subagent` `lib/index.js:1530`). The plugin reads the same service, on the Lead, so `team/` is
exactly the directory a relative member `cwd` resolves against. The service is optional, and it is
deliberately read with `ctx.get` rather than added to `inject`: a profile without it must still activate
this plugin, and a definition spawn in that profile must be a typed refusal rather than a guess at
`process.cwd()` — which is the Harness process's launch directory, not the Lead's project.

**Which subset.** The bundle imports nothing outside `node:` builtins (ADR 0002), so there is no YAML
library — and a hand-written parser that accepts "most of YAML" is worse than a documented small subset,
because the failure mode is a *silently wrong value*: a `label` read as an object, an `ephemeral: yes`
coerced to a string, a duplicate `model` key resolved to whichever came last. The third schema-shaped
failure this project has had was exactly this class (v0.12.0's `minimum` keyword: the plugin installed and
did not activate), so the rule here is refuse-with-the-line rather than coerce.

**What precedence means.** A definition and a call can both name a label. The model's failure to prevent
is not the merge itself but its *invisibility*: a model that believes it overrode a definition's model and
did not will read a result that looks like success and debug the wrong thing.

## Decision

**One optional `spawn_member` parameter, `definition`, names a markdown file under `team/` in the Lead's
working directory; the call's own arguments win over the file's, field by field, and the result reports
which parts came from where.**

1. **The path is `<Lead working directory>/team/*.md`**, and the working directory is
   `ctx.get('workingDirectory').ensure(leadAgent, signal)` — the service and method the spawn seam uses
   for a relative `cwd` — never `process.cwd()`. An absent service, a rejected `ensure`, or a non-absolute
   answer is the typed refusal `working-directory-unavailable`, and nothing is reserved.
2. **The file is a flat frontmatter block between two `---` lines, and the markdown body below it is the
   member's prompt.** The accepted fields are exactly the inputs `spawn_member` already has: `name`
   (required), `label` (required), `assignment`, `ephemeral`, `cwd`, `provider`, `model`,
   `reasoning_effort`, `max_tokens`, `agent_preset`. The definition declares `name`, which is also the key
   `definition` is looked up by, so the file's own name is not an identity. `prompt` is not a field: the
   body is the prompt. A field with no counterpart on the call — a description, a tools list, a priority —
   is out of scope and is refused by name with the accepted set attached.
3. **The accepted subset is written down, and everything outside it is refused with the path and the
   line.** Accepted: `key: value`, one pair per line, no indentation, an optional matching pair of quotes
   around a value with no escape interpreted, blank lines and `#` comments. Refused: nesting, list items,
   block scalars (`|`, `>`), anchors and aliases (`&`, `*`), merge keys (`<<`), flow collections (`[...]`,
   `{...}`), duplicate keys, an unknown field, a key with no value, a missing `name` or `label`, and an
   empty body. Values are validated against the roster's own rules — `checkMemberName`, `checkLabel`,
   `checkAssignment` — so a definition cannot declare what the reservation would refuse one call later.
4. **The call wins, per field, and the result reports the merge.** `definition.from_file` names the fields
   whose values came from the file and `definition.overridden` names the file's fields the call replaced,
   so "I overrode it" is a fact in the answer rather than an inference. `prompt` is the one field the call
   cannot replace: the body is the member's standing prompt and the call's `prompt` is the task for this
   spawn, so the call's text is appended after the body and `definition.prompt` reports `file` or
   `file+call`. The field names are the plugin's own vocabulary, so a field the model passed and a field
   the file declared are named the same way in the report.
5. **One bad file never hides the others.** A scan collects what it can read and reports what it could
   not, each row `{path, line?, problem}`: `definition.problems` on a successful spawn, `problems` on a
   refusal. A name declared by two files refuses **both**, because a lookup that quietly picked one would
   make the other file's edits invisible. An unknown name answers `definition-not-found` with `available`
   — the names the same scan could use — and answers `definition-invalid` instead when the directory also
   held a refused file, since the name may be declared there. This is the rule a stored task already
   follows (ADR 0017): a bad record is reported on read, never allowed to hide the rest.
6. **The caps are refusals, never truncation and never a partial read.** `DEFINITION_FILE_MAX` is 16 KiB
   per file and `DEFINITION_LIMIT` is 64 files per scan. The size cap is per file, so an oversized
   definition is refused while its neighbours still work; the count cap is on the directory, so a scan that
   could not read every file refuses the whole scan rather than serving a partial set — a name missing from
   a truncated set is indistinguishable from a name somebody deleted.
7. **A refusal is a typed result, not a throw.** `spawn_member`'s output schema is a two-branch `oneOf`:
   the member row, or `{ started: false, reason, message, ... }` with `reason` from
   `working-directory-unavailable`, `definition-not-found`, `definition-invalid` or
   `definitions-over-limit`. The reasons are disjoint from the capability refusals, so exactly one branch
   matches. This is ADR 0016's rule for a refused start applied to a refused definition, and it holds
   because a definition refusal writes **no** member record and starts no child: fixing the file and
   retrying reuses the same name, unlike a capability refusal, whose failed reservation is deliberately
   visible in the roster.
8. **The surface is one parameter, and the plan says so.** No create, update, list or delete tool is
   added. `definition` is the whole feature; the plugin reads these files and never writes one.

## Rationale

- The split is the point: what a member *is* belongs in the repository, what a Lead's team *is doing*
  belongs in the runtime state this plugin already owns. A definition that lived in a `storageDomain`
  record would be as unversionable as the roster it came from.
- A documented subset plus a line-numbered refusal is the only honest parser a zero-import bundle can
  have. It also makes the failure cheap for the author: the sentence names the file and the line, and an
  unknown field's sentence lists the accepted set, so a typo is a one-line edit rather than a hunt.
- Reporting the merge is what makes precedence safe. The alternative — a silent merge — is the failure the
  brief names, and it is invisible precisely in the case that matters: the call succeeded and the member
  started, but not the way the model believes.
- One `team/` directory rather than a path parameter keeps the surface at one string with no traversal
  question, and gives the plugin a bounded thing to scan.

## Alternatives rejected

- **A YAML library (`js-yaml`, `yaml`).** The bundle imports nothing outside Node builtins, and a linked
  bundle resolves bare specifiers from its own real path with no `node_modules` beside it (ADR 0002).
  Vendoring one would be a second file to maintain and a second version to audit for the four scalar forms
  this plugin actually needs.
- **A "reasonable" YAML subset without refusals** — accepting nesting by ignoring indentation, coercing
  `yes`/`no` to booleans, taking the last duplicate key. Each is a silent interpretation of something the
  author did not mean, and a member that runs with the wrong label or the wrong model is worse than one
  that did not start.
- **`name` from the file name instead of a field.** It removes the duplicate-declaration case, and it also
  makes the identity of a member something a rename changes. Taking the declaration as the identity keeps
  the file a document, makes two declarations detectable, and matches the lookup the model writes.
- **A path-valued `definition`.** One more thing to validate (relative to what? inside the sandbox?), and
  it lets a spawn read a file the model could have read anyway. A name under `team/` is one bounded scan.
- **A `prompt` that replaces the body.** The body is the role and the call's prompt is the task; a member
  definition that a task string erases would be retyped in every call, which is the problem this ADR
  exists to remove. Appending, and reporting `file+call`, is the honest merge.
- **A create/update/delete tool for definitions.** Three names, three schemas and a second writer of the
  same bytes, in exchange for nothing the model's own file tools do not already do — and the editor is
  where a definition should be written anyway.
- **Storing a definition on the roster record, or in a second domain.** It would keep the record shape
  unchanged, and it would put the member's definition outside version control, which is the one thing the
  feature is for. A definition is read from disk at the moment it is used, so an edit takes effect on the
  next spawn with no reload and no cache to invalidate.
- **Listing the definitions in `list_members`, or in a tool of its own.** The directory *is* the list, and
  the model reads it with the file tools it already has. The refusal carries `available`, so even a
  misspelled name answers the question "what is there?" without a second call.
- **Making `workingDirectory` a required injection.** A profile that does not mount the service would then
  fail to activate the whole plugin — losing retirement, restore and the board — over a feature it may
  never use. `ctx.get` plus a typed refusal keeps every other tool working.

## Consequences

- `definitions.js` is a new published module (`package.json` `files`, the repository check's Host-module
  list and the CI syntax step), so the bundle publishes ten files. It imports `node:fs/promises`,
  `node:path` and this repository's own `roster.js`, and no `@deepseek-ai/*` package.
- `spawn_member` gains one parameter, one optional result field (`definition`), and a second result
  branch; `label` and `prompt` stop being unconditionally required in the parameter schema, because a
  definition can supply them, and their descriptions say so. A spawn that passes none of it produces the
  same request and the same result shape as before, which the existing suite pins.
- `roster.js` gains `checkMemberName` — the rule `planMember` already enforced, extracted so a definition
  is refused by the same one.
- No durable record changes: a definition is not stored anywhere, so there is no migration, and an edit to
  a file takes effect on the next call.
- The definition layer is unit-tested and not yet exercised by a live install: the resolved path, the
  scan and the merge run against the real filesystem and a `workingDirectory` fake in the suite, so what
  remains for the owner is one live `spawn_member { definition: … }`.
- The version moves to `0.16.0`.

## Revisit when

The Harness ships a first-party agent-definition primitive this plugin could adopt instead of its own
`team/` convention; a YAML parser becomes importable from a linked bundle (then the subset can widen to
real YAML, and the refusals narrow to what YAML itself rejects); a definition needs a field the call does
not have — a per-member tool allow/deny, a description for a picker — which would be a new decision with a
new ADR rather than a field added quietly to this one; or a Lead needs definitions to compose (one
definition extending another), which the flat format deliberately cannot express.
