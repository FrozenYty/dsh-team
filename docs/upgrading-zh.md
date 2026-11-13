# 升级

> Owner: @FrozenYty · Revisit when: 某个已发布版本移除或改名了工具、配置键或已存标识符

为更早版本配置好的 profile 需要改什么，以及哪些东西原样沿用。这是升级那一刻要查的资料，所以它不在变更日志里：发布条目说的是那一版包含什么，这里说的是你该怎么做。

## 1. v0.14.0 移除了什么，改用什么

v0.14.0 禁用了官方的 `tool-agent-team` 行，因此用过它的 profile 会失去下表中的工具。v0.13.0 的花名册与任务板其余部分不变：存储域、补丁行 id、回收站目录、改名前的环境变量以及记录形状都照旧，所以升级不需要迁移（ADR 0014）。

| v0.14.0 移除的工具 | 改用什么 |
|---|---|
| `spawn_teammate` | `spawn_member`；带 `replace` 的 `spawn_member` 会在同一次调用里启动继任者并退役前任。 |
| `wait_agent` | `wait_members`（v0.15.0）：对成员的实时状态做有界等待。它不唤醒任何人，且在没有成员处于 running 或 provisioning 时立刻回答 `no_progress`。 |
| `team_task_create` | `task_board` 配 `action: "create"`。 |
| `team_task_list` | `task_board` 配 `action: "list"`。 |
| `team_task_get` | `task_board` 配 `action: "list"`，再按 id 读那一行。 |
| `team_task_update` | `task_board` 配 `action: "update"`（状态与 owner）、`"release"`（清空 owner）或 `"delete"`。依赖、优先级与评论的编辑没有替代：自有任务板没有这些字段（ADR 0017）。 |

## 2. 什么照旧，什么不照旧

官方任务板上的行不会迁移，本插件也读不到。把工作留在那里的 Lead 用 `task_board` 重新创建即可，那只是几次 `create` 调用，不是一次迁移。

官方的 `list_agents`、`send_message` 与 `interrupt_agent` **不在**被移除之列：它们由 `agent-team` 服务行发布，而那一行保持挂载。

有四个标识符刻意保留了改名前的拼写，而某个 profile 今天可能正按它们寻址：存储域 `team_roster`、补丁行 id `team-roster`、数据目录 `~/.dsh/team-roster`，以及环境变量 `DSH_TEAM_ROSTER_DATA_DIR`（现在的拼写是 `DSH_TEAM_DATA_DIR`，两者都有效）。改动其中任何一个，都会让已存状态变成孤儿，或让 profile 的覆盖静默失配（ADR 0014）——在“完成”这次改名之前先读那份 ADR。
