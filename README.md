# dsh-team-roster

[中文](README-zh.md)

A DeepSeek Harness plugin that gives an agent team the lifecycle the shipped one lacks: members you can
retire, remove and replace — with a recoverable session trash, a roster that survives the removal, and
context tooling for long-running teammates.

**Status**: v0.4 is model-facing only. The Settings panel and its loopback HTTP bridge that shipped in
v0.3 were removed — the panel was never rendered in a real profile, and its clicks did not work — and
the same effort went into the model-facing surface, which now covers every subagent an agent spawns
(ADR 0008). The lifecycle tools themselves are installed and verified in the author's profile. Recent
changes are in [PROGRESS.md](PROGRESS.md).

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
| `list_members` | The roster: target, child session id, phase, generation, live state, and — while resident — context pressure and `compactable`. Adopts members the shipped roster created **and** children spawned with the shipped `subagent` / `subagent_fork` tools, so every subagent the model controls is listed and retirable. |
| `message_member` | Deliver one message to a live member; an unloaded member is cold-resumed from its own Session. |
| `stop_member` | Cancel only the current turn; the activation and inbox are kept. |
| `retire_member` | Drain, move the Session artifact to a recoverable trash directory, and tombstone the record. |
| `restore_member` | Bring a retired member back: move its trashed Session to the recorded original path and return the record to active. |
| `compact_member` | Force one compaction on a resident, idle member. |

Plus two host-side effects, applied for every retirement:

- **Projections are filtered.** The host's session-list exits are wrapped so retired members stop
  appearing in the top subagent picker and the built-in team panel. No host source is modified and the
  Web app is not rebuilt.
- **The shipped budget is credited.** While a spawn runs, the legacy roster's effective `maxMembers` is
  raised by the number of retired members of that Lead, so one retirement buys back one slot.

The bundle also enables the shipped `compaction-basic` row, which this profile ships disabled.

## Model-facing only

The plugin has no browser half: no Settings page, no HTTP route, no client bundle. Everything it offers
is a tool the model calls, and `list_members` is the control surface — it reports members this plugin
spawned, members the shipped team roster created, and every child spawned with the shipped `subagent`
or `subagent_fork` tool, each with its child session id. `message_member`, `stop_member` and
`retire_member` address any row it returns. A one-shot `subagent` child cannot be cold-resumed, so
message it while it is resident; it can always be stopped or retired.

The Settings panel was a real browser half and shipped in v0.3, but it was never rendered in a real
profile and the owner reported that its clicks did not work. In v0.4 it and its bridge were removed
rather than repaired, and the effort moved into the model-facing surface above (ADR 0008).

## Retirement is not deletion

| Step | Behaviour |
|---|---|
| Stop | The child is drained; its activation and capacity slot are released. |
| Move | Its persisted session is moved to `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`. Move, not delete: recovery is a directory move back. |
| Tombstone | The roster record becomes `retired`, the name becomes available at the next generation, and the projections stop serving the member. |
| Fallback | If the artifact cannot be moved, the workspace archive hides the Session instead, and the result says so. |
| Restore | `restore_member` moves the artifact back to its recorded original path and clears the tombstone. It refuses when a live member already uses the target. |

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
node --check index.js actions.js roster.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

`--test-isolation=none` matters on Windows: the default runner spawns one process per file, and this
machine's sandbox refuses that spawn. The flag also fixes the Node major: it does not exist in Node 22,
so CI pins Node 24 and the local runner is the same major. Both sides run the same command, so a local
pass means what a green run means.

## Repository layout

| Path | What |
|---|---|
| `index.js` | Host plugin entry, tool definitions, Lead-only authority check |
| `actions.js` | The roster operations behind the model-facing tools |
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
