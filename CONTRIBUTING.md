# Contributing

How we work in this repository. Code style beyond what CI enforces is between the author and the
reviewer.

## 1. Branching

`main` is protected. Work happens on short-lived branches:

```
feat/roster-retire    fix/locale-parity    docs/adr-subagents
```

Lowercase, hyphen-separated, prefixed by type. No Chinese, no pinyin. Merge through a pull request,
then delete the branch.

## 2. Commits

Conventional Commits, with the module as scope:

```
feat(plugin): add compact_member tool
fix(bundle): stop enabling the command-compact row
docs(adr): record the own-roster decision
chore(ci): run the repository checks on pull requests
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.
Modules: `plugin`, `bundle`, `roster`, `docs`, `ci`.

One commit does one thing. If the message needs “and”, split the commit.

**Never add a footer that credits a tool.** No `Co-authored-by:` naming an AI assistant or a code
generator. A squash merge copies the single commit message onto `main` verbatim, and GitHub counts
that trailer as another contributor.

## 3. Pull requests

- Keep a PR under **400 changed lines**. Larger work is split.
- Fill in the template: what changed, how it was verified, what else is affected.
- **CI is the only gate.** When `check` is green the PR may merge.
- Merge with **squash** — one feature, one commit on `main`.
- Name the task ID in the title when the PR delivers one: `feat(roster): retire a member (P2-03)`.

## 4. What CI checks

| Job | Command | Fix |
|---|---|---|
| Bundle checks | `node scripts/check.mjs` | read the reported file and key |
| Entry syntax | `node --check index.js` (also `actions.js`, `roster.js`, `definitions.js`, `trash.js`, `host-hooks.js`) | repair the syntax error |
| Unit tests | `node --test --test-isolation=none tests/*.test.mjs` | fix the failing behaviour, not the assertion |

`scripts/check.mjs` verifies, without loading the Harness:

- `package.json` parses, `dsh.bundle.patch` points at the patch, and every path in `files` exists;
- `index.js` is published and exports `apply(ctx, config)`;
- each Host module (`index.js`, `actions.js`, `roster.js`, `definitions.js`, `trash.js`, `host-hooks.js`) is published and
  imports no `@deepseek-ai` package (ADR 0002);
- every `execute(` in `index.js` declares `(args, exec)` — the wrapper signature the unit tests cannot
  cover;
- `locale/en.json` and `locale/zh.json` carry the same keys;
- `cordis.patch.yml` parses as a patch array, enables `compaction-basic` and inserts this plugin's row;
- the three bilingual document pairs exist;
- no shared document contains an absolute machine path.

It does not check entry syntax — `node --check` does that, as the table above says. Neither command can
prove the plugin activates. That requires installing the bundle into a profile, which is a manual step
with a real side effect — see the README.

**An ordering assertion needs to know what "equally old" means.** Two artifacts stamped in the **same
millisecond** are equally old, so the retention cap deleting either of them is not wrong — what is wrong is
a test that asserts **which** one went. Assert the set, the count, or the state, and never the identity of
one record among ties. This is not hypothetical: `pruneLeadTrash` orders candidates by millisecond stamp, a
CI runner is fast enough to produce two retirements in one millisecond, and a test that named one of the two
was green locally and red in CI. The same class has cost this repository three times today, so it is a rule
here rather than a comment in the test that survived.

**The schema check has two halves, and CI runs one of them.** `node --test` drives the harness half on every
push: it checks that every tool's input and result schemas still match what the bundle declares, and — on a
machine that has the archive — that the Host's own validator accepts them. CI has no archive, so it covers
**"the input still matches the bundle"** and not **"the Host still accepts these schemas"**. The second half
is `node scripts/schema-check.mjs`, run locally against the installed build (`DSH_ASAR` points it at another
one), and it is the half nobody runs but you. The test says which half it skipped rather than passing quietly,
because that is how the script came to be believed while it was broken.

**Run the gate as its own step.** A check and the commit it protects must not be one command:
`check; git add; git commit; git push` reads as one action and is really two decisions, and whether a shell
stops on a non-zero exit is the shell's business — the one this repository is driven from does not, so a
failing check has reached the remote as a red commit that had to be amended away. Run
`node scripts/check.mjs` on its own and read its exit code, or write the list so every later step is gated on
it (`&&`, or an explicit test of `$LASTEXITCODE`). A contributor who thinks of the check as a step *inside*
the publish will keep publishing red.

**The guard only works inside one process**, because an exit code does not travel between shell calls: a
step in the *next* call cannot be gated on this one's result, so the gate runs in the same call as the step
it guards, or it is re-run in the new one. A guard that reads a variable this process never set is the
failure to watch for, and it has two shapes — read as false it **blocks silently**, which is the safe
direction and what happened the first time this rule was applied; written as a truthiness test it can
**pass vacuously**, which is the dangerous one, because the step runs and nothing checked it.

## 5. Files

- **Filenames are English**, lowercase, hyphen-separated.
- Never commit: `node_modules/`, logs, editor scratch, any `.env`.
- The bundle is installed by a link, so what is in the working tree is exactly what runs. A broken
  `index.js` on `main` breaks the author's next install.

## 6. Documents

`docs/INDEX-en.md` is the map. Naming and placement:

| What | Where | Name |
|---|---|---|
| entry points and live state | repository root, uppercase | `README.md`, `README-zh.md`, `AGENTS.md`, `CONTRIBUTING.md`, `PLAN.md`, `PROGRESS.md`, `CHANGELOG.md`, `LICENSE` |
| a design document | `docs/`, lowercase | `name-en.md` + `name-zh.md`, English as the source of truth |
| a decision | `docs/adr/` | `NNNN-short-title.md`, four digits, zero-padded, never renamed |

A release adds a `CHANGELOG.md` entry — the release-level summary — while `PROGRESS.md` stays the
append-only engineering narrative.

Root files are single-language and change often; `docs/` files are bilingual and change rarely.

**The pair rule is enforced by a scan, not by a list.** `scripts/check.mjs` reads the top level of `docs/`
and classifies every `*.md` there, so a new document cannot escape the rule by not being added to a list.
Four shapes exist, and a file the rule cannot classify fails by name:

| Shape | What the check proves |
|---|---|
| `name-en.md` + `name-zh.md` | both halves exist, in either direction — a missing one is a failure naming the file |
| `name-en-zh.md` | one file carrying both languages (a two-column glossary). It must contain Chinese text **and** English prose, because the suffix is a claim, not evidence |
| `name.md` | deliberately single-language, **and listed in `SINGLE_LANGUAGE_DOCS` in `scripts/check.mjs` with the reason**. An undeclared one fails, and so does a listed one whose file is gone |
| `docs/adr/NN-name.md` | out of scope: a decision is English-only and numbered, so it never pairs |

The allow-list is the one way out, and it is a list you must edit on purpose: the reason is what tells the
next reader that a single-language document was a decision rather than an oversight. A naming convention
(no language suffix means single-language by choice) was considered and rejected — it records the fact
without the reason, and dropping a suffix would pass the check without deciding anything.

Root documents are outside that rule and handled explicitly in the same script: `README.md` is the one
English document without an `-en` suffix, so the README pair is named rather than derived.

**Nothing machine-specific goes into a shared document.** No absolute paths, no user names, no local
folder names. Write commands relative to the repository root.

- **Every design document carries an owner line** under its title:
  `> Owner: @handle · Revisit when: <trigger>`. A trigger, not a date. An ADR is the exception: it
  carries a `## Revisit when` section at the end instead, so the header line is not repeated there.
- **A decision that is expensive to reverse becomes an ADR**, not a paragraph in `PROGRESS.md`.
- **Every citation resolves.** `scripts/check.mjs` follows each `docs/<name>.md` reference and each `§N` in
  these documents and in the six host modules, and names the document and the section when the target is not
  there; `PROGRESS.md` and `CHANGELOG.md` are exempt, because an entry that cited a section before it moved
  is correct as of the commit that wrote it.

## 7. Definition of done

- [ ] `check` is green on the PR
- [ ] The PR template is filled in
- [ ] Bilingual pairs updated in the same commit
- [ ] The task box in `PLAN.md` is ticked in the same PR that delivers the task — nobody ticks it for
      someone else
- [ ] `docs/INDEX-en.md` and `INDEX-zh.md` updated if a document was added, renamed or removed
- [ ] Any test that asserts an **ordering or an identity among equals** respects §4's same-millisecond
      rule: assert the set or the count, never which one of two equally old records went
- [ ] The gate was run as its own step, or every step after it was gated on its exit code — §4's rule: a
      failing check must not be able to reach the remote inside one command list
