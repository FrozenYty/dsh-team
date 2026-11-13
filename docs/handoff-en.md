# Handoff

> Owner: @FrozenYty · Revisit when: the brief's shape, its placeholders, or the template sources change

What a successor receives when it replaces a member, and the three sources the brief's template can
come from — the team file, the stored template, the built-in shape — with the precedence between them
and the write refusal the file imposes. The replacement protocol that composes the brief is
`docs/member-lifecycle-en.md` §3; the record field it is stored in is `docs/roster-storage-en.md` §1.
Decisions: ADR 0009, ADR 0015, ADR 0019, ADR 0021.

## 1. The brief a successor receives

A replacement composes the successor's brief from the predecessor's record and from the board
(`docs/member-lifecycle-en.md` §3); this section is what that brief carries and what bounds it.

**The brief's shape has three sources, in this order: the team file, the stored template, the
built-in shape.** A Lead that replaces members repeatedly can commit `team/team.md` with the
project, store a template with `handoff_template` (`docs/architecture-en.md` §5), or store nothing
and get the built-in shape. The file wins while it exists, so the tool reports `source` on every
read and refuses a store or clear with the file's path (§2). The placeholders are `{successor}` and
`{predecessor}` (the two targets), `{label}` (the predecessor's role), `{assignment}` (what it was
recorded as doing) and `{task_board}` (the pointer to the Lead's own task board). `{assignment}` is
required, because a brief that omits it hands the successor a role and a board pointer but not the
work it inherited — which is the whole point of the handoff. A template is validated when it is
stored or when the file is parsed: an unknown placeholder is refused by name, so a typo cannot reach
a child as literal text. The successor's own task is always appended after the rendered template, so
no template can drop it. The rendered section is capped at 2000 characters and refused rather than
truncated, measured only when a template is in effect — which is what keeps the built-in path
byte-identical to the release before P4-02. A stored template belongs to one Lead's roster record,
so two Leads never share one; a team file belongs to the project, so two Leads working in the same
project do share it, deliberately. `list_members` rows never carry either.

**The board travels with the brief, bounded.** A brief is not a workspace dump: a member starting with a
200-line backlog is worse off than one starting with five ids. So the composition adds **one line** naming
the predecessor's open tasks by id *and* title — either alone is unusable, because an id the successor
cannot look up is a round-trip and a title alone cannot be marked done — and the line is bounded twice:
at most 5 rows, and at most 600 characters, which is five maximal titles (`TASK_TITLE_MAX`, 200) with room
for the ids. **The line carries ids and titles and nothing else: never a row's `body`**, which is bounded
for the board (`TASK_BODY_MAX`, 2000) and not for a child's prompt, so one maximal body per row would
break the 600-character bound — the successor reads the bodies from the board with `list_my_tasks` (the
Lead with `task_board`), the same board the pointer sentence sends it to (ADR 0020, ADR 0022). A list that
would not stay under either bound is
dropped entirely and the successor keeps the `{task_board}` pointer sentence, which is exactly the brief
the release before P2-09 produced. A successor whose predecessor owned no open task therefore gets a brief
that is byte-identical to the old one, and a test pins that string — the brief carries ids and titles only
when there is work actually in flight, and it never carries a `done` row.

**A template keeps its own line.** The inherited-tasks line is appended after the rendered template
and before the successor's own task, so a template can neither drop it nor duplicate it, and the
`{task_board}` placeholder still means what it always meant: the pointer. A template is not required to
mention the board at all — it is the default shape that does.

**Not built, and therefore not described as behaviour.** There is no member-written brief and no brief
file: asking a member for one costs a model round-trip exactly when the member may be unresponsive or
already failed, so the brief is composed from the record and the board. Nothing in the code reconciles an
assignment or a task against the working tree — that check is the Lead's judgment, and the plugin only
names the rows it stored.

## 2. The team file (v0.19.0)

The member scope moved onto disk in v0.16.0; the team scope wanted the same thing for the one
setting that shapes a handover. A brief template was the only team setting with no diff, no review,
and no sharing between two Leads working in the same project, so it is now a file committed with the
project: `<Lead working directory>/team/team.md`, resolved through the same `workingDirectory`
service the member definitions use (`docs/architecture-en.md` §6). It is deliberately **not** part of the
definition chain: a definition is read from `.agents/team/definitions`, then `team/`, then the shipped
templates, while the team file has one home and no bundled counterpart (ADR 0021, ADR 0029).
The file's body is the handoff template, validated by the same `handoffTemplateProblem` rules a
stored template passes.

**The name is reserved, and that is the answer to the scan collision.** `team.md` is skipped by the
member-definition scan, so it can never be mistaken for a member definition — a `team.md` declares no
`name` and would otherwise be reported as a broken definition on every spawn. A member may still declare
`name: team` in another file: the filename is not an identity (ADR 0018), and the reservation covers one
path, not one name.

**The frontmatter is empty for now.** It is parsed by the same documented subset, with no accepted field,
so a team setting nobody asked for is refused by name and line instead of silently carried. A future team
setting is a field added to that set, not a new parser.

**The effective template has three sources, in this order.**

| Source | When it is in effect | What the composition does |
|---|---|---|
| `file` | `team/team.md` exists and parses as a usable template | renders the file's body; the stored template is shadowed |
| `stored` | no usable file, and this Lead's `handoffTemplate` passes the content rules | renders the stored template, unchanged from v0.11.0 |
| `builtin` | no usable file and no usable stored template | renders the built-in shape, byte-identical to a profile that never had either |

The read form of `handoff_template` reports `source`, the effective `template`, the file's path when one
exists, `file_problem` when the file is not usable, and the stored value's own `stored`/`valid`/`problem`.
A file that exists but does not pass — an unknown placeholder, a missing `{assignment}`, an over-cap
template, an unknown frontmatter field, an unreadable or oversized file — is reported and never becomes
the effective template; the stored template is next, and the built-in shape is last. That is the same
fallback a stored value that no longer validates already gets, and it is what stops a typo in a file from
reaching a child as literal text.

**A store write is refused while the file exists.** The file wins, so accepting a write would be a silent
no-op: the model would believe it changed the brief while the file still composed every successor. Both
setting and clearing answer with the same refusal, and it names the file and the edit:

```
handoff_template: the team file "<abs path>/team/team.md" is in effect, so a stored template would be
shadowed and this write would change nothing. Edit that file to change the brief, or remove it to use
handoff_template again.
```

**What stays in the runtime record, and why.** The *tasks* do not move to the file. A task is lifecycle
state, written in the same breath as a tombstone and moved by a replacement (ADR 0017): it belongs to the
Lead's run, not to the project's source tree. The template is the opposite kind of state — a shape
preference, true of the team rather than of one member or one run — and that is exactly what a committed
file is good at. The split is by kind, not by age: the file holds what two Leads in one project should
share, and the record holds what only this run knows. A shared `team/` directory is therefore a feature
for the template and would be a bug for the board.

## 3. The stored template on the roster record

`handoffTemplate` is the one field on this record that describes the Lead rather than a member. Its
**type** is validated when the record loads; its **content** — the placeholder vocabulary, the
required `{assignment}` reference and the length cap — is checked when it is stored and re-reported
by the read form (`docs/architecture-en.md` §5). That split is deliberate: the storage facility
validates every record of every Lead when it opens the domain, so refusing a whole roster over one
Lead's brief preference would hide every team. A stored template that no longer passes validation is
reported, never silently dropped, and the composition falls back to the built-in brief instead of
writing the offending token into a child. Since v0.19.0 the file's body goes through the same
content check where it is parsed, and a file that fails it does not become the effective template
(§2).
