# dsh-team-roster

[中文](README-zh.md)

A DeepSeek Harness plugin that gives an agent team the lifecycle the shipped one lacks: members you can
retire, remove and replace — with a recoverable session trash, a roster that survives the removal, and
context tooling for long-running teammates.

**Status**: v0.5 replaces a member with a handoff: one `spawn_member` call with `replace` starts the
successor from a short brief and then retires the predecessor (ADR 0009). v0.4 is model-facing only —
the Settings panel and its loopback HTTP bridge that shipped in v0.3 were removed, because the panel was
never rendered in a real profile and its clicks did not work — and the same effort went into the
model-facing surface, which now covers every subagent an agent spawns (ADR 0008). The lifecycle tools are
installed in the author's profile and were exercised live there at v0.5.0: retirement, restore, message,
stop, and one replacement whose successor read the handoff brief and finished its predecessor's task
(P2-08). v0.7.0 caps the session trash per Lead, so it no longer grows without bound (ADR 0011). v0.8.0
makes that cap a config field of this bundle's patch row — `trashLimit`, default 20, minimum 1, refused
at load when it is out of range — instead of a constant in the code (ADR 0012). The
working tree has changed since that install, so the newest change is covered by the unit tests only; a
fresh install is the owner's decision. Recent changes are in [PROGRESS.md](PROGRESS.md).

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
| `spawn_member` | Start a named member, or replace one: with `replace` the successor starts from a handoff brief and the predecessor is retired in the same call. A successor reuses the base name at the next generation (`reviewer` → `reviewer-g2`) unless the model names it. |
| `list_members` | The roster: target, child session id, phase, generation, the assignment recorded for the member, live state, and — while resident — context pressure and `compactable`. Adopts members the shipped roster created **and** children spawned with the shipped `subagent` / `subagent_fork` tools, so every subagent the model controls is listed and retirable. |
| `message_member` | Deliver one message to a live member, and optionally replace the assignment recorded for it; an unloaded member is cold-resumed from its own Session. |
| `stop_member` | Cancel only the current turn; the activation and inbox are kept. |
| `retire_member` | Drain, tombstone, move the Session artifact to a recoverable trash directory, and record whether the workspace archive hid it instead. The trash keeps a configurable number of artifacts per Lead — 20 unless the profile sets `trashLimit` — so a retirement that moves one in removes the oldest past that cap and reports `pruned`. Retiring an already-retired member is a no-op that says so. |
| `restore_member` | Bring a retired member back: move its trashed Session to the recorded original path and return the record to active. The result says which branch ran, and a restore with nothing to invert is a no-op rather than an error. A member whose artifact the retention cap already removed answers `reason: "pruned"` and stays retired. |
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

## Retirement is a move, not a deletion — and the trash is capped

| Step | Behaviour |
|---|---|
| Stop | The child is drained; its activation and capacity slot are released. |
| Move | Its persisted session is moved to `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`. Move, not delete: recovery is a directory move back. |
| Tombstone | The roster record becomes `retired`, the name becomes available at the next generation, and the projections stop serving the member. Retiring it again is a no-op that says so. |
| Fallback | If the artifact cannot be moved, the workspace archive hides the Session instead, and the result says so. |
| Retention | One Lead's trash keeps at most the **effective cap** — 20 by default, or the profile's `trashLimit` — artifacts. A retirement that moves one in removes the oldest entries past the cap in the same call and reports the count in `pruned`; nothing is swept on a timer or on a read. |
| Pruned | A pruned tombstone keeps its `trashPath` (it still says where the artifact went) and its `trashState` becomes `pruned`. Its bytes are gone, so `restore_member` refuses with `reason: 'pruned'`. |
| Restore | `restore_member` moves the artifact back to its recorded original path and clears the tombstone. It refuses when a live member already uses the target. |

The cap exists because the platform has no Session-deletion API: `sessionPersistence` is append-only
(`create`, `open`, `flush`, `stat`, `list`) and the only official "hide it" mechanism is the reversible
`workspaceRegistry` archive. So the plugin deletes only the copies it moved into its own trash, and it
says so in the result (ADR 0011).

## Replacing a member hands over its work

`spawn_member` with `replace: <target>` is the whole replacement. The successor starts from a short brief
that names the predecessor, repeats the assignment recorded for it, says the predecessor is retired and
gone, and points at the shared team task board under the predecessor's name — the board itself is not
copied. The successor inherits that assignment unless the model records a new one.

- **The successor starts first; the predecessor is retired second**, in the same call. A start that fails
  leaves the predecessor untouched and says so; a retirement that fails returns the successor with
  `predecessor_retired: false`, so one more `retire_member` recovers it (ADR 0009).
- **The assignment is durable and capped.** `spawn_member.assignment` sets it at spawn, up to 1000
  characters, and `message_member.assignment` replaces it when the work changes. `list_members` reports
  it, and it stays on the tombstone after retirement.
- A target that is already retired is accepted, and its tombstone supplies the brief.

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
- `spawn_member` with `replace` returns `predecessor_retired: true` and a successor at the next
  generation;
- `include:compaction-basic` reports status `schema` (not `inactive`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DSH_TEAM_ROSTER_DATA_DIR` | `~/.dsh/team-roster` | Trash root and roster data directory. |

The roster itself lives in a `storageDomain` domain (ADR 0003), not in a Session log.

### Trash retention cap

One Lead's trash keeps at most **20** artifacts unless the profile says otherwise. The cap is a config
field of this bundle's own patch row, so changing it is a profile edit, not an edit of this repository:

```yaml
# the profile's cordis.patch.yml
- id: team-roster
  config:
    trashLimit: 7
```

The field must be an integer with a **minimum of 1**. `0`, a negative number, a fraction, a numeric
string, `NaN` and an explicitly-null value are all refused rather than clamped, and the refusal happens
**when the profile loads** — before any tool is registered and long before the first retirement. The
message names the field, the value it saw and the minimum:

```
dsh-team-roster: config field "trashLimit" must be an integer >= 1 (minimum 1); received 0
```

A retirement that moves an artifact in enforces the effective cap and its result says which number was
applied, so what an operator reads is what was in force. Omitting `trashLimit` keeps the documented
default of 20, so a profile that configures nothing behaves exactly as it did in v0.7.0 (ADR 0012).

This entry still declares no `Config` **schema**, so the Host Config provider reports
`include:team-roster` as `absent`. That describes the schema projection, not configurability: the field
is read and validated at load and enforced by the retirement. The reason is recorded in ADR 0012 — the
Config provider and the profile schema generator both accept only a native Schemastery schema, and a
zero-import bundle (ADR 0002) cannot import one.

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
| `trash.js` | Session-artifact recovery directory and the per-Lead retention cap |
| `host-hooks.js` | Projection filter and roster slot credit |
| `tests/` | `node:test` unit tests |
| `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg` | the bundle |
| `PLAN.md`, `PROGRESS.md` | tasks, and the append-only change log |
| `docs/` | design documents (bilingual) and ADRs |

## Contributing

Read [AGENTS.md](AGENTS.md) if you are an AI assistant, and [CONTRIBUTING.md](CONTRIBUTING.md) for
branches, commits and what CI enforces.
