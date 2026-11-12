# dsh-team

[English](README.md)

> 只是换人，不是换活。

一个 DeepSeek Harness 的 profile bundle，专补官方智能体花名册做不到的那件事：让成员离场。Lead 可以退役成员、从自己掌控的回收站把它恢复回来，也可以换成一位继任者——继任者接手 assignment、当时正在推进的工作，以及指向 Lead 自有任务板的指针。花名册归本插件所有，没有浏览器半区。

[github.com/FrozenYty/dsh-team](https://github.com/FrozenYty/dsh-team)

## 插件是什么

一个 Host 插件加一条 bundle 补丁：补丁插入 `dsh-team`，启用官方默认关闭的 `compaction-basic` 行，并禁用官方的 `tool-agent-team` 行；插件不导入任何 Harness 包、不写会话事件，状态存放在以 Lead 会话 id 为键的 `storageDomain` 域里（ADR 0003）。官方的团队**服务**行（`agent-team`）保持挂载，因为收养与投影过滤都要读它。名称在 v0.10.0 改过；存储域、补丁行 id 与回收站目录刻意没有跟着改（ADR 0014）。

## 状态

- 当前版本：v0.14.0。
- **在作者本机 profile（已安装本 bundle）上实测**：退役、恢复、发消息、停止，以及一次替换——继任者完成了前任的任务（v0.5.0、v0.6.0）；回收站上限（v0.7.0）与可配置上限（v0.8.0），配置值生效、越界值在加载时被拒绝；临时成员清扫（v0.9.0）——两个临时成员跑完后，下一次 `list_members` 返回 `swept: 2` 与两个目标，两行都变为 `retired`；交接书模板（v0.11.0）——存下的模板带唯一标记，继任者原样复述整段初始消息（标记与代入后的字段都在），未知占位符被点名拒绝，不含 `{assignment}` 的模板被拒绝并给出理由，清除后回到内置交接书；`spawn_options`（v0.12.0）——成员在转发的 `cwd` 中启动并报回该目录，合法的 `agent_preset` 可以运行，未知 preset id 返回 `started: false` 与 `reason: preset-not-found` 并列出已声明的 id，换一个模型 id 可以运行并回复，不带选项的 spawn 不携带 `started_with`；任务板（v0.13.2）——任务被创建并由成员持有，带 `replace` 的 `spawn_member` 返回 `transferred: 1` 与任务 id、且前任已退役，继任者的交接书点出该 id 与标题，不带继任者的 `retire_member` 返回 `unowned: 1` 与 id。
- **只有真机安装才能暴露的两次失败**，各一行；两次都在出问题的那个版本内修复，现在各由一项检查或测试覆盖：v0.12.0 的 bundle 安装后无法激活，直到去掉一个 schema 关键字（同版本；现在 `scripts/check.mjs` 会拒绝该关键字）；v0.13.0 的替换返回了宿主拒绝的结果，直到 v0.13.2 声明了这些字段（现在 `tests/entry.test.mjs` 会用每个工具自己声明的输出 schema 校验每个回答）。
- **仅由单元测试覆盖**，没有真机 profile 跑过：`label` 与 `assignment` 写入时的长度上限；spawn 尚在进行时发起退役；两个花名册操作重叠时的丢失更新保护；“仍在运行的成员永不被清扫”；不带 `spawn_options` 的 spawn 拼出的精确 request；任务板写入时的上限，以及真机没走到的交接矩阵格子；还有从 v0.14.0 起的工具面本身——官方花名册工具是否真的从 Lead 的工具列表里消失、这九个工具是否顶替了它们，这需要所有者安装后用 `listTools` 验证。
- 安装进 profile 有真实副作用，是否安装由所有者决定。
- 完整历史（只追加）：[PROGRESS.md](PROGRESS.md)。

## 为什么需要它

官方实验性 Agent Teams 的花名册无法真正让成员离场。它由 Lead 会话的只追加事件日志折叠而来，成员相态封闭为 `provisioning | active | failed`：投影对任何离开终态的转换都会抛错，并把这次抛错记为永久失败，此后该 Lead 的每一次 Team 读取和变更都会抛错——伪造一条“已退役”记录不是安全失败，而是彻底毒化该会话的投影（ADR 0001）。`maxMembers`（16）检查的是一个只增不减的列表；名字永不复用；整套契约里没有删除；上游进行中的重构依旧把删除推后。另外，这个 profile 出厂关掉了压缩后端。

本插件补上缺的那一半，不 fork 官方花名册：在 Harness 子代理底座上维护自己的花名册，有真正的 `retired` 相态、下一代可复用的名字，以及一个“移动而非删除”的会话回收站。

## 能做什么

| 工具 | 行为 |
|---|---|
| `spawn_member` | 把成员作为一个可续跑的子代理启动，可通过 `spawn_options` 给它自己的工作目录、模型路由或 agent preset；带 `replace` 时从交接书启动继任者，并在同一次调用里退役前任；带 `ephemeral` 时标记为一次性成员，之后由清扫在它跑完并停下后退役。 |
| `list_members` | 该 Lead 控制的全部成员与子代理：本插件的花名册、官方花名册创建的成员，以及用官方 `subagent`／`subagent_fork` 工具启动的每个子代理。每行带回 target、子会话 id、相态、代次、label、记录在案的 assignment、一次性成员上的 `ephemeral`、实时状态、`compactable`，驻留时还有上下文压力。 |
| `message_member` | 向活着的成员投递一条消息，并可顺带替换记录在案的 assignment；已卸载的可续跑成员会从自己的会话冷恢复，一次性子代理不能。 |
| `stop_member` | 取消成员当前这一轮；激活与收件箱保留，稍后再发消息即可继续。 |
| `retire_member` | 排空、立碑、把持久化会话移进回收站（移不动时改由工作区归档隐藏），再执行保留上限。对已退役成员重复调用是无操作，并会说明这一点。 |
| `restore_member` | 把回收站里的会话移回记录的原始路径，记录转回 `active`；产物已被剪除时给出带类型的拒绝。 |
| `compact_member` | 对驻留且空闲的成员强制压缩一次，返回 `done`、`busy`、`not-resident`、`nothing-to-compact` 或 `failed`。 |
| `handoff_template` | 读取、设置或清除继任者收到的交接书：不传 `template` 即读取已存的那份，传入模板即保存，传空串则回到内置版本。 |
| `task_board` | 该 Lead 自有的工作板：用 `action` 选择 `create`、`list`、`update`、`release` 或 `delete`。一条任务有 id、标题、`open` 或 `done`，以及可选的成员 `owner`；未完成的任务会随替换一起过去。 |

**成员可以换个目录、换个模型、少几件工具。** `spawn_member.spawn_options` 转发 Harness 本就支持的三个字段，任何一个省略都继承 Lead 的值——只有一个例外：改了 `provider` 或 `model` 却没给 `reasoning_effort` 时，新路由解析自己的默认值。`cwd` 用于单独的检出或 worktree（相对路径按 Lead 的目录解析，子代理保留 Lead 的权限根，因此沙箱授权之外的目录仍会被拒绝）；`agent_options` 携带 `provider`、`model`、`reasoning_effort` 与 `max_tokens`，最后一项是 token 上限，也是挑更便宜模型的地方；`agent_preset` 用于更窄的工具集——preset 是获得只读成员的**唯一**途径，因为 Harness 没有按次调用的工具白/黑名单，而 preset id 来自 profile 的 bundle 补丁，不是某个目录路径。`started_with` 是插件转发内容的回执，不是子代理解析结果的确认：它原样回显传入的字段，既不解析也不回读，所以模型有没有真正生效，要靠成员的第一条请求去确认，而不是这个字段。Harness 拒绝的启动会返回 `started: false`、原因与出路；陈旧 target 的拒绝会带 `current_holder` 指出该名字现在的活持有者，于是换过人的 Lead 可以直接改投新名字。

每次退役都会产生两个宿主侧效果，二者都带能力探测：宿主会话列表出口会从 `subagentCatalog` 与 `agentTeam` 帧中剔除已退役 id，于是顶部子代理选择器和内置团队面板不再渲染该成员（不改宿主源码，不重建 Web 应用）；spawn 期间，官方花名册的有效 `maxMembers` 按该 Lead 的退役数临时抬高，于是退役一个就还回一个名额。另外，补丁把官方 `compaction-basic` 行以 `disabled: false` 启用，自动压缩因此覆盖进程内所有智能体，子代理也包括在内。

## 用起来是什么样

插件没有界面：你用日常语言告诉模型要做什么，由模型调用这些工具，花名册就是这样靠对话管理的。本 README 里的每一项操作，都是模型替你发起的工具调用，而不是你去操作的面板。下面是一次真实交互：一个成员带着 assignment 启动，并被要求待命，随后被替换。

```
> 把这个求和交给一个帮手，让它先待命。
spawn_member { name: "handoff-probe", label: …, prompt: …,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else." }
← target: "handoff-probe", generation: 1, phase: "active",
  assignment: "Compute 6 * 7 and reply with the single number, nothing else.", …

> 我用不上它了。换个继任者接过去，并把它退役。
spawn_member { replace: "handoff-probe", label: …, prompt: … }
← target: "handoff-probe-g2", generation: 2, replaced: "handoff-probe",
  predecessor_retired: true,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else.",
  message: "Successor handoff-probe-g2 started from the handoff brief and the predecessor "handoff-probe" is retired. …"

handoff-probe-g2（从未见过前任）回复：42
```

这段对话节选自 [PROGRESS.md](PROGRESS.md) 中记录的一次验收运行。

## 生命周期

| 步骤 | 行为 |
|---|---|
| 停止 | `retire_member` 排空子代理：它的这一轮结束，激活与容量名额随之释放。 |
| 移动 | 持久化会话被移到 `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`，原始路径与产物类型记在记录上。恢复就是把目录移回去。该目录沿用改名前的位置，因为记录在案的每个 `trashPath` 都在它下面（ADR 0014）。 |
| 立碑 | 记录转为 `retired`，保留 assignment 与各条路径；之后可以启动该名字的下一代。投影不再下发该成员，再次退役是无操作，并会说明这一点。 |
| 归档兜底 | 产物移不动时，改由工作区归档隐藏该会话，记录与返回结果都会说明（`archived: true`）。 |
| 保留上限 | 成功移入产物的那次退役，会在同一次调用里删掉超出该 Lead 生效上限的最旧条目，并在 `pruned` 里报告数量；上限只在那里执行——没有定时器，读取时也不为它清理。平台没有会话删除 API，所以插件只删自己回收站里的副本（ADR 0011）；上限本身与越界拒绝见下面的配置一节。 |
| 已剪除 | 被剪除的墓碑保留 `trashPath`（仍记录产物去了哪里），`trashState` 变为 `pruned`。字节已经不在，因此 `restore_member` 以 `reason: "pruned"` 拒绝，且绝不调用工作区。 |
| 恢复 | `restore_member` 把产物移回记录的原始路径并清除墓碑；已有活成员占用目标时拒绝，返回结果会说明实际走的是哪条分支。 |

## 替换成员

`spawn_member` 加 `replace: <target>` 就是完整的一次替换。继任者的提示词由前任的记录拼成：继任者自己的名字、前任的 target 与 label、记录在案的 assignment、前任已离场这一事实，以及按 id 与标题列出的前任未完成任务。除非模型重新记录，继任者继承该 assignment。

**退役会对工作做什么。** 工作不是一句话：从 v0.13.0 起，它是本插件自有任务板上的行，而这两个生命周期事件正是围绕它们展开的。替换会在退役前任的同一次调用里，把前任所有未完成任务转给继任者，并在继任者的交接书里点名——于是继任者拿到的是自己现在拥有的 id，而不是指向别人任务板的指针。相反，**没有**继任者的退役会让这些行保持 `open` 且无人认领，并用 `unowned` 连同 id 报告出来，因为工作依然欠着，只是现在没有人扛；`task_board` 的 `action: list` 会报告同一批任务，恢复则说明其中有多少还在等待认领。`done` 任务永不移动：已完成的工作留在完成它的那条记录上，而让任务不再被继承的，是 `task_board` 的 `action: update, status: done`。

- **先启动继任者，再退役前任，都在同一次调用里。** 启动失败时前任原封不动，失败的预留会记成继任者的 `failed` 记录；退役失败则返回 `predecessor_retired: false`，再调一次 `retire_member` 即可收尾（ADR 0009）。目标已经退役时同样接受，由墓碑提供交接书。
- **assignment 是持久字段，且有长度上限。** `spawn_member.assignment` 在启动时写入，`message_member.assignment` 在工作变化时替换，两者都限制在 1000 个字符以内，超长直接拒绝而不是截断；`list_members` 会报告它，墓碑也会保留它。
- **交接书的形状可以每个 Lead 固定一次。** `handoff_template` 存下的模板会代入 `{successor}`、`{predecessor}`、`{label}`、`{assignment}` 与 `{task_board}`。没有引用 `{assignment}` 的模板在保存时就被拒绝——继任者若不知道接手的是什么，就不算完成交接；未知占位符同样在保存时被拒绝，而不是原样写进子代理的提示词。内置交接书就是默认模板、由同一套渲染代码生成，因此没有存过模板的 Lead 得到的字句和以前完全一样，清除模板即回到它（ADR 0015）。

## 临时成员

`spawn_member` 带 `ephemeral: true` 会把成员标记为一次性成员，`list_members` 会在该行报告 `ephemeral: true`；缺省为 `false`。插件收不到完成事件，所以负责退役这类成员的清扫只在 `list_members` 与 `spawn_member` 调用开始时运行，并且只退役它有确凿证据表明“跑过且已停下”的成员：从未启动过的不会被清扫，仍在运行的也不会。被清扫的成员走的是普通退役流程，因此墓碑仍然列出，名额也照常返还。触发清扫的那次调用会报告 `swept` 与 `swept_targets`，一个都没退役时不加任何字段。

给一次性成员发消息会清除该标记：再次给它派活，就是声明它不再是一次性的；没有这条规则，清扫就可能吃掉刚刚送达的消息所要保留的工作。

## 安装与验证

```
plugin_manager  install_bundle  target: <本仓库的绝对路径>
```

安装是把本目录链接进 profile，而不是复制，所以真正运行的就是这棵工作树——没有构建步骤。安装后的验证靠实际调用，而不是 `check.mjs` 的结果：

- 补丁行以 `application: applied` 激活，没有告警；
- 在 Lead 会话里可以调用 `list_members`，驻留成员带上下文压力；
- 对有产物的会话，`retire_member` 返回 `trashed: true` 与 `trash_path`；
- `spawn_member` 带 `replace` 时返回 `predecessor_retired: true`，且继任者处于下一代次；当前任有未完成任务时，结果还会用 `transferred` 报告数量与 id，继任者的交接书里也会点名它们；
- `spawn_member` 带 `spawn_options` 时，返回的 `started_with` 与传入内容逐字段一致；若 profile 的 provider 或 preset 注册表拒绝，则返回 `started: false` 与 `reason`；
- Lead 的工具列表里有本插件的工具，而没有 `spawn_teammate`、`send_message`、`list_agents`、`interrupt_agent`、`wait_agent` 或官方的 `team_task_*` 工具；
- `include:compaction-basic` 的状态是 `schema`，而不是 `inactive`。

## 配置

插件的数据目录是 `~/.dsh/team-roster`，可用 `DSH_TEAM_DATA_DIR` 覆盖（改名前的 `DSH_TEAM_ROSTER_DATA_DIR` 仍然可用，ADR 0014）；其 `trash/` 存退役会话，花名册本身则放在 `storageDomain` 域里（ADR 0003）。

每个 Lead 的回收站最多保留 **20** 份退役会话。这个上限是 bundle 补丁行上的 `trashLimit` 字段，所以改它是改 profile 自己的 `cordis.patch.yml`，按 id 匹配：

```yaml
- id: team-roster
  config:
    trashLimit: 7
```

这个 `id` 冻结为 `team-roster`，而包名是 `dsh-team`：profile 正是按它定位这一行，改名会让覆盖静默失配（ADR 0014）。

该字段必须是不小于 1 的整数；`0`、负数、小数、数字字符串、`NaN` 以及显式写的 `null` 都会被拒绝，而不是被截断取整，拒绝发生在加载时、任何工具注册之前。报错原文是 `dsh-team: config field "trashLimit" must be an integer >= 1 (minimum 1); received 0`。成功移入产物的那次退役按解析出的生效上限执行；省略该字段就保持默认值 20。

入口仍然不声明 `Config` **schema**，所以提供方把 `include:dsh-team` 报为 `absent`：这是 schema 投影层面的说法，不代表不可配置——字段在 `apply` 里被校验。只有原生 Schemastery schema 才会被投影，而零导入的 bundle（ADR 0002）无法导入它（ADR 0012）。

## 只面向模型

没有浏览器半区、没有 HTTP 桥、没有客户端 bundle；v0.3 的设置页面板从未真正渲染，实际也点不动，因此选择移除而不是修复（ADR 0008）。`list_members` 就是控制面：它覆盖官方花名册的成员，以及用官方 `subagent` 工具启动的每个子代理，其余六个工具可以寻址它返回的任意一行。

补丁禁用了官方的团队工具行（P2-07），所以 Lead 的工具列表就是本插件自有的九个工具：`spawn_teammate`、`send_message`、`list_agents`、`interrupt_agent`、`wait_agent` 与官方的 `team_task_*` 工具都已不在。它们各自在这里有对应物——`spawn_member`、`message_member`、`list_members`、`stop_member` 与 `task_board`——只有 `wait_agent` 没有：本插件没有阻塞式等待，所以 Lead 改为重读 `list_members` 看实时状态、用 `message_member` 唤醒需要的成员，并把 `inactive` 读作“当前没有轮次在执行”，而不是“已完成”。官方花名册的**服务**仍然挂载（`agent-team` 行），因此 `list_members` 依旧报出它创建的成员；消失的只是它的工具。

## 开发

```sh
node --check index.js actions.js roster.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

`--test-isolation=none` 在 Windows 上是必需的：默认 runner 会为每个文件起一个进程，而沙箱拒绝这种 spawn；这个 flag 同时固定了 Node 大版本，CI 也钉在 24。两边跑同一条命令，所以本机通过的含义与 CI 通过相同。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `index.js` | Host 插件入口：工具定义、参数校验、Lead 专属权限检查 |
| `actions.js` | 模型侧工具背后的花名册操作 |
| `roster.js`、`trash.js` | 持久花名册（相态、代次命名、收养、迁移），以及带恢复与保留上限的会话回收站 |
| `host-hooks.js` | 投影过滤与花名册名额补偿 |
| `tests/`、`scripts/check.mjs` | 单元测试，以及 CI 会跑的仓库检查 |
| `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg`、`.github/` | bundle 本体、CI workflow 与模板 |
| `PLAN.md`、`PROGRESS.md`、`docs/` | 待办任务、只追加的变更日志，以及双语的设计文档与 ADR |

## 文档与参与

[docs/INDEX-zh.md](docs/INDEX-zh.md) 是文档地图；设计文档在 [docs/architecture-zh.md](docs/architecture-zh.md)；难以回退的决策在 [docs/adr/](docs/adr/)。AI 助手请先读 [AGENTS.md](AGENTS.md)；分支、提交与 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
