# Document index

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
| Why is the roster one record per Lead, and why is nothing ever deleted? | `docs/adr/0010-roster-layout-and-retention.md` | English |
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
| an operation's behaviour or failure reason | `actions.js`, the tool schema in `index.js`, `docs/architecture-en.md` §4 |
| what adoption covers, or the discovery-row shape it consumes | `actions.js`, `roster.js`, `docs/architecture-en.md` §4.5.1, `README.md` + `README-zh.md` |
| a roster phase or transition | the state matrix in `docs/architecture-en.md` §4.3, and the ADR if the model changed |
| a bundle config key or patch row | `README.md` + `README-zh.md`, `docs/architecture-en.md` §1 |
| the durable record shape | `docs/architecture-en.md` §4.2, a new ADR, and a migration note in `PROGRESS.md` |
| a document added, renamed or removed | this file and `INDEX-zh.md` |
| anything that alters the install procedure | `README.md` + `README-zh.md` |

## 5. Not in this repository

- The Harness itself. Its APIs are read from the installed application, not vendored here.
- The profile. Installing this bundle changes the author's profile; the profile is not tracked.
- The research that produced ADR 0001 and ADR 0002. It lives outside the repository, in the session's
  research folder; the ADRs carry the conclusions that still matter.
