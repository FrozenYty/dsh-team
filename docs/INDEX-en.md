# Document index

> Owner: @FrozenYty · Revisit when: a document is added, renamed or removed

[中文](INDEX-zh.md)

What is in this repository, which document answers what, and what else has to change alongside a
given change. Read this before adding or moving a document.

## 1. Reading order

```
README.md  ->  PLAN.md  ->  PROGRESS.md  ->  docs/architecture-en.md  ->  the ADR that touches your change
```

1. `README.md` — what the plugin is and how to install it.
2. `PLAN.md` — the only task source. Open work lives here.
3. `PROGRESS.md` — why the current state looks like this. Append-only.
4. `docs/architecture-en.md` — how the pieces fit, including the roster state matrix.
5. `docs/adr/` — the decisions that are expensive to reverse.

## 2. Document map

| Question | Document | Language |
|---|---|---|
| What is this, and how do I install it? | `README.md` | pair |
| What is left to do, and what does done mean? | `PLAN.md` | English |
| What changed recently, and why? | `PROGRESS.md` | English |
| How do agents and the roster fit together? | `docs/architecture-en.md` | pair |
| Why is the roster ours instead of the shipped one? | `docs/adr/0001-own-roster-on-subagents.md` | English |
| Why does the bundle entry import nothing? | `docs/adr/0002-zero-import-bundle-entry.md` | English |
| Where does the roster live? | `docs/adr/0003-roster-storage.md` | English |
| Why does retirement move files, and why does it patch host services? | `docs/adr/0004-retire-through-persistence.md` | English |
| How does the Settings panel reach the Host, and why is there an HTTP route? | `docs/adr/0005-share-operations-behind-an-http-bridge.md` — superseded by 0008 | English |
| Why does the panel show one session's roster, and how does it know which session that is? | `docs/adr/0006-session-scoped-roster-panel.md` — superseded by 0008 | English |
| Why is the plugin model-facing only? | `docs/adr/0008-model-only-surface.md` | English |
| Why does a replacement hand over the record, and in which order does it happen? | `docs/adr/0009-replacement-handoff.md` | English |
| Why is the roster one record per Lead, and why is nothing ever deleted? | `docs/adr/0010-roster-layout-and-retention.md` — point 3 superseded by 0011 | English |
| Why is the trash capped, and what happens to a pruned member? | `docs/adr/0011-trash-retention.md` — point 1 superseded by 0012 | English |
| Why is the trash cap a config field, and why does the entry declare no Config schema? | `docs/adr/0012-configurable-retention.md` | English |
| Why do one-shot members leave on their own, and why does the sweep need evidence? | `docs/adr/0013-ephemeral-members.md` | English |
| Why is the plugin called `dsh-team`, and which identifiers did not change? | `docs/adr/0014-plugin-name.md` | English |
| Why is the handoff brief a stored template, and why is it one tool? | `docs/adr/0015-handoff-template.md` | English |
| How does a member start with its own cwd, model or preset, and where does a stale name point now? | `docs/adr/0016-spawn-capabilities.md` | English |
| Why does the plugin own the work board, and what moves when a member is replaced? | `docs/adr/0017-own-task-board.md` — points 1, 4, 5, 6 and 11 adjusted by 0020 | English |
| Why is a member a file on disk, and which frontmatter subset is accepted? | `docs/adr/0018-member-definitions.md` — point 4 adjusted by 0019 | English |
| Which assignment does a successor get, and what does a definition mean on a replace? | `docs/adr/0019-definition-precedence-on-replace.md` | English |
| Why does a task carry a body, and why can a board write not undo a handover? | `docs/adr/0020-task-body-and-write-integrity.md` | English |
| Why is the handoff template a team file, and why is a stored write refused while it exists? | `docs/adr/0021-team-file-handoff-template.md` | English |
| Why can a member read the work it owns, and why does the board keep one writer? | `docs/adr/0022-member-reads-its-work.md` | English |
| Why does the shipped team panel list this plugin's members, and why is a retired one absent? | `docs/adr/0023-panel-overlay.md` | English |
| Why does the plugin forward the Lead's model route, why never its effort, and why is a straggler flagged? | `docs/adr/0024-forward-the-lead-route.md` | English |
| What member lifecycle is missing upstream, in a form to paste into an issue? | `docs/upstream-lifecycle-gap.md` | English |
| How do we branch, commit and merge? | `CONTRIBUTING.md` | English |
| What are an assistant's rules here? | `AGENTS.md` | English |

