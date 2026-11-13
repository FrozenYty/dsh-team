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
4. `docs/architecture-en.md` — the layers, the Harness substrate, the released surface and the risks.
5. `docs/adr/` — the decisions that are expensive to reverse.

A design subject is its own document rather than a section of `architecture-`: a member's life is
`docs/member-lifecycle-en.md`, the work board `docs/task-board-en.md`, the brief and its template
`docs/handoff-en.md`, and the stored record with its retention `docs/roster-storage-en.md`. §2 is the map.

## 2. Document map

| Question | Document | Language |
|---|---|---|
| What is this, and how do I install it? | `README.md` | pair |
| What is left to do, and what does done mean? | `PLAN.md` | English |
| What changed recently, and why? | `PROGRESS.md` | English |
| What did each release contain, at release level? | `CHANGELOG.md` | English |
| What are the layers, the Harness substrate, the released surface and the risks? | `docs/architecture-en.md` | pair |
| How does a member move between phases, and what do a retirement and a replacement do? | `docs/member-lifecycle-en.md` | pair |
| What does the work board do, and where does open work go on a replace? | `docs/task-board-en.md` | pair |
| How is a successor briefed, and which template wins? | `docs/handoff-en.md` | pair |
| What is stored, and how is the trash bounded? | `docs/roster-storage-en.md` | pair |
| What proves the Host still behaves as this plugin expects, and how is a round run? | `docs/live-acceptance-en.md` | pair |
| Which model does a member run on, and what bills what? | `docs/routes-en.md` | pair |
| What has to change when upgrading from an older version? | `docs/upgrading-en.md` | pair |
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
| Why do one-shot members leave on their own, and why does the sweep need evidence? | `docs/adr/0013-ephemeral-members.md` — points 2, 3 and 5 adjusted by 0026 | English |
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
| Why does a host hook install when its service exists, and why does `list_members` report whether it did? | `docs/adr/0025-host-hook-install.md` | English |
| Why is a member's lifetime declared on the call, why can an open task veto a sweep, and why does a standing member need the person's words? | `docs/adr/0026-declared-member-lifetime.md` | English |
| Why does the roster live in a file under the workspace, and what is the storage domain for now? | `docs/adr/0027-roster-file-under-the-workspace.md` | English |
| Why does a tombstone record a directory name, and how does the cap match one? | `docs/adr/0028-trash-directory-name-not-path.md` | English |
| Why is a member definition read from a chain, and why do the shipped templates lose to a workspace file? | `docs/adr/0029-definition-chain.md` | English |
| Why does a tombstone leave the roster, and what keeps its member out of the shipped panels? | `docs/adr/0030-tombstone-window-and-archive.md` | English |
| Why is the plugin's state files only, and why does the storage domain no longer answer a read? | `docs/adr/0031-files-only-state.md` | English |
| Why does a replacement write both records, and why does a link name a member id rather than a name? | `docs/adr/0032-bilateral-succession.md` | English |
| Why is the host storage domain gone, and why does a path under a file count as no file? | `docs/adr/0033-domain-removed.md` | English |
| Why is an artifact's origin stored relative to the sessions root, and what does a carried roster resolve against? | `docs/adr/0034-relative-artifact-origin.md` | English |
| Why can the archive be read on request, and what does the reader carry that the writer cannot? | `docs/adr/0035-archive-readable-on-request.md` | English |
| What member lifecycle is missing upstream, in a form to paste into an issue? | `docs/upstream-lifecycle-gap-en.md` | pair |
| How do we branch, commit and merge? | `CONTRIBUTING.md` | English |
| What are an assistant's rules here? | `AGENTS.md` | English |

## 3. Authority

When two documents disagree, the later one wins in this order:

1. an accepted ADR,
2. the design documents (`docs/architecture-en.md` with `docs/member-lifecycle-en.md`,
   `docs/task-board-en.md`, `docs/handoff-en.md` and `docs/roster-storage-en.md`),
3. `PLAN.md`,
4. `README.md`,
5. `PROGRESS.md` (a historical record — it describes what was true then, and is never corrected).

The installed Harness beats all of them on Harness behaviour. If this repository and the running
Harness disagree, the repository is wrong.

