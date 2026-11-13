# 实验性 Agent Teams 包里缺失的成员生命周期

> Owner: @FrozenYty · Revisit when: 实验性 Agent Teams 包发布了一段能退役的成员生命周期，或者 Team 投影不再把离开终态的转换记成永久失败。

`dsh-team` 存在的意义就是补上这个缺口。本文的写法是为了能直接作为 issue 提交给 `@deepseek-ai/dsh-experimental-agent-team` 与 `@deepseek-ai/dsh-experimental-tool-agent-team`（安装版为 0.2.2-rc.1）。下文每一条主张都在本仓库里按文件与行号引用（github.com/FrozenYty/dsh-team）；引用里的 Harness 事实读自已安装的构建，而本仓库自己的生命周期写在 `docs/member-lifecycle-zh.md`。

## 1. 官方花名册能做什么

- 花名册是 Lead 会话只追加事件日志（`team/member`）的一次折叠（`docs/adr/0001-own-roster-on-subagents.md:12`）。
- 成员相态是封闭的：`provisioning | active | failed`。`applyCurrentTeamEvent` 对任何离开终态的转换都会抛错，而 `applyProjectionEvent` 把这次抛错记成永久 `state.failure`，此后该 Lead 的每一次 Team 读取与变更都会抛错（`docs/adr/0001-own-roster-on-subagents.md:13-16`）。
- 成员名额是 `maxMembers`（16），而它比对的是一个永不收缩的列表；名字永不复用（`docs/adr/0001-own-roster-on-subagents.md:17-18`）。上游进行中的重构依旧写着“名字是永久的”，并把删除操作称作“一个更晚的产品决定”（`docs/adr/0001-own-roster-on-subagents.md:19-20`）。
- 没有完成通知：后代的 `activity` 只有 `running | inactive`，而 `inactive` 同时也覆盖从未启动过的子代理（`docs/architecture-zh.md` §7）。

## 2. 为什么这个缺口无法从外部补上

伪造一条“已退役”事件不是安全的绕法：投影会把这次转换的抛错记成永久失败，从而使该 Lead 的 Team 服务失效（`docs/adr/0001-own-roster-on-subagents.md:13-16`）。插件也无法追加一种新的事件类型（`docs/adr/0001-own-roster-on-subagents.md:49-50`），所以唯一可实现的答案是把花名册放在会话日志之外。这个失败态的代价在本插件里已经看得见：成员关系读不出来时，一个活着的根智能体会被当作 Lead 接受，好让那些工具——包括那个用来修复团队的退役——仍然可调用（`index.js:107-122`）。

平台也从不删除任何东西，所以一个成员的会话会比它在花名册里的位置活得更久：

- `ctx.sessionPersistence` 只有 `create`、`open`、`flush`、`stat` 与 `list`；安装版 JSONL 后端直说这条 seam 没有删除 API（`docs/adr/0011-trash-retention.md:18-21`）。
- `sessionController` 同样没有删除：`list`、`search`、`create`、`fork`、`rename`、`cancel`、`state`、`events`、`projections`、`follow`（`docs/adr/0011-trash-retention.md:22-23`）。
- 官方唯一“把会话挪开”的机制是可逆的 `workspaceRegistry.archiveSession` / `unarchiveSession` 标记；平台自己从不删除会话字节（`docs/adr/0011-trash-retention.md:24-26`）。

于是一个无法收缩的花名册会一直占用名额、一直占着名字，并把它持有过的每一个会话留在磁盘上。

## 3. 本插件绕过了什么，以及怎么绕的

`dsh-team` 不扩展官方投影。它在 Harness 的子代理底座上自建花名册，从不写会话事件，持久状态放在 `storageDomain` 域里（`docs/adr/0001-own-roster-on-subagents.md:34-39`；`docs/architecture-zh.md` §4）。它绕出来的就是官方花名册没有的那段生命周期：