## 3. Authority

When two documents disagree, the later one wins in this order:

1. an accepted ADR,
2. `docs/architecture-en.md`,
3. `PLAN.md`,
4. `README.md`,
5. `PROGRESS.md` (a historical record — it describes what was true then, and is never corrected).

The installed Harness beats all of them on Harness behaviour. If this repository and the running
Harness disagree, the repository is wrong.

## 4. What else changes alongside a change

| If you change | Also update |
|---|---|
| a tool name, parameter or result field | `docs/architecture-en.md` §2 or §4.5, `actions.js`, `README.md` + `README-zh.md`, `PLAN.md` task text |
| which scope receives a tool, or what a member may read | `index.js`, `actions.js`, `docs/architecture-en.md` §4.5 and §4.5.2, `README.md` + `README-zh.md`, ADR 0022 |
| an operation's behaviour or failure reason | `actions.js`, the tool schema in `index.js`, `docs/architecture-en.md` §4 |
| what adoption covers, or the discovery-row shape it consumes | `actions.js`, `roster.js`, `docs/architecture-en.md` §4.5.1, `README.md` + `README-zh.md` |
| a roster phase or transition | the state matrix in `docs/architecture-en.md` §4.3, and the ADR if the model changed |
| the transfer rule — what happens to a member's open tasks on replace, retire or restore | the transfer matrix in `docs/architecture-en.md` §4.3.2, `actions.js`, `README.md` + `README-zh.md`, ADR 0017 |
| a task row's `body`, or how a board write is built from the stored record | `roster.js`, `actions.js`, the tool schema in `index.js`, `docs/architecture-en.md` §4.2 and §4.3.2, `README.md` + `README-zh.md`, ADR 0020 |
| the member-definition format, the accepted frontmatter subset or the `team/` path | `definitions.js`, `docs/architecture-en.md` §4.6, `README.md` + `README-zh.md`, ADR 0018 |
| the team-file format, the reserved `team.md` name, the three template sources or the write refusal | `definitions.js`, `actions.js`, `index.js`, `docs/architecture-en.md` §4.4 and §4.7, `README.md` + `README-zh.md`, ADR 0021 |
| which source wins for a definition field on a replace, or what a file's `ephemeral` means for a successor | the definition matrix in `docs/architecture-en.md` §4.3.3, `actions.js`, `index.js`, ADR 0019 |
| a bundle config key or patch row | `README.md` + `README-zh.md`, `docs/architecture-en.md` §1 |
| the durable record shape | `docs/architecture-en.md` §4.2, a new ADR, and a migration note in `PROGRESS.md` |
| the projection exits, or what the shipped team panel shows | `host-hooks.js`, `index.js`, `docs/architecture-en.md` §2.4, `README.md` + `README-zh.md`, ADR 0023 |
| what route a member starts on, which source wins, or whether a straggler is flagged | `actions.js`, `roster.js`, the tool schemas in `index.js`, `docs/architecture-en.md` §2.6, §4.1, §4.2 and §4.5, `README.md` + `README-zh.md`, ADR 0024 |
| a document added, renamed or removed | this file and `INDEX-zh.md` |
| the plugin's name or display title, or a patch row's `name` | `package.json`, `cordis.patch.yml`, `AGENTS.md`, `README.md` + `README-zh.md`, `docs/architecture-en.md` + `docs/architecture-zh.md`, a new ADR |
| anything that alters the install procedure | `README.md` + `README-zh.md` |

## 5. Not in this repository

- The Harness itself. Its APIs are read from the installed application, not vendored here.
- The profile. Installing this bundle changes the author's profile; the profile is not tracked.
- The research that produced ADR 0001 and ADR 0002. It lives outside the repository, in the session's
  research folder; the ADRs carry the conclusions that still matter.
