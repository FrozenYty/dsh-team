# dsh-team-roster

[中文](README-zh.md)

A DeepSeek Harness plugin that gives an agent team the lifecycle the shipped one lacks: members you can
retire, remove and replace — with a recoverable session trash, a roster that survives the removal, and
context tooling for long-running teammates.

**Status**: the v0.3 tools are installed and verified in the author's profile. The Settings panel is
written and unit-tested, but has not been installed or rendered yet — P3-04 in [PLAN.md](PLAN.md).
Recent changes are in [PROGRESS.md](PROGRESS.md).

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
| `restore_member` | Bring a retired member back: move its trashed Session to the recorded original path and return the record to active. |
| `compact_member` | Force one compaction on a resident, idle member. |

Plus two host-side effects, applied for every retirement:

- **Projections are filtered.** The host's session-list exits are wrapped so retired members stop
  appearing in the top subagent picker and the built-in team panel. No host source is modified and the
  Web app is not rebuilt.
- **The shipped budget is credited.** While a spawn runs, the legacy roster's effective `maxMembers` is
  raised by the number of retired members of that Lead, so one retirement buys back one slot.

The bundle also enables the shipped `compaction-basic` row, which this profile ships disabled.

## Settings panel

The bundle ships a Settings page (Settings → **Team roster**) as its browser half (`client.js`,
registered into the `settings.section` slot) over a loopback-only JSON bridge on the Host web server
(`routes.js`).

**The panel is per session.** The durable store already keys one roster per Lead Session, so the page shows
exactly one of them:

- It opens on the session you are in. That session is resolved in the browser from the shell's own session
  catalog (`useSessions`), whose rows carry `retainedBy.mainView` — the shell's own "this session is open"
  count — and `displayTitle`. The page shows the title when there is one and the short id otherwise. No
  session data travels over the bridge.
- A **picker** lists the sessions that have a roster, with member counts and whether their Lead is live, so
  you can switch to another one. The session you are in stays an option even when it has no roster yet,
  labelled `no roster yet`.
- A session without a roster says so — *No team roster for this session yet.* — instead of rendering an
  empty page. When the browser has no current-session signal at all, the Host's documented order picks the
  opening session: live Leads first, then the most recently written roster.
- **Refresh**, plus a three-second poll while the page is open, so a change made through a tool reaches
  the panel without a page reload.
- **Retire** behind an inline confirmation, and **Restore** for a retired member. Both call the same
  functions the model tools call (`actions.js`), so parameter meaning, result fields and failure reasons
  cannot drift between the two callers.

The bridge is two reads and two writes: `GET /api/team-roster/sessions` (the counts-only picker index),
`GET /api/team-roster/state?leadSessionId=…` (one roster with its member rows), `POST /api/team-roster/retire`
and `POST /api/team-roster/restore`. It refuses non-loopback callers and cross-origin `Origin` headers,
caps request bodies at 64 KiB, and answers a JSON error with a status. Retiring a member whose Lead Session
is not live is reported as a readable failure, not a stack trace.

Installing the updated bundle is the last step, and it has not been done: activation and the rendered
panel are unverified (PLAN.md P3-04).

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
node --check index.js actions.js routes.js client.js roster.js trash.js host-hooks.js
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
| `actions.js` | The roster operations, shared by the tools and the Settings bridge |
| `routes.js` | `/api/team-roster` bridge: per-session state, the picker index, retire, restore, and the loopback/origin fence |
| `client.js` | Settings panel (browser half) |
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