- **一个自有的 `retired` 相态。** 退役是一套协议而不是删除：记下原因、排空子代理、给记录立碑、把持久化会话移进插件掌控的回收站、确认这次移动、执行上限、把成员从投影出口隐藏，并报告发生了什么（`docs/member-lifecycle-zh.md` §3）。
- **是移动，不是抹除。** 会话被移到 `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`，恢复就是把目录移回去（`docs/member-lifecycle-zh.md` §4）。因为平台没有删除 API，保留上限只删插件自己移进回收站的那份副本（`docs/adr/0011-trash-retention.md:28-30, 44-52`）。
- **可复用的名字。** 代次 1 是裸基名，代次 2 起是 `<base>-g<N>`，因此继任者复用的是名字，而不是撞上一个被永久占用的名字（`docs/roster-storage-zh.md` §1）。
- **有交接书的继任者，以及它接手的工作。** 替换会依据前任的记录合成一份交接书来启动继任者，并在同一次调用里把前任的未完成任务交出去；而一次没有继任者的退役会让这些任务变为无主，并把它们点名（`docs/task-board-zh.md` §2）。任务板归插件自己所有，因为官方任务板属于官方花名册（`docs/adr/0017-own-task-board.md:9-13, 44-48`）。
- **它自己的模型侧接口。** 插件提供 `spawn_member`、`list_members`、`message_member`、`stop_member`、`retire_member`、`restore_member`、`compact_member`、`handoff_template` 与 `task_board`，而 v0.14.0 禁用了官方那条原本提供同类工具集的 `tool-agent-team` 行（`cordis.patch.yml:28-44`）。

有两条限制是“绕行而非修复”本身带来的：官方 catalog 仍然知道这个成员存在过，因为平台从不删除它自己拥有的东西（`docs/architecture-zh.md` §8）；而官方 catalog 仍然会和本插件的并列显示，因为回答 `list_agents` 的那项 `agent-team` 服务为了收养与投影过滤而保持挂载。v0.14.0 退役的是官方**工具**行，移掉的是它发布的 spawn、等待与任务工具，而不是那项服务（`cordis.patch.yml:28-44`）。

## 4. 一次改名必须冻结什么

插件在 v0.10.0 改名为 `dsh-team`，而有四个标识符刻意没有跟着包名走：存储域 `team_roster`、补丁行 id `team-roster`、数据目录 `~/.dsh/team-roster`，以及环境变量 `DSH_TEAM_ROSTER_DATA_DIR`（`docs/adr/0014-plugin-name.md:35-50`）。已存的记录、记录在案的回收站路径与 profile 覆盖都住在这些名字里，而它们没有任何“改名并迁移”的原语：改动其中任何一个，都会静默地让一份花名册变成孤儿、让回收站藏起来，或让某个 profile 的覆盖不再匹配（`docs/adr/0014-plugin-name.md:41-49`；重访条件在 `:96-98`）。上游任何一次改名——相态、已存键或配置行——都继承同一条规则。

## 5. 什么情况下这个绕行可以退场

很短，而且每一条都是替第 3 节里的某一项退场，而不是在要求本插件换设计：

- 接受一个显式的成员已退役转换，或者一个投影不会记成永久失败的终态，这样花名册不必住在会话日志之外也能收缩。
- 给 `maxMembers` 一个会收缩的列表，并给名字一个代次或复用的概念。
- 提供一个会话删除 API，或者明确规定“把会话移出存储”是受支持的；插件的回收站移动今天正是在替这份契约站岗（`docs/adr/0011-trash-retention.md:18-26`）。
- 发出一个成员状态或完成事件，把“从未启动”和“已完成”区分开；今天清扫之所以需要插件自己的 `startedAt`，正是因为 `inactive` 把两者都盖住了（`docs/member-lifecycle-zh.md` §2）。
- 像 ADR 0014 那样把已存标识符的升级规则写下来，让一次改名有迁移路径，而不是只剩一个被冻结的名字。
