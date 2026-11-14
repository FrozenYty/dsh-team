# dsh-team

[English](README.md) | 中文

[![ci](https://github.com/FrozenYty/dsh-team/actions/workflows/ci.yml/badge.svg)](https://github.com/FrozenYty/dsh-team/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![build step](https://img.shields.io/badge/build-none-brightgreen)

> 只是换人，不是换活。

一个 DeepSeek Harness 的 profile bundle，专补官方智能体花名册做不到的那件事：让成员离场。Lead 可以退役一个成员、从自己掌控的回收站把它恢复回来，也可以换成一位继任者——继任者接手 assignment、当时正在推进的工作，以及指向 Lead 自有任务板的指针。花名册归本插件所有，没有浏览器半区。

[github.com/FrozenYty/dsh-team](https://github.com/FrozenYty/dsh-team)

## 状态

- 当前版本：v0.40.2。
- **在这台机器的真实 profile 上跑过。** 退役、恢复、发消息、停止；一次替换，其继任者完成了前任的工作；回收站上限以及越界值在加载时被拒绝；交接书模板；spawn 选项与转发的路由；任务板及其交接；三个宿主侧钩子；以及一次性成员清扫与同意门槛——逐字段记在 `PROGRESS.md` 2026-11-13 那一条里。插件自己那份状态的搬迁也不再是计划：这个 profile 的花名册已经是一个文件，`<工作区>/.agents/team/roster.json`，由存储域导入并带一个标记文件；迁移是对着这份真实数据跑的——**110 条记录，20 份产物被移走，4,913,598 字节在目的地核对通过，46 条墓碑归为 `pruned`，44 条按原因保持原样，0 条被拒绝**。备份清单与目的地目录在字节总数上相互印证：两边都是 `4,913,598`，共 20 个文件——这也是这里唯一有资格用"核对通过"四个字的原因。
- **用比"我读过了"更强的东西核对。** **247 个测试**全部通过，`scripts/check.mjs` 打印 `check passed`；两者合起来覆盖写入时的各条上限、spawn 尚在进行时发起退役、两个花名册操作重叠、路由的兜底路径、定义查找链、成员作用域的那次读取，以及生存期清扫与同意门槛。这一版修掉的缺陷也**先在真机上复现过，然后才修**：对一个字节已被保留上限删掉的记录，`restore_member` 回的是 `reason: "pruned"`；对一个 spawn 出来的记录，回的是 `trash-missing`，**连 `reason` 字段都没有**。两个回答都在 `PROGRESS.md` 里，而每个探针前后回收站都是 20 个目录。
- **问过宿主自己的校验器，从已装存档里取出来的那一份。** `scripts/schema-check.mjs` 从 asar 里抽出 `@deepseek-ai/dsh-tools` 0.2.2-rc.1，跑的是注册表自己跑的那几个函数：`assertSupportedJsonSchema` 接受了 **11 个输出 schema 中的 11 个**，`validateJsonSchemaValue` 接受了 **13 个真实结果**，宿主一项都没拒。有三个参数 schema 用了 `maxLength`，它不在宿主的关键字子集里——而这次检查弄清楚的与其说是"它能用"，不如说是**它为什么能用**：`register()` 只断言 `output.schema`，参数是被原样投影给模型的，所以上限由动作在值到达时把住，而不是在 schema 这一层。这是本地检查，不是 CI 闸门——CI 里没有 Harness。
- **还没覆盖到的**：在别人的 profile 里激活——`scripts/check.mjs` 从不加载 Harness，任何仓库都证明不了这件事；某个服务或存储布局与这台机器上安装版不同的 Harness 构建；以及回收站移动的 `rename` 快路径，这台机器一次都没走过，因为它的数据根位于不同卷，每次移动走的都是带校验的复制路径（`EXDEV`）。归档约束也处于同一位置：它只在重载之后的第一次写入时执行，读取永远不触发，所以这个 profile 的花名册还没有被冲过——越过保留窗口的墓碑进入 `archive.jsonl` 这件事有测试覆盖，但在这台机器上还没有一次真机观测。
- 发布清单：[CHANGELOG.md](CHANGELOG.md)。只追加的历史：[PROGRESS.md](PROGRESS.md)。

## 安装与验证

```
plugin_manager  install_bundle  target: <本仓库的绝对路径>
```

安装是把本目录**链接**进 profile，而不是复制，所以真正运行的就是这棵工作树，没有构建步骤。装完之后的验证靠真实调用，而不是 `check.mjs` 的输出：

- 补丁行以 `application: applied` 激活，并且没有告警；
- 在 Lead 会话里可以调用 `list_members`，驻留成员带上下文压力；该 Lead 退役过成员之后，`host_hooks` 里的 `panel_filter`、`roster_filter` 与 `slot_credit` 读出 `"installed"` 且 `stripped_ids` 不为零——某个钩子从未装上时读出 `"absent"`，其 `message` 会点出它在等哪个服务；
- 对有产物的会话，`retire_member` 返回 `trashed: true` 与 `trash_path`；带 `replace` 的 `spawn_member` 返回 `predecessor_retired: true`，继任者处于下一代次，当前任有未完成任务时结果还会用 `transferred` 报出这些任务的 id；
- 在会话路由可读的 profile 里，不带选项的 `spawn_member` 回答 `started_with.route_source: "plugin"`，而该成员自己会话的 `request/header` 记录着同一个 provider 与 model；
- 没有成员在跑时 `wait_members` 回答 `no_progress`；你发的消息让某一轮结束时，它返回该成员的 target；
- Lead 的工具列表里有本插件的工具，没有 `spawn_teammate`、官方的 `wait_agent` 或 `team_task_*`——而 `list_agents`、`send_message` 与 `interrupt_agent` 仍在，因为它们由本补丁刻意保留挂载的官方服务行发布；
- 官方**成员**面板会列出在这里启动的成员，`retire_member` 之后该行**消失**而不是被改标注；**子智能体**选择器与官方 `list_agents` 也会同时丢掉这个成员。

## 用起来是什么样

插件没有界面：你用日常语言说需求，由模型调用工具，花名册就是这样靠对话管理的。下面是一次真实交互——一个成员带着 assignment 启动，随后被替换：

```
> 把这个求和交给一个帮手，让它先待命。
spawn_member { name: "handoff-probe", label: …, prompt: …,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else." }
← target: "handoff-probe", generation: 1, phase: "active", …

> 我用不上它了。换个继任者接过去，并把它退役。
spawn_member { replace: "handoff-probe", label: …, prompt: … }
← target: "handoff-probe-g2", generation: 2, predecessor_retired: true,
  assignment: "Compute 6 * 7 and reply with the single number, nothing else.", …

handoff-probe-g2（从未见过前任）回复：42
```

三条命令覆盖大部分场景：`spawn_member` 启动成员——带 `replace` 时是**把角色交出去**，而不是把团队做大；`list_members` 列出该 Lead 控制的全部成员及其实时状态；`retire_member`（或 `restore_member`）结束一个角色或把它收回来。本节节选自 [PROGRESS.md](PROGRESS.md) 中记录的一次验收运行。

## 为什么官方花名册不够用

官方实验性 Agent Teams 的花名册无法真正让成员离场。它由 Lead 会话的只追加事件日志折叠而来，成员相态封闭为 `provisioning | active | failed`：投影对任何离开终态的转换都会抛错，并把这次抛错记成永久失败——所以伪造一条“已退役”记录不是安全失败，而是毒化整个投影。`maxMembers`（16）检查的是一个只增不减的列表，名字永不复用，上游的重构依旧把删除推后（ADR 0001）。本插件补上缺的那一半，而不去 fork 官方花名册：在 Harness 子代理底座上维护自己的花名册，有真正的 `retired` 相态、下一代可复用的名字，以及一个“移动而非删除”的会话回收站。

## 工具

| 工具 | 做什么 |
|---|---|
| `spawn_member` | 把成员作为可续跑的子代理启动。`definition` 从文件启动，`spawn_options` 给它自己的目录、路由或 preset，`replace` 在同一次调用里启动继任者并退役前任，`lifetime` 说明这是 `standing` 角色还是 `one-shot`。 |
| `list_members` | 该 Lead 控制的全部成员：相态、代次、assignment、生存期、路由、实时状态与上下文压力——并在回答之前先清扫已经跑完的一次性成员。 |
| `wait_members` | 阻塞当前这一轮，直到某个成员的实时状态变化，或有界超时到期。 |
| `message_member` | 向活着的成员投递一条消息，并可顺带替换记录在案的 assignment。 |
| `stop_member` | 取消成员当前这一轮，保留它的激活与收件箱。 |
| `retire_member` | 结束一个角色：排空、立碑、把持久化会话移进回收站、执行保留上限。还带着东西的 standing 成员，需要先拿到本人的原话。 |
| `restore_member` | 把回收站里的会话移回记录的原始路径，记录转回 `active`。 |
| `compact_member` | 对驻留且空闲的成员强制压缩一次。 |
| `handoff_template` | 读取、保存或清除继任者收到的交接书。 |
| `task_board` | 该 Lead 自有的工作板：`create`、`list`、`update`、`release` 或 `delete` 一条任务。 |
| `list_my_tasks` | **成员自己的读取**，不是 Lead 的：只返回 `owner` 正好是本成员的行。 |

权威的那张表——每个返回字段、每一种拒绝、同意门槛、面板覆盖层——在 [docs/architecture-zh.md](docs/architecture-zh.md) §5；模型在调用时还会看到每件工具自己的描述。那张表回答不了的是**成员跑在哪个模型上**：那在 [docs/routes-zh.md](docs/routes-zh.md)。

## 成员是一份分工，不是一件任务

`spawn_member` 会问这个成员能活多久。`standing`（默认）是你预期还会再用的角色：永不自动退役，结束它是本人的决定。`one-shot` 是扇出场景——为一件工作而建，一旦它跑过、停下且不拥有任何未完成任务，清扫就自行退役它。给一次性成员发消息是**重新打开**它，而不是改写声明；插件也不会照自己数出来的计数自动转换它。

结束一个**还带着东西**的 standing 成员——记录在案的 assignment、一条 `open` 任务、或被反复交派的证据——需要本人的原话引文；什么都没带的属于打扫，写一个 reason 就退役。成员也可以是磁盘上的文件，而不是调用里的一段话：

```markdown
---
name: reviewer
label: Review the diff
assignment: Check every changed file for behaviour changes
model: a-cheaper-model
---
You review changes. Report only findings that change behaviour, with the file and the line.
```

整个主题在 [docs/member-lifecycle-zh.md](docs/member-lifecycle-zh.md)——四个相态、状态矩阵、清扫的三个条件与同意门槛；文件格式在 [docs/architecture-zh.md](docs/architecture-zh.md) §6。替换成员时，交接书见 [docs/handoff-zh.md](docs/handoff-zh.md)，它交出去的工作见 [docs/task-board-zh.md](docs/task-board-zh.md)。

## 限制与刻意省略

五件本 bundle 不做的事，每一件都是决定，而不是遗漏。

- **每个 Lead 一条记录，没有跨进程锁。** 花名册与这个 Lead 的任务板放在同一份 JSON 文档里——即该 Lead 工作区下 `.agents/team/` 里的 `roster.json`（ADR 0027）。没有任何东西为它串行化两个进程（ADR 0010），所以两个 Harness 进程共用一个工作区时是“后写者赢”：如果两边同时写同一个 Lead，后一次写入会替换前一次，而它没读到的更新就此丢失。对单个正在运行的 Harness 来说这是正确的，子代理本身也这样工作；插件不加锁文件，第二个写入者会在本进程下一次读或写时以 `foreign_write_at` 报出。
- **没有自己的浏览器半区。** 没有本插件自己的面板、没有 HTTP 桥、没有客户端 bundle。v0.3 的设置页面板从未在真实 profile 里渲染过，点击也无效，因此 v0.4 选择删除而不是修复（ADR 0008）。面板显示的内容是在宿主会话列表出口覆盖上去的（ADR 0023）：**成员**区列出本插件的活成员，已退役成员则离开面板而不是被标注。覆盖层只读：它既不能退役也不能替换任何东西，更不能写会话日志，所以官方折叠那套封闭相态（ADR 0001）约束不到它。所有操作仍然是面向模型的工具；将来若要做 UI，那是一个新决定，起点是 `actions.js` 里的操作。
- **官方的 `agent-team` 服务行保持挂载。** 收养、成员判定与投影过滤都要读它，所以补丁不能把它禁用——而这项服务自己也发布三件面向模型的工具：`list_agents`、`send_message`、`interrupt_agent`，它们因此仍留在 Lead 的工具列表里。补丁退役的是官方**工具**行（`tool-agent-team`）；移除那三件会连服务、连同本插件的收养一起带走（ADR 0017）。
- **被剪除的墓碑无法恢复。** 成功移入产物的那次退役会执行每个 Lead 的回收站上限，删掉超出的最旧条目。墓碑保留 `trashDir`，状态记为 `trashState: pruned`，但字节已经不在，因此 `restore_member` 以 `reason: "pruned"` 拒绝，且绝不调用工作区（ADR 0011、ADR 0028）。长期存续的团队若需要超过 20 份可恢复会话，请提前调大上限。
- **任务板是交接通道，不是项目跟踪器。** 一条任务只有 id、标题、一段有上限的正文、`open`/`done` 和可选的 owner，刻意没有优先级、依赖、评论、子任务与截止日期（ADR 0017、ADR 0020）。依赖尤其如此：它需要一张图和一条排序规则，而交接还得决定“依赖仍未完成的任务怎么办”；这个先后顺序留给 Lead 判断。任务板只回答一个问题：继任者现在扛着什么。

## 配置

插件把数据放在该 Lead 工作区下的 `.agents/team/`——包括 `roster.json`，以及存放退役会话的 `trash/`。profile 若设置 `DSH_TEAM_DATA_DIR`（或改名前的 `DSH_TEAM_ROSTER_DATA_DIR`），则改用那个目录；而冻结的 `~/.dsh/team-roster` 是没有自己工作区的会话的落点，因此每个会话都有一处可写，也不会有任何写入落到存储域上。一个没有花名册文件的新根会从 `DSH_TEAM_SEED` 命名的文件里读一次记录——本插件自己的形状或存储域导出——配置了却不可用的 seed 会被报出来，而不是被默默忽略。存储域不回答任何读取；它只为迁移一个从未绑定过工作区的 profile 再被打开一个版本（ADR 0014、ADR 0027、ADR 0031）。

每个 Lead 的回收站最多保留 **20** 份退役会话。这个上限是 bundle 补丁行上的 `trashLimit` 字段，所以改它是改 profile 自己的 `cordis.patch.yml`，按 id 匹配：

```yaml
- id: team-roster
  config:
    trashLimit: 7
```

这个 `id` 冻结为 `team-roster`，而包名是 `dsh-team`：profile 正是按它定位这一行，改名会让覆盖静默失配（ADR 0014）。该字段必须是不小于 1 的整数——`0`、负数、小数、数字字符串、`NaN` 以及显式写的 `null` 都会在加载时、任何工具注册之前被拒绝，报错信息点名字段、看到的值与最小值。入口仍然不声明 `Config` **schema**，所以提供方把 `include:dsh-team` 报为 `absent`：这是 schema 投影层面的说法，而不是关于“能不能配置”的说法，因为只有原生 Schemastery schema 才会被投影，而零导入的 bundle（ADR 0002）无法导入它（ADR 0012）。

## 运行要求与兼容性

**运行**本 bundle 需要已安装的 Harness 以及它读取的官方包，而不是 npm 依赖：它以链接方式装进 profile，且不导入任何 `@deepseek-ai/*` 包（ADR 0002），所以真正运行的就是这棵工作树。它读取子代理 seam、官方 `agent-team` 服务、`sessionController`（投影过滤与面板覆盖层；宿主从不发布它时报告 `panel_filter: "absent"`，而不是悄悄丢掉这个钩子）、`agentTeams.listMembers`、token 计量、存储域设施，以及智能体注册表与它的 `agent/status` 事件。`compact_member` 还需要已挂载的压缩后端，补丁里的 `compaction-basic` 条目会启用它。宿主侧效果都带能力探测，并且各自在所包装的服务存在时才安装，所以 Harness 形状变了就跳过那项效果、并在 `list_members` 里说明，而不是让加载失败。没有挂载实验性团队 bundle 的 profile 里没有 `tool-agent-team` 行可供补丁禁用；Loader 会就这个缺失目标告警，并跳过该条目。

## 开发

```sh
node --check index.js actions.js roster.js definitions.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

本地门槛就是这三条命令。`--test-isolation=none` 不是可选项：Node 22 把它写作 `--experimental-test-isolation`，所以这个拼写本身就固定了大版本为 Node 24；而默认 runner 会为每个测试文件起一个进程，本机沙箱拒绝这种 spawn。CI 钉住 Node 24 并跑同一条命令，所以本机通过的含义与 CI 通过相同。`scripts/check.mjs` 证明不了插件能用——它从不加载 Harness。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `index.js` | Host 插件入口：工具定义、参数校验、Lead 专属权限检查 |
| `actions.js` | 模型侧工具背后的花名册操作 |
| `roster.js`、`trash.js` | 持久花名册（相态、代次命名、收养、迁移），以及带恢复与保留上限的会话回收站 |
| `definitions.js` | 定义层：扁平 frontmatter 解析器、沿定义查找链的扫描及其上限、团队文件的交接书模板，以及以上解析所用的工作目录 |
| `host-hooks.js` | 投影过滤（剔除已退役 id，并把本插件的活成员追加进团队面板）、官方花名册读取过滤、名额补偿，以及这三者的延迟安装 |
| `tests/`、`scripts/check.mjs` | 单元测试，以及 CI 会跑的仓库检查 |
| `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg`、`templates/`、`.github/` | bundle 本体、随包提供的五个角色模板、CI workflow 与模板 |
| `PLAN.md`、`PROGRESS.md`、`docs/` | 待办任务、只追加的变更日志，以及双语的设计文档与 ADR |

## 其余内容在哪里

| 问题 | 文档 |
|---|---|
| 成员如何在相态之间移动，退役与替换各自按什么顺序做？ | [docs/member-lifecycle-zh.md](docs/member-lifecycle-zh.md) |
| 工作板、交接，以及为什么工作板写入不能抹掉交接 | [docs/task-board-zh.md](docs/task-board-zh.md) |
| 继任者收到的交接书，以及哪个模板生效 | [docs/handoff-zh.md](docs/handoff-zh.md) |
| 存储记录、回收站与保留上限 | [docs/roster-storage-zh.md](docs/roster-storage-zh.md) |
| 分层、Harness 底座、完整的工具面、风险边界 | [docs/architecture-zh.md](docs/architecture-zh.md) |
| 成员跑在哪个模型上，以及什么在计费 | [docs/routes-zh.md](docs/routes-zh.md) |
| 从 v0.13 或更早版本升级 | [docs/upgrading-zh.md](docs/upgrading-zh.md) |
| 某个决策为什么是这样 | [docs/adr/](docs/adr/)，索引在 [docs/INDEX-zh.md](docs/INDEX-zh.md) |
| 每个版本改了什么 | 概要在 [CHANGELOG.md](CHANGELOG.md)，证据在 [PROGRESS.md](PROGRESS.md) |

AI 助手请先读 [AGENTS.md](AGENTS.md)；分支、提交与 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
