# dsh-team-roster

[中文](README-zh.md)

A DeepSeek Harness plugin that gives an agent team the lifecycle the shipped one lacks: members you can
retire, remove and replace — with a recoverable session trash, a roster that survives the removal, and
context tooling for long-running teammates.

**Status**: v0.3 installed and verified in the author's profile; the Settings panel is still ahead.
Live task state is in [PLAN.md](PLAN.md); recent changes are in [PROGRESS.md](PROGRESS.md).

**Repository**: [github.com/FrozenYty/dsh-team-roster](https://github.com/FrozenYty/dsh-team-roster)

## Why this exists

The shipped experimental Agent Teams roster is a fold over the Lead Session's append-only event log:

- member phases are `provisioning | active | failed`, and the projection rejects any transition out of a
  terminal phase — a synthetic "retired" record does not fail safely, it makes the projection permanently
  unusable for that Lead;
- `maxMembers` (16) is checked against a list that only grows, so failed and finished members keep
  consuming it forever;
- names are never reused, and there is no deletion anywhere in the contract.

Upstream's in-progress redesign makes teammates plain subagents and still states *"Names are permanent"*,
with deletion called *"a later product decision"*. Separately, this Desktop profile ships the compaction
backend **disabled**, so no agent condensed anything.

This plugin supplies the missing half, without forking the shipped roster.

## What you get

| Tool | Behaviour |
|---|---|
| `spawn_member` | Start a named member; a successor reuses the base name at the next generation (`reviewer` → `reviewer-g2`). |
| `list_members` | The roster: phase, generation, live state, and — while resident — context pressure and `compactable`. Members the shipped roster created are **adopted** on first read, so they become retirable too. |
| `message_member` | Deliver one message to a live member; an unloaded member is cold-resumed from its own Session. |
| `stop_member` | Cancel only the current turn; the activation and inbox are kept. |
| `retire_member` | Drain, move the Session artifact to a recoverable trash directory, and tombstone the record. |
| `compact_member` | Force one compaction on a resident, idle member. |

Plus two host-side effects, applied for every retirement:

- **Projections are filtered.** The host's session-list exits are wrapped so retired members stop
  appearing in the top subagent picker and the built-in team panel. No host source is modified and the
  Web app is not rebuilt.
- **The shipped budget is credited.** While a spawn runs, the legacy roster's effective `maxMembers` is
  raised by the number of retired members of that Lead, so one retirement buys back one slot.

The bundle also enables the shipped `compaction-basic` row, which this profile ships disabled.

## Retirement is not deletion

| Step | Behaviour |
|---|---|
| Stop | The child is drained; its activation and capacity slot are released. |
| Move | Its persisted session is moved to `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`. Move, not delete: recovery is a directory move back. |
| Tombstone | The roster record becomes `retired`, the name becomes available at the next generation, and the projections stop serving the member. |
| Fallback | If the artifact cannot be moved, the workspace archive hides the Session instead, and the result says so. |

## Install

```
plugin_manager  install_bundle  target: <absolute path to this repository>
```

The bundle is linked, not copied, so a changed module needs `remove_bundle` followed by `install_bundle`
to load a fresh module generation.

Verification after install:

- the row activates with `application: applied` and no warnings;
- `list_members` is callable from a Lead session and reports resident members' pressure;
- `retire_member` returns `trashed: true` and a `trash_path` on a session that has an artifact;
- `include:compaction-basic` reports status `schema` (not `inactive`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DSH_TEAM_ROSTER_DATA_DIR` | `~/.dsh/team-roster` | Trash root and roster data directory. |

The roster itself lives in a `storageDomain` domain (ADR 0003), not in a Session log.

## Development

```sh
node --check index.js            # per module
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

`--test-isolation=none` matters on Windows: the default runner spawns one process per file, and this
machine's sandbox refuses that spawn. CI uses the same invocation so the two agree.

## Repository layout

| Path | What |
|---|---|
| `index.js` | Host plugin entry, tools, retirement flow |
| `roster.js` | Durable roster, name generations, adoption, legacy-domain migration |
| `trash.js` | Session-artifact recovery directory |
| `host-hooks.js` | Projection filter and roster slot credit |
| `tests/` | `node:test` unit tests |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg` | the bundle |
| `PLAN.md`, `PROGRESS.md` | tasks, and the append-only change log |
| `docs/` | design documents (bilingual) and ADRs |

## Contributing

Read [AGENTS.md](AGENTS.md) if you are an AI assistant, and [CONTRIBUTING.md](CONTRIBUTING.md) for
branches, commits and what CI enforces.
