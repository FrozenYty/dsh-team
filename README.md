# dsh-team-control

[中文](README-zh.md)

A DeepSeek Harness plugin that gives an agent team a lifecycle the shipped one does
not have: members you can retire, remove and replace, instead of a roster that only
grows.

**Status**: v0.1 installed and verified in the author's profile; v0.2 (own roster with
real removal) in progress. Live task state is in [PLAN.md](PLAN.md); recent changes
are in [PROGRESS.md](PROGRESS.md).

**Repository**: [github.com/FrozenYty/dsh-team-control](https://github.com/FrozenYty/dsh-team-control)

## Why this exists

The shipped experimental Agent Teams packages (`@deepseek-ai/dsh-experimental-agent-team`
plus its tool and UI packages) keep a roster that is a fold over the Lead Session's
append-only event log:

- member phases are `provisioning | active | failed`, and the projection rejects any
  transition out of a terminal phase — a synthetic "retired" record does not fail
  safely, it makes the projection permanently unusable for that Lead;
- `maxMembers` (16) is checked against a list that only grows, so failed and finished
  members keep consuming it forever;
- names are never reused, and there is no deletion anywhere in the contract.

Upstream is not about to fix this. Its in-progress redesign makes teammates plain
subagents and still states: *"Names are permanent"*, and *"a service-level bound or
delete operation is a later product decision"*.

Separately, this Desktop profile ships the compaction backend **disabled**, so no agent
condensed anything: a teammate grew unchecked toward the model's 1M-token window.
v0.1 fixes that and adds the two inspection tools below. v0.2 replaces the roster.

## What you get

| Piece | Status |
|---|---|
| Enables the shipped `compaction-basic` backend (profile-wide) | Shipped in v0.1 |
| `member_context` — per-member context pressure, resident/idle state | Shipped in v0.1 |
| `compact_member` — compact one in-place member | Shipped in v0.1 |
| `spawn_member` / `list_members` / `retire_member` — own durable roster with generation-suffixed names | Shipped in v0.2, verified live |
| Team panel in Settings | Planned |

**Two rosters during the migration.** `list_agents` still reports the shipped team roster; `list_members`
reports the roster this plugin owns. They are different sets, because the shipped roster cannot remove a
member. Until P2-07 disables the shipped roster tools, use `list_members` for anything created with
`spawn_member` and do not mix the two.

The v0.1 surface is documented in [docs/architecture-en.md](docs/architecture-en.md);
the durable-roster design is [docs/adr/0001](docs/adr/0001-own-roster-on-subagents.md).

## Install

The plugin is a profile bundle: a Host plugin row plus a patch that also enables the
shipped compaction backend.

```
plugin_manager  install_bundle  target: <absolute path to this repository>
```

The bundle is linked, not copied, so a changed `index.js` needs `remove_bundle`
followed by `install_bundle` to load a fresh module generation.

Verification after install:

- the plugin row activates with `application: applied` and no warnings;
- `member_context` is callable from a Team Lead session;
- `include:compaction-basic` reports status `schema` (not `inactive`);
- `member_context` reports `compactor: available`.

## Repository layout

| Path | What |
|---|---|
| `package.json`, `cordis.patch.yml`, `index.js`, `roster.js` | the bundle that gets installed |
| `locale/`, `icon.svg` | plugin display metadata |
| `PLAN.md`, `PROGRESS.md` | tasks, and the append-only change log |
| `docs/` | design documents (bilingual) and ADRs |
| `scripts/check.mjs` | the repository's local checks |

## Contributing

Read [AGENTS.md](AGENTS.md) if you are an AI assistant, and
[CONTRIBUTING.md](CONTRIBUTING.md) for branches, commits and what CI enforces.
