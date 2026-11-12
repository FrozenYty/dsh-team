# Upgrading

> Owner: @FrozenYty · Revisit when: a released version removes or renames a tool, a config key or a stored
> identifier

What a profile made for an earlier version has to change, and what carries over untouched. This is
reference material for the moment you upgrade, which is why it is not in the changelog: a release entry
says what a version contained, and this says what to do about it.

## 1. What v0.14.0 removed, and what replaces it

v0.14.0 disabled the shipped `tool-agent-team` row, so a profile that used it loses the tools below.
v0.13.0's roster and board are otherwise unchanged: the storage domain, the patch row id, the trash
directory, the pre-rename environment variable and the record shape all carry over, so upgrading needs
no migration (ADR 0014).

| Removed in v0.14.0 | Call instead |
|---|---|
| `spawn_teammate` | `spawn_member`; `spawn_member` with `replace` starts the successor and retires the predecessor in one call. |
| `wait_agent` | `wait_members` (v0.15.0): a bounded wait on the members' live status. It does not wake anyone, and answers `no_progress` at once when no member is running or provisioning. |
| `team_task_create` | `task_board` with `action: "create"`. |
| `team_task_list` | `task_board` with `action: "list"`. |
| `team_task_get` | `task_board` with `action: "list"`, then read the row by id. |
| `team_task_update` | `task_board` with `action: "update"` (status and owner), `"release"` (clear the owner) or `"delete"`. Dependency, priority and comment edits have no replacement: the owned board has none of those fields (ADR 0017). |

## 2. What carries over, and what does not

The shipped board's rows are not migrated and not readable from this plugin. A Lead that kept work there
re-creates it with `task_board`, which is a couple of `create` calls rather than a migration.

The shipped `list_agents`, `send_message` and `interrupt_agent` are **not** among the removed tools: the
`agent-team` service row publishes them and stays mounted.

Four identifiers kept their pre-rename spelling on purpose, and a profile may be addressing them today: the
storage domain `team_roster`, the patch row id `team-roster`, the data directory `~/.dsh/team-roster`, and
the environment variable `DSH_TEAM_ROSTER_DATA_DIR` (`DSH_TEAM_DATA_DIR` is the current spelling and both
work). Renaming any of them orphans stored state or silently stops a profile's override from matching
(ADR 0014) — read that ADR before "finishing" the rename.
