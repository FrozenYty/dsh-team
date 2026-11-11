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
| `list_members` — roster with lifecycle phase, live state and context pressure | v0.2 |
| `compact_member` — compact one resident, idle member in place | v0.1, now roster-based |
| `spawn_member` / `retire_member` — generation-suffixed names; retire for good | v0.2 |
| `message_member` / `stop_member` — deliver a message; cancel one turn without retiring | v0.2 |
| Adopts members the shipped roster created, so they become retirable too | v0.2 |
| Team panel in Settings | Planned |

**One roster, two writers.** The shipped team tools stay mounted because they own the shared task
board, and any member they create is adopted into this plugin's roster the next time it is read. So
`retire_member` applies to members this plugin did not create — which is the point: before v0.2 nothing
could remove them at all. Retirement is this plugin's durable fact: it drains the child, archives its
Session, and tombstones the record. Nothing is deleted, and the shipped roster still lists what it
created.

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