## 4. What else changes alongside a change

| If you change | Also update |
|---|---|
| a tool name, parameter or result field | `docs/architecture-en.md` §2 or §5, `actions.js`, `README.md` + `README-zh.md`, `PLAN.md` task text |
| which scope receives a tool, or what a member may read | `index.js`, `actions.js`, `docs/architecture-en.md` §5 and §5.2, `README.md` + `README-zh.md`, ADR 0022 |
| an operation's behaviour or failure reason | `actions.js`, the tool schema in `index.js`, `docs/architecture-en.md` §5 |
| what adoption covers, or the discovery-row shape it consumes | `actions.js`, `roster.js`, `docs/architecture-en.md` §5.1, `README.md` + `README-zh.md` |
| a roster phase or transition | the state matrix in `docs/member-lifecycle-en.md` §1, and the ADR if the model changed |
| a member's lifetime, what may veto a sweep, or what a retirement must carry | `docs/member-lifecycle-en.md` §2, `roster.js`, `actions.js`, the tool schemas in `index.js`, `README.md` + `README-zh.md`, ADR 0026 |
| the transfer rule — what happens to a member's open tasks on replace, retire or restore | the transfer matrix in `docs/task-board-en.md` §2, `actions.js`, `README.md` + `README-zh.md`, ADR 0017 |
| a task row's `body`, or how a board write is built from the stored record | `roster.js`, `actions.js`, the tool schema in `index.js`, `docs/task-board-en.md` §1 and §3, `README.md` + `README-zh.md`, ADR 0020 |
| the member-definition format, the accepted frontmatter subset or the definition chain | `definitions.js`, `docs/architecture-en.md` §6, `README.md` + `README-zh.md`, ADR 0018, ADR 0029 |
| the team-file format, the reserved `team.md` name, the three template sources or the write refusal | `definitions.js`, `actions.js`, `index.js`, `docs/handoff-en.md` §1 and §2, `README.md` + `README-zh.md`, ADR 0021 |
| which source wins for a definition field on a replace, or what a file may declare about a member's lifetime | the definition matrix in `docs/architecture-en.md` §6.1, `actions.js`, `index.js`, ADR 0019, ADR 0026 |
| a bundle config key or patch row | `README.md` + `README-zh.md`, `docs/architecture-en.md` §1 |
| the durable record shape | `docs/roster-storage-en.md` §1, a new ADR, and a migration note in `PROGRESS.md` |
| the projection exits, what the shipped team panel or the shipped `list_agents` read shows, or whether a host hook installs | `host-hooks.js`, `index.js`, `docs/architecture-en.md` §2.4, `README.md` + `README-zh.md`, ADR 0023, ADR 0025 |
| what route a member starts on, which source wins, or whether a straggler is flagged | `actions.js`, `roster.js`, the tool schemas in `index.js`, `docs/architecture-en.md` §2.5 and §4, `docs/roster-storage-en.md` §1, `docs/routes-en.md` and `docs/architecture-en.md` §5, `README.md` + `README-zh.md`, ADR 0024 |
| a released version that removes or renames a tool, a config key or a stored identifier | `docs/upgrading-en.md`, `README.md` + `README-zh.md`, `CHANGELOG.md`, a new ADR if the identifier is frozen |
| the retention cap, or what a pruned tombstone keeps | `docs/roster-storage-en.md` §3, `trash.js`, `roster.js`, ADR 0011, ADR 0012 |
| a document added, renamed or removed | this file and `INDEX-zh.md` |
| the plugin's name or display title, or a patch row's `name` | `package.json`, `cordis.patch.yml`, `AGENTS.md`, `README.md` + `README-zh.md`, `docs/architecture-en.md` + `docs/architecture-zh.md`, a new ADR |
| anything that alters the install procedure | `README.md` + `README-zh.md` |

## 5. Not in this repository

- The Harness itself. Its APIs are read from the installed application, not vendored here.
- The profile. Installing this bundle changes the author's profile; the profile is not tracked.
- The research that produced ADR 0001 and ADR 0002. It lives outside the repository, in the session's
  research folder; the ADRs carry the conclusions that still matter.
