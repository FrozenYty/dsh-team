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
Modules: `plugin`, `bundle`, `roster`, `ui`, `docs`, `ci`.

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
| Entry syntax | `node --check index.js` (also `roster.js`, `trash.js`, `host-hooks.js`) | repair the syntax error |
| Unit tests | `node --test --test-isolation=none tests/*.test.mjs` | fix the failing behaviour, not the assertion |

`scripts/check.mjs` verifies, without loading the Harness:

- `package.json` parses and every path in `files` exists;
- `locale/en.json` and `locale/zh.json` carry the same keys;
- `cordis.patch.yml` parses as a patch array;
- no document in the repository contains an absolute machine path.

It cannot prove the plugin activates. That requires installing the bundle into a profile, which is a
manual step with a real side effect — see the README.

## 5. Files

- **Filenames are English**, lowercase, hyphen-separated.
- Never commit: `node_modules/`, logs, editor scratch, any `.env`.
- The bundle is installed by a link, so what is in the working tree is exactly what runs. A broken
  `index.js` on `main` breaks the author's next install.

## 6. Documents

`docs/INDEX-en.md` is the map. Naming and placement:

| What | Where | Name |
|---|---|---|
| entry points and live state | repository root, uppercase | `README.md`, `README-zh.md`, `AGENTS.md`, `CONTRIBUTING.md`, `PLAN.md`, `PROGRESS.md`, `LICENSE` |
| a design document | `docs/`, lowercase | `name-en.md` + `name-zh.md`, English as the source of truth |
| a decision | `docs/adr/` | `NN-short-title.md`, two digits, never renamed |

Root files are single-language and change often; `docs/` files are bilingual and change rarely.

**Nothing machine-specific goes into a shared document.** No absolute paths, no user names, no local
folder names. Write commands relative to the repository root.

- **Every design document carries an owner line** under its title:
  `> Owner: @handle · Revisit when: <trigger>`. A trigger, not a date.
- **A decision that is expensive to reverse becomes an ADR**, not a paragraph in `PROGRESS.md`.

## 7. Definition of done

- [ ] `check` is green on the PR
- [ ] The PR template is filled in
- [ ] Bilingual pairs updated in the same commit
- [ ] The task box in `PLAN.md` is ticked by whoever merged
- [ ] `docs/INDEX-en.md` and `INDEX-zh.md` updated if a document was added, renamed or removed
