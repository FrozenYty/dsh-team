# AGENTS.md

Instructions for AI assistants working in this repository. Read this before your first task.

> This file only holds what is not written elsewhere. If a rule already lives in `CONTRIBUTING.md`,
> `PLAN.md` or `docs/`, delete the copy here instead of maintaining two versions.

## 1. Before you start

Read the repository documents in the order `docs/INDEX-en.md` §1 gives. Two entries exist for an
assistant rather than a reader: `CONTRIBUTING.md` before your first commit, and the ADR that touches your
change before you edit anything.

- The files beat your memory. The plugin runs inside a sealed Electron asar whose
  version changes under you; anything you remember about Harness APIs may already be wrong.
- When something is unclear, say what is unclear and what would make it clear. Do not guess at
  another lane's intent.

## 2. The project

`dsh-team-roster` is a DeepSeek Harness profile bundle. It gives an agent team the lifecycle the
shipped experimental Agent Teams packages lack: a roster whose members can be retired, removed and
replaced, instead of one that only grows.

Two layers, and they must not be confused:

- **The bundle** (`package.json` and the nine files its `files` list publishes: `index.js`, `actions.js`,
  `roster.js`, `trash.js`, `host-hooks.js`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`,
  `icon.svg`) is
  what gets installed into a profile. It is linked from this repository, so no build step exists.
  It has no browser half: every surface is a model-facing tool (ADR 0008).
- **The Harness** is the host. Its APIs are read from the installed asar, never from this repository.

`PLAN.md` owns task state; `PROGRESS.md` owns the record of what changed. Do not restate either here.

## 3. Who you are helping

| User | Lane | Default: read-only |
|---|---|---|
| Yao Tianyu (@FrozenYty) | A — runtime, roster lifecycle, Harness integration | B, C |
| — | B — documents, ADRs, plans | A, C |
| — | C — UI | retired with the Settings panel (ADR 0008); default: read-only |

One person owns the repository; lanes describe *where an agent may write*, not separate owners.
Everything outside your assigned lane is read-only unless the user says otherwise.

## 4. Working principles

**1. Look before you move.** Read the file, check the installed API, check the branch. Never edit from
memory — the Harness version and this repository both move between sessions.

**2. Smallest change that works.** If you write 200 lines and it could be 50, rewrite it.

**3. Simple beats clever.** No abstraction for single-use code, no configurability nobody asked for,
no error handling for situations that cannot happen. Would a senior engineer call this overbuilt?

**4. Define done before coding.** `PLAN.md` gives a “done when” for each task. If yours has none, write
one in the PR description first — a check that can fail, not a feeling.

**5. Change one thing, search the whole repository.** Renaming a tool, a phase or a config key means
grepping every reference: `index.js`, `locale/`, the README pair, `docs/`, and `PLAN.md`.

**6. Read the error.** A non-zero exit is information. `ERR_MODULE_NOT_FOUND` from a bundle entry is a
known trap, not a mystery — see ADR 0002 before “fixing” it by adding a dependency.

**7. A blocked operation is a request for permission, not an invitation to work around it.** Say what
was refused and ask. Profile installs, `plugin_manager` calls and any write outside this repository are
the user's decision.

**8. Specify the state matrix before you write the code.** The roster is a state machine, and a lifecycle
bug is a cell nobody filled in: a retire that races a spawn, a message to a member that has been removed,
a replacement whose predecessor still owns a task. Write the phases, the events, and the cell each pair
lands in — in `docs/architecture-en.md`, not in a comment — before implementing the transition.

## 5. Rules of the shared repository

- Branch names, commit format and PR rules live in `CONTRIBUTING.md`. Follow them; they are not
  repeated here.
- **Never force-push.** Never push to `main`; it is protected, and history there is what users clone.
- **Never tick a box in `PLAN.md`** for work you did not deliver.
- **`PROGRESS.md` is append-only.** Add a dated entry; never rewrite an older one.
- **An accepted ADR is closed.** To change a decision, write a new ADR that supersedes it.
- **A problem outside your lane: report it, do not fix it.** One sentence in the PR description.

## 6. Verify and report

```bash
node scripts/check.mjs                 # manifest + published files, zero-import rule, execute(args, exec), locale parity, patch rows, pairs, no machine paths
node --check index.js                  # the bundle entry parses as ESM
node --test --test-isolation=none tests/*.test.mjs   # unit tests, one process on purpose
```

`--test-isolation=none` is required here: the default runner spawns one process per file and this
machine's sandbox refuses that spawn. It also requires Node 24: Node 22 documents the flag as
`--experimental-test-isolation`, so the `--test-isolation` spelling is the Node 24 one — which is why
this machine runs v24 and CI pins v24. Do not "simplify" the flag away in CI either: both sides run the
same command so a local pass means the same thing as a green run.

`scripts/check.mjs` cannot prove the plugin works: it never loads the Harness. Installing the bundle
into a profile and calling the tools is the only real check, and it is the user's call each time.
Never claim a tool works because the install printed `applied`.

A tool wrapper is not covered by the unit tests. They call `actions.js` directly, so a mistake that lives
only in `index.js`'s `execute` reaches the model and nothing else — which is how `retire_member`,
`restore_member` and `stop_member` all shipped reading an undeclared `exec`. `scripts/check.mjs` rejects
an `execute(` that does not declare `(args, exec)` for that reason; everything else about a wrapper needs a
live tool call.

Report in three parts:

1. **What changed** — files and behaviour, not intentions.
2. **How it was verified** — commands run and their result.
3. **What is left undone** — be explicit; “it works” is not a report.

## 7. Delegation

Work is split along **two axes, and both are required**: the lane says *where an agent may write*, the
task type says *how the work is done and what finished means*.

**Finding and fixing are different jobs.** An agent that both audits and repairs has no reason to report
the findings it would rather not touch — and one that repairs inside a named file list cannot quietly
rewrite an ADR or an old `PROGRESS.md` entry to match the present.

**Every brief carries five things**: the repository and the lane, the exact files or modules in scope,
the acceptance as a command that can fail, the checks to run, and the report format.

## 8. Language

Talk to your user in Chinese. Write everything to disk in English: code, comments, commit messages,
documents, PR descriptions.

Chinese prose uses full-width punctuation — “”、，。；：（） — never ASCII quotes or commas wedged
into a Chinese sentence.
