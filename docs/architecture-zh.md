# 架构

> Owner: @FrozenYty · Revisit when: Harness 升级改动了本插件使用的某个 Service

本文说明插件是什么、现在做什么，以及正在构建的花名册设计。设计背后的决策记录在 `docs/adr/`；本文描述结果。

## 1. 插件是什么

一个 DeepSeek Harness **profile bundle**。安装它会做三件事：

1. 选中一条 profile 默认关闭的官方插件行（`compaction-basic`）；
2. 插入一个我们自己写的 Host 插件（`dsh-team`）；
3. 禁用官方那条面向模型的团队工具行（`tool-agent-team`），它的工具由本插件顶替（P2-07、§2.3、§4.5）。

没有构建步骤，也没有运行时依赖：官方行由已安装的 Harness 自己解析，我们的入口不导入任何东西（ADR 0002）。bundle 只有 Host 半区：没有浏览器半区（ADR 0008）。

官方那条团队**服务**行（`agent-team`）刻意不动：收养（§4.5.1）与投影过滤（§2.4）都要读它。

插件在 v0.10.0 由 `dsh-team-roster` 改名而来，而它的存储域（`team_roster`）、补丁行 id（`team-roster`）与回收站目录（`~/.dsh/team-roster`）刻意保留了旧拼写（ADR 0014）。

它唯一的可调项是每个 Lead 的会话回收站上限，由 bundle 自己补丁行上的 `trashLimit` 字段承载（`- id: team-roster`，`config: { trashLimit: <整数> }`）。`apply(ctx, config)` 在注册任何东西之前先解析它：字段缺失取 `DEFAULT_TRASH_LIMIT`（20），至少为 1 的整数原样采用，其他值则让加载失败，报错信息里点名字段、看到的值与最小值（ADR 0012）。本入口刻意不声明 `Config` schema，因此 Host 的 Config 提供方仍报 `absent`：该投影只接受原生 Schemastery 图，而零导入的 bundle 无法提供，字段改由 `apply` 校验。

## 2. 交付了什么、什么时候

一张简短的对应表，不是变更日志：每条只说明该版本新增了什么，以及今天由哪一节负责。

- **v0.1**——在 profile 级启用压缩后端（§2.1）与上下文工具（§2.2）。
- **v0.2**——自建花名册：spawn、发消息、停止、退役与恢复（§4.5），退役协议及其交接（§4.4），把产物移入回收站（§2.5），以及退役会刷新的两个可选宿主侧效果（§2.4）。
- **v0.4**——只面向模型的接口（ADR 0008）：设置面板与其 HTTP 桥被删除，收养范围扩大到 Lead 控制的每个后代（§4.5.1）。
- **v0.7–v0.8**——每个 Lead 的回收站有上限，上限是 bundle 的 `trashLimit` 配置字段（§2.5、ADR 0011、ADR 0012）。
- **v0.9**——临时成员：创建时可标记为一次性，模型本来就会调用的那些花名册操作会在它运行过并停止后，用惰性清扫把它退役（§4.3.1、ADR 0013）。
- **v0.10**——改名：包名、补丁行的 `name` 与显示标题变为 `dsh-team` /「团队」，而存储域、补丁行 id 与回收站目录保留改名前的名字（§1、ADR 0014）。
- **v0.11**——每个 Lead 一份可复用的交接书模板，由一个工具写入，替换交接用它合成继任者的交接书（§4.4、§4.5、ADR 0015）。
- **v0.12**——成员可以用自己的 cwd、模型路由或 agent preset 启动；Harness 拒绝的启动变成带类型的结果；陈旧 target 的拒绝会指出该名字现在的活持有者（§4.1、§4.3、§4.4、§4.5、ADR 0016）。
- **v0.13**——插件拥有的是工作本身，而不只是成员：任务板放在 Lead 的花名册记录上，替换会把前任的未完成任务交给继任者，而没有继任者的退役会让这些任务变为无主并点出它们的 id（§4.2、§4.3.2、§4.4、§4.5、ADR 0017）。
- **v0.14**——官方团队工具行退役：bundle 补丁禁用 `tool-agent-team`，于是那行的 `spawn_teammate`、`wait_agent` 与 `team_task_*` 工具不再注册，Lead 由本插件自己的工具服务。被保留的 `agent-team` 服务还发布三件模型侧工具——`list_agents`、`send_message`、`interrupt_agent`——它们仍在（§1、§2.3、§4.5、§6）。
- **v0.15**——阻塞式等待回到本插件自己的接口：`wait_members` 监听 Harness 的 `agent/status`，范围是本 Lead 花名册上的子会话；这件事原本由被禁用那行的 `wait_agent` 覆盖，而官方服务看不到这些成员（§4.5）。
- **v0.16**——成员可以定义在磁盘上：`spawn_member.definition` 读取 Lead 工作目录下 `team/` 里带扁平 frontmatter 的 markdown 文件，调用自己的参数优先于文件内容，结果会说明每一部分来自哪里（§4.5、§4.6、ADR 0018）。

### 2.1 启用压缩

profile 把 `compaction-basic` 置为 `inactive`，所以没有任何东西在压缩，每个智能体——Lead 和所有成员——都会一路涨向模型窗口。bundle 把该行覆盖为 `disabled: false`。这个后端注册的是不带作用域的 `agent/pre-step`、`agent/request`、`agent/request-error` 监听器，因此进程内每个 Agent 都被覆盖，包括子代理。

本机 DeepSeek 路由的默认值（窗口 1,048,576，输出预留 256,000，headroom 65,536）：自动压缩在
`floor(min(窗口 × 0.8, 窗口 − 输出 − headroom))` = 727,040 tokens 触发，按 `窗口 − 输出` 的 16% 原样保留最近内容。要调，就在更高层补丁里对同一行给一个 `config` 覆盖。

`command-compact`（`/compact`）刻意**不**启用：它需要 `commands` 服务，而本 profile 同样没有挂载，所以即使启用该行也只会停在 `absent`。

### 2.2 上下文工具

上下文工具在 v0.1 交付；它们现在的行在 §4.5，接口由那一节负责。每个 Lead 专属工具都注册在 Team Lead 的确切 Agent 上下文上（`agent/created`），并在 `agent/disposed` 时卸载。不遮蔽任何官方工具名，也不写任何会话事件。

`member_context` 存在于 v0.1，已移除：它的行与 `list_members` 重复，而且读的是官方花名册而不是本插件的。

实测到的限制塑造了后续设计：本地子代理空闲即被卸载，而 `compactNow()` 要求 Agent 驻留且空闲。因此已完成的成员无法按需压缩；可行路径是用消息唤醒它，让自动压缩在它的下一步运行。

### 2.3 自建花名册工具

自建花名册及其工具在 v0.2 交付。工具接口由 §4.5 负责，退役协议由 §4.4 负责，收养由 §4.5.1 负责，而这些工具读写的那条记录由 §4.2 负责。

收养（§4.5.1）让 `retire_member`、`message_member`、`stop_member` 对本插件从未创建过的子代理同样有效——正是以前完全不可见的那批。一次性（one-shot）子代理同样会被收养，可停止、可退役；它不能冷恢复，所以 `message_member` 只在它驻留时可送达。

记录存在一个以 Lead 会话 id 为键的 `storageDomain` 域里（ADR 0003）。命名规则：代次 1 用裸名字；代次 2 起用 `<base>-g<N>`，因此继任者绝不会与已退役的名字相撞。退役后再用同一个基名创建，就是替换操作：`probe-a` 退役、`probe-a-g2` 启动，两条记录都在。

官方团队花名册与本花名册不再呈现两套 spawn、等待与任务工具：从 v0.14.0 起，补丁禁用官方的 `tool-agent-team` 行（P2-07），因此 `spawn_teammate`、`wait_agent` 与 `team_task_*` 工具不在 Lead 的工具列表里，唯一的列表是 `list_members`。官方花名册的**服务**仍然挂载，所以 `list_members` 照旧报出它创建的成员——再加上收养的全部后代与本插件启动的成员——也是那项服务发布的三件模型侧工具 `list_agents`、`send_message`、`interrupt_agent` 仍在该列表里的原因：禁用服务行会连收养、成员判定与投影过滤一起带走。

**工作本身从不并存**：从 v0.13.0 起，替换交接的是本 Lead 自有任务板上的行（`task_board`），它存放在花名册记录旁边，插件的交接不再读取、也不再指向官方任务板（§4.3.2）。官方任务板上已有的行不迁移，本插件也读不到——而从 v0.14.0 起，能看到它们的工具也已消失，所以想让它们回到自有任务板上，就由 Lead 重新创建（ADR 0017）。

### 2.4 宿主侧效果

两个效果让退役对客户端可见，并让官方的成员名额重新可用。两者都做能力探测、都在插件卸载时精确还原，且都不写 Lead 会话（ADR 0004）。

| 效果 | 机制 | 宿主形状缺失时 |
|---|---|---|
| 投影过滤 | 包装 `sessionController.list`／`projections`／`control`／`follow`，从 `subagentCatalog` 与 `agentTeam` 帧里摘掉已退役 id | 退役仍生效，客户端仍显示该成员 |
| 名额补偿 | 替换旧花名册的 `maxMembers` getter 并包装 `spawn`，在一次 spawn 期间按发起 Lead 的退役数临时抬高上限 | 退役仍生效，官方名额仍被占用 |

两者都通过一个两秒缓存读取退役记录，`retire_member` 会主动使缓存失效；两者对其他插件透明：参数相同、返回形状相同，载荷是原地修改而不是复制，调用方持有的引用继续有效。

### 2.5 退役会移走产物

`retire_member` 先立碑、再碰文件系统：墓碑带上即将使用的回收站路径与 `trashState: 'pending'` 标记，随后把持久化会话移入 `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`，最后把记录确认为 `trashState: 'done'`；这些步骤由 §4.4 负责。顺序是刻意的：两者之间崩溃留下的是“一条 `retired` 记录配一份要么还没移动、要么已经进回收站的产物”——两种情况都可恢复，因为 `pending` 表示“移动可能发生也可能没有”，而恢复会先去回收站找。反过来则会留下“已进回收站的会话 + `active` 记录”，之后任何一次读取都解释不通。

真正让成员从宿主的自有发现里消失的是**移动**——session-query 会摘掉已经不在的文件——而移动本身不删除任何东西：跨设备兜底是这一步里唯一会移除源的分支；产物移不动时改由工作区归档隐藏会话（`archived: true`、`trashState: 'none'`，并丢弃计划中的回收站字段）。恢复是同样明确的逆操作：记录里保留了原始路径和产物类型（`trashKind`——会话目录或单个产物文件），所以 `restore_member` 是**移动**而不是猜测；结果分支与各种拒绝由 §4.5 负责。

**真正移入过产物**的那次退役还会在同一次调用里执行每个 Lead 的上限（§4.4 第 5 步、ADR 0011、ADR 0012）：这次移动正是回收站增长的唯一时刻，因此不存在定时清理，也不存在读取时清理。

## 3. 为什么不扩展官方花名册

官方花名册是 Lead 会话只追加日志的折叠。成员相态为 `provisioning | active | failed`；投影拒绝任何离开终态的转换，而被拒绝的事件会记成永久 `failure`，使该 Lead 的 Team 服务失效。因此伪造一条“已退役”记录不会安全失败。`maxMembers` 检查的是一个永不收缩的列表，名字永不复用，上游重构也仍在延后删除。

完整论证与被否掉的替代方案见 ADR 0001。

## 4. v0.2，进行中：自建花名册

### 4.1 底座

成员是通过 `ctx.subagents.startActivation(...)` 创建的普通子代理，它已经提供可续聊的子代理、收件箱消息、打断、排空、冷恢复和实时并发上限。插件只拥有 Harness 不提供的部分：花名册、它的生命周期，以及由此产生的模型侧工具。

安装版的 seam 是 `dsh-subagent` **0.2.2-rc.1**，与公开源码树并非同一代。它的激活请求是：

```
{ provider, label, request: { prompt, parent, cwd?, agentPreset?, agentOptions?, outputSchema?, maxDepth? },
  signal, delivery, childId? }
```

没有 `name` 字段，也没有 `resolveName`／`namesOf`。因此名字属于我们：插件生成一个 UUID `childId` 传给 `startActivation`，把 name→childId 的映射放在自己的花名册里——与官方 Team 的做法一致。并发上限是 `maxActiveSubagents`（默认 8），按子代理树、进程内计数；排空一个子代理解放它的名额。

**request 的组合规则。** 插件发送 `{ prompt, parent }`，再加上模型通过 `spawn_member.spawn_options`（§4.5）点名的可选字段：`cwd`、`agentOptions` 与 `agentPreset`。任何一个字段省略，都表示该成员继承 Lead 的值；这里要记下唯一的例外，因为不写出来这条规则读起来像是绝对的：改了 `provider` 或 `model` 却没给 `reasoningEffort` 时，新路由解析自己的默认值，而不是继承 Lead 的 effort。什么都不传的 spawn 组合出的 request 与以前完全一样——有测试钉住这个对象。`cwd` 原样转发：seam 会把相对路径解析到父代理的 cwd 上（`resolveDirectory`），而子代理保留父代理的权限根，因此沙箱授权之外的目录仍会被拒绝；如果插件自己先解析路径，就会与 Host 的判断不一致。两个能力门属于 provider：`agentOptions` 需要 `provider.capabilities.agentOptions`，`agentPreset` 需要 `provider.capabilities.agentPreset`——进程内的 spawn/fork provider 为 true，所有外部后端为 false（其能力声明就是 `NO_START_CAPABILITIES`）——两者都在 manager 预留任何资源之前断言。有三个 Harness 事实塑造了这个接口，写在这里是因为读者不会预期它们：**没有按次调用的工具白/黑名单**，因此 `agentPreset` 是获得工具受限或只读成员的唯一途径，seam 也明确拒绝 `toolFilter`；**preset id 必须由 profile 的 bundle 补丁声明**，因为注册表既不扫描目录也不接受路径；**没有 worktree 字段**，worktree 是先 `ctx.worktrees.create(...)`、再把它的 `path` 当 `cwd` 传，而那个服务是可选的、实验性的，所以本插件不自己创建（ADR 0016）。

有两个 Harness 事实塑造了退役流程：

- `drainChildren(parent, [childId])` 停掉单个子代理、释放名额与驻留，但子代理的会话与父会话里的 `subagent/catalog` 条目会保留。被排空的子代理会被官方花名册自己的列表永久列出，这正是我们要有自己的列表工具的原因。
- `ctx.workspaceRegistry.archiveSession` 会把一个会话从所有工作区界面隐藏。它可逆、不删除任何东西，因此适合作为“产物移不动”时的兜底。

### 4.2 花名册记录

每个 Lead 会话一条花名册记录，里面是该团队的成员记录；表以 Lead 会话 id 为键（ADR 0003）。

```
memberId      稳定身份：本插件启动的成员在此生成，收养的子代理用它的子会话 id
name          模型侧名字，只在当前成员之间唯一
generation    名字的第一位持有者是 1，继任者是 2，以此类推
childId       子代理会话 id，随预留一起写入
phase         provisioning | active | retired | failed
label         给模型看的职责描述
assignment    成员正在做什么，由模型写入；最多 1000 个字符（§4.4）
createdAt     ISO 时间戳
predecessor   被本成员替换掉的 memberId，仅出现在带 `replace` 启动的继任者上
adopted       该记录是从别的花名册收养而来（而不是本插件启动）时为 true
note          启动错误，仅出现在启动失败的记录上
retiredAt     ISO 时间戳，仅出现在墓碑上
retireReason  模型给出的退役原因（如果给了）
trashPath     会话产物被移入的回收站目录，在墓碑上
originalPath  该产物原来的位置，使恢复是移动而不是猜测
trashKind     移动的是什么：会话目录为 `directory`，单个产物文件为 `file`
trashState    移动在途时为 `pending`，落地后为 `done`，压根没有可移动之物时为 `none`，
              移动已落地但产物后来被保留上限剪除时为 `pruned`（§2.5）
archived      产物移不动、改由工作区归档隐藏会话时为 true
ephemeral     成员在工作结束后自行退役时为 true，由 spawn_member 写入、由 message_member 清掉
              （§4.3.1）；可选，其余记录没有该字段，因此非临时记录与以前完全一致
startedAt     临时成员上记录其子代理启动时刻的 ISO 时间戳。这是惰性清扫所要求的正面证据，
              因此从未发布过的预留永远不会被清扫
handoffTemplate  在花名册记录上、不在成员上：这个 Lead 的交接书模板，替换时由它插值（§4.4）；
              可选，因此任何更早版本写下的记录都能照常加载、行为不变
tasks         在花名册记录上、不在成员上：这个 Lead 的工作板，一个任务行数组。每行是
              `{ id, title, status, owner?, created_at, updated_at? }`：`id` 是创建时生成的 UUID，
              `title` 是受上限约束的展示文本（`TASK_TITLE_MAX`，200），`status` 是 `open | done`，
              `owner` 是承担该工作的成员 target，`created_at` 是 ISO 时间戳，首次改动后才出现
              `updated_at`。可选，因此 P2-09 之前写下的记录都能照常加载、行为不变；工作板为空的
              Lead，就是那条从未获得该字段的记录（ADR 0017）
```

`trashState` 与 `phase` 一样会在加载时校验：未知值会被拒绝，而不是被猜测。`pruned` 保留
`trashPath`、`trashKind` 与 `originalPath`——墓碑仍记录产物去了哪里——并且是唯一会让
`restore_member` 在不做任何移动的情况下直接给出带类型拒绝的取值。

没有其他字段；特别地，没有 `dormant` 相态（§4.3），也没有 `briefPath`：交接书在替换时由
`assignment` 与该 Lead 的 `handoffTemplate` 合成（§4.4）。`ephemeral` 与 `startedAt` 是 P4-01 引入的一对字段，
两者都可选：任何更早版本写下的记录都能照常加载，行为不变。

`handoffTemplate` 是这条记录上唯一描述 Lead 而不是成员的字段。它的**类型**在加载时校验，而它的
**内容**——占位符词表、必须引用 `{assignment}`、长度上限——在写入时校验，并由读取形式重新报告（§4.5）。
这个分工是刻意的：存储设施在打开域时会校验每个 Lead 的每条记录，因此为某个 Lead 的一处交接书偏好而拒绝
整个花名册，会把所有团队都藏起来。存储的模板一旦不再通过校验，会被报告而不是被悄悄丢掉，而合成会退回
内置交接书，而不是把出错的 token 写进子代理的提示词。

`tasks` 出于同样的理由采用同样的分工，并且更进一步。它的**结构**在加载时校验——必须是数组，每行必须是
对象，`id` 是非空字符串，`status` 是已知值，`owner` 出现时必须是非空字符串，且 id 不得重复——因为一条
无法表示任务的记录，也就无法为它作答。它的**内容**不校验：只是一个标题太长、或者在写入上限出现之前就
已经超出列表上限，都照常加载，并由读取形式报告（行上的 `problem`，§4.5），而不是拒绝整个域。这就是
`handoffTemplate` 先例用在最要紧的地方：否则某个 Lead 的一条陈旧任务，会把这台机器上所有花名册都藏起来，
包括那个本来就用来修复该团队的退役操作。两处写入上限都是拒绝而非截断：`TASK_TITLE_MAX`（200）与
`TASK_LIMIT`（每个 Lead 200 条任务，含 `done`）。

`assignment` 是继任者交接书所依据的持久陈述：用 `spawn_member.assignment` 写入，用
`message_member.assignment` 替换，出现在每一行 `list_members` 上，退役后仍留在墓碑里。

`name` 只在**当前**成员之间唯一。继任者复用它并把 `generation` 加一——官方花名册做不到这一点，因为它把名字视为永久占用。每次改动都是花名册表上的一次原子 `update`，不是“先读再 put”；每个操作在决定之前都重读花名册，因此同一模型轮次里的两次工具调用看到的是彼此的写入，而不是互相覆盖（§4.3）。

### 4.3 状态矩阵

实现转移之前，每个格子都要先被决定（AGENTS.md §4.8）。四个相态就是 `PHASE` 里的那四个。**拒绝**表示刻意不受理：调用会说明原因而不是执行，既不是崩溃，也不是遗漏。“同基名”指启动某个基名，而该基名的前一持有者正处于该相态。

| 相态 \ 事件 | 收养 | spawn（同基名） | replace | 发消息 | 停止 | 压缩 | 退役 | 恢复 | 清扫 |
|---|---|---|---|---|---|---|---|---|---|
| `provisioning` | 收养不会产生该相态——被收养的记录从 `active` 或 `failed` 开始 | 预留下一代次；本行不受影响 | 先启动继任者，再排空并给这条预留立碑 | 通过 `sendMessage` 投递；尚未发布的子代理会被子代理服务拒绝，错误如实上报 | 子代理未驻留时无操作，已驻留则取消本轮 | 在它驻留且空闲之前拒绝 `not-resident` | 先排空，再立碑；此时产物通常还移不动，因此 `trashed: false`，由归档分支决定 | 拒绝 `not-retired`——只有 `active` 是无操作成功（`restored: true, reason: 'already-active'`） | 清扫无操作——什么都还没运行，没有可依据的证据；只有读取时的对账会把这一行移到 `failed` |
| `active` | 无操作——身份就是子会话 id，已认识的子代理不会被收养两次 | 预留下一代次；本行不受影响 | 继任者从交接书启动，随后本成员被排空并立碑 | 投递；运行中的子代理在下一步看到，已卸载的会冷恢复 | 取消当前轮；激活、收件箱与记录保留 | 驻留且空闲时原地压缩；运行中拒绝 `busy`，已卸载拒绝 `not-resident` | 排空、立碑（`pending`）、移动并确认、刷新宿主侧效果 | 无操作成功：`restored: true, reason: 'already-active'` | 清扫唯一会行动的相态：带 `startedAt` 的临时成员在子代理不再驻留时按正常路径退役；仍在运行或驻留的成员、以及任何非临时成员，都原样不动（§4.3.1） |
| `retired` | 无操作——墓碑持有子会话 id，这正是阻止重新收养的东西 | 允许：同基名的下一代次启动，不带替换关系（§2.3） | 继任者用墓碑里的交接书启动；退役这一半是无操作（`reason: 'already-retired'`） | 拒绝 `retired` | 拒绝 `retired` | 拒绝——只有 `provisioning` 与 `active` 可寻址 | 重复调用：无操作成功，`retired: true, drained: false, reason: 'already-retired'` | 把产物移回，或走工作区取消隐藏分支；`reason` 说明走的是哪条。`trashState: 'pruned'` 的墓碑则返回 `restored: false, reason: 'pruned'`，且绝不调用工作区 | 无操作——墓碑本身就是清扫要达到的结果 |
| `failed` | 无操作——已知子会话 id | 预留下一代次；本行不受影响 | 先启动继任者，再给这条记录立碑 | 拒绝 `failed`——子代理从未启动，没有东西能接收 | 拒绝 `failed` | 拒绝——只有 `provisioning` 与 `active` 可寻址 | 受理并立碑；通常既没有可排空的，也没有可移动的 | 拒绝 `not-retired`——只有 `active` 是无操作成功（`restored: true, reason: 'already-active'`） | 无操作——它从未运行，记录保持可见且可退役 |

Harness 通知是任何插件操作都无法阻止的事件：

| 相态 \ 通知 | 子代理本轮结束 | 子代理本轮失败 | 宿主排空或卸载该子代理 | 持久化会话消失 |
|---|---|---|---|---|
| `provisioning` | 不适用——预留发生在任何轮次之前 | `failed`，启动错误写进 `note`；这是本插件唯一记录的失败 | 观察不到；预留一直保留到启动有结果 | 退役返回 `trashed: false` 并给出原因，随后归档分支隐藏该会话 |
| `active` | 本身无持久变化——观察不到完成通知；相态保持 `active`，实时状态报 `unloaded`。临时成员会被下一次惰性清扫退役，这是把该通知变成持久变化的唯一途径（§4.3.1） | 无持久变化——启动之后的失败在这里不可见，记录保持 `active` | 相态不变，实时状态 `unloaded`；仍可发消息（冷恢复），也可退役 | 退役返回 `trashed: false` 并退回归档；恢复返回原因，记录保持退役 |
| `retired` | 忽略——没有活子代理 | 忽略 | 忽略 | 恢复拒绝，记录保持退役 |
| `failed` | 忽略 | 忽略 | 忽略 | 忽略 |

这些格子依赖的前提：

- **没有 `dormant`，P4-01 也没有新增相态。** 上面四个相态就是 `roster.js` 里 `PHASE` 的全部；实时状态（`running`、`idle`、`unloaded`）在调用时从 Harness 读取，从不存储。临时成员不需要一个存储的“已完成”相态：`ephemeral` 标记挂在记录上，只要存在“它运行过并已停止”的正面证据，惰性清扫就会退役它（§4.3.1）。这段注释过去期待的完成钩子在 Harness 里并不存在（ADR 0013）。
- **`replace` 是一次模型调用，由 `spawn` 与 `retire` 合成。** 每个格子里都先启动继任者，因此启动失败时这一行原封不动，而退役失败会返回 `predecessor_retired: false` 并说明原因。
- **Harness 拒绝的启动就是同一种启动失败，只是以带类型的结果作答。** 能力门在预留任何子代理之前断言，因此没有任何东西在运行：插件先前写下的预留变成一条 `failed` 记录，不会有任何东西停在 `provisioning`，`spawn_member` 返回 `started: false` 与一个模型能据以行动的原因，而不是宿主错误（ADR 0016）。在 `replace` 的格子里，这正是上文已经写明的顺序：前任原封不动，结果说明 `predecessor_retired: false`。
- **带已存模板的 `replace` 仍是同一个格子。** 相态与两半的顺序都不变：继任者从交接书启动，只是交接书由该 Lead 的 `handoffTemplate` 渲染，而不是内置形状（§4.4）。新增的两处拒绝都发生在任何东西启动之前——模板在写入时就校验，渲染结果超过上限则拒绝该次调用——因此格子保持原样，记录也不被改动。
- **同一模型轮次里的两个工具。** 每次调用都重读花名册，每次改动都是花名册表上的一次原子 `update`（§4.2），因此第二次调用是在第一次的结果上行动：同一轮里先 `message_member` 再 `retire_member` 会先投递再立碑，反过来则拒绝 `retired`，先 `retire_member` 再 `spawn_member` 会启动下一代次。并行的工具调用由存储表串行化，而不是由调用方。
- **已退役或失败的成员仍是一条可控记录。** 它可以被列出、退役、替换：`retire_member` 与 `restore_member` 的查找覆盖任何相态。只有需要活子代理的 `message_member` 与 `stop_member` 是窄的，它们以带类型的原因 `retired`、`failed` 或 `missing` 拒绝。
- **被剪除的墓碑仍是退役记录，而不是消失。** 保留上限（§2.5）移除的是产物，不是成员身份：记录仍在列表里，仍保留职责与路径，因此 `restore_member` 能依据记录回答 `pruned`，而不是在缺失目录上失败。这个格子是拒绝，相态保持 `retired`。

有两个格子代价最高，特意点名：

- **provisioning 期间退役**——记录立刻变 `retired`，在途子代理发布后被排空。成员绝不能退役后复活。对
  provisioning 成员执行 `replace` 时，继任者启动之后对前任做同样的事。
- **active 期间退役**——退役优先于在途工作。记录里的 `assignment` 就是交接书（§4.4）；如果模型从未记录过，继任者的提示词会如实说明，并让它去该 Lead 自己的任务板取，而不是凭空编一份摘要。

#### 4.3.2 交接矩阵（P2-09）

成员承担的工作不只是它的 `assignment`。它还是这个 Lead 任务板上把该成员记为 `owner` 的那些未完成任务（§4.2），而这些行在每个事件上如何变化，要在实现之前就定下来（AGENTS.md §4.8）。每个格子回答三个问题：

- 该成员的**未完成**任务如何变化；
- 调用**报告**了什么；
- 它的**已完成**任务是否移动。

**没有任何一个格子会移动 `done` 任务。** 已完成的工作属于完成它的那条记录，因此 `done` 行在表中每个事件上都保持 owner 不变，包括让它退役的那些事件。整个矩阵就建立在这一条规则上：交接交出去的是**尚未偿清的工作**，不是一份历史。

| 事件 | 成员的未完成任务 | 结果字段 | 已完成任务 |
|---|---|---|---|
| `spawn_member` 带 `replace` 成功，前任退役 | 在写墓碑之前改为归继任者所有：同样的行，新的 `owner` | `transferred`（数量）与 `transferred_tasks`（id）；退役记录不会给出第二份 | 留在前任的墓碑上 |
| 对**已退役**前任执行 `spawn_member` 带 `replace` | 改为归继任者所有，并连同其他所有无主的未完成任务：这些工作是被更早那次退役留下的，而这次替换正是它在等的继任者 | `transferred` 与 `transferred_tasks`，消息里会点名；退役这一半回答 `already-retired`，不再加字段 | 原地不动 |
| **继任者启动失败** | 什么都不动：前任原封不动且仍然活着 | 抛出的错误说明前任**没有**被退役，也不出现任何任务字段，因为没有任何任务移动 | 不变 |
| **继任者已启动、退役失败** | 已经移动过：交接是第一次写入，因此调用方启动的继任者仍然带着它的工作 | `predecessor_retired: false`；`transferred` **缺席**，因为这次调用没有转移任何东西（是上一次尝试转的） | 不变 |
| `retire_member` **没有继任者** | 清掉 owner：行仍是 `open` 并变为无主，因为工作依然欠着 | `unowned`（数量）、`unowned_tasks`（id），消息说明没有人会接手它们 | 留在墓碑上 |
| **恢复**一位任务已被转交的成员 | 不变：恢复恢复的是一条生命周期记录与一份产物，它不重新分配工作 | `unowned` / `unowned_tasks` 报告仍在等待认领的工作——这是事实，不是主张；不写入任何 owner | 不变 |
| 由**临时清扫**执行的退役 | 清掉 owner，走的是模型本来也会调用的同一套退役流程 | 触发调用的 `swept`/`swept_targets` 增加 `unowned`/`unowned_tasks`，列出被清扫成员变为无主的行 | 留在墓碑上 |
| 一条未完成任务，其 **owner 名字后来被新一代复用** | 按名字什么都不会发生：`owner` 是 **target**，而一个名字的第 2 代是 `reviewer-g2`，是另一个 target。新一代不会仅凭名字继承任何东西，而旧 target 仍可作为重新指派的有效 owner 句柄 | 无 | 不变 |

这些格子依赖的前提：

- **交接是替换的第一次写入，早于墓碑。** 先成功启动，再用一次改动重新指派这些行，然后才写退役记录。因此启动失败不会移动任何东西，而墓碑写入失败留下的是“活着的成员，其工作已归继任者”——一种部分完成的生命周期，它的下一步是再调一次 `retire_member`，而不是丢掉一个任务。这个顺序与退役自身“先立碑”的规则（§4.4）相反，理由相同：会失败的那一步，必须失败在可恢复的那一半上。
- **只有替换会收养无主工作。** 退役产生无主行，替换消费它们，因此带 `replace` 的 `spawn_member` 会接手所有无主的未完成行，包括并非它造成的那部分。别的操作都不认领它们，任何读取都不会写入 owner。
- **交接只写所有权，绝不写状态。** 行在交接过程中保持 `open`；只有 `task_board` 的 `action: update` 才会把它变成 `done`，这也是让它不再被继承的唯一途径。
- **同一模型轮次里的两个工具。** 每次任务改动都是花名册表上的一次原子 `update`，与成员改动一样（§4.2），因此同一轮次里的 `task_board` 调用与替换会看到彼此的写入，而不是互相覆盖。
- **由定义启动的继任者也按一次性成员被清扫。** `replace` 的定义带 `ephemeral: true` 时，启动的继任者会在本轮结束后自行退役，于是这张矩阵刚刚交给它的工作在下一次清扫时失去所有者，而那次清扫报告的 `unowned`/`unowned_tasks` 正是这里给它的那些行（§4.3.3）。

#### 4.3.1 临时成员（P4-01）

临时成员是为一次性工作而生的：模型并行创建若干个，读取它们的输出，并期望它们自行离开花名册，而不必逐个调用 `retire_member`。

**这是记录上的属性，不是新相态。** `spawn_member.ephemeral: true` 会在成员记录上写入 `ephemeral: true`，并在子代理启动时写入 `startedAt`；每一行 `list_members` 都会报告 `ephemeral: true`，因此模型能看出哪些成员会自行离开。默认是 false，不新增相态，从不设置该标记的 profile 与之前完全一致。对临时成员调用 `message_member` 会**清掉该标记**：再次给它发消息就是在声明它不再是一次性的；这也是唯一一种“后续清扫会吃掉模型本想保留的工作”的情形。

**没有持久的完成事件，所以清扫必须自带证据。** 上面的通知表已经写明：活动中的子代理结束本轮时，什么持久变化都不会发生。安装版的子代理 seam（`dsh-subagent` 0.2.2-rc.1）把后代行的 `activity` 报成 `running` 或 `inactive`（`lib/index.js:2435`，`sessions.get(entry.id) === undefined ? "inactive" : "running"`），而 `inactive` 同样描述一个从未启动过的子代理，因此它本身证明不了“已完成”——只有 `running` 是可信的正面证据。插件因此要求它自己记录下来的证据：`startedAt`，在激活返回时写入，从未发布过的预留没有它；外加本地实时注册表（`liveStateOf`：`ctx.agents.get(childId)`）报该成员不再驻留。这两者合起来就是“它运行过、然后停了”——从未启动的成员与仍在运行的成员都会被留下。ADR 0013 记录了这个信号，以及为什么单凭 `activity` 不够。

**清扫是惰性的，且只有两个触发点。** 它在 `list_members`（模型回收结果的读取）与 `spawn_member`（名额重新变得要紧的那次扇出）的开头运行，别处都不运行。这两个操作本来就会重读花名册；没有插件自己的时钟，没有后台任务、定时器或模型调用。它先于触发操作自己的读取执行，因此 `list_members` 的结果里被清扫的成员已经是 `retired`，而 `spawn_member` 可以复用被释放的 target。当没有任何临时成员时，它立刻返回——不读子代理注册表，也不写任何东西。其余工具要么面向单个目标（`message_member`、`stop_member`、`retire_member`、`restore_member`、`compact_member`），要么只读实时状态而不写（`wait_members`），要么根本不碰成员（`handoff_template`），在那里清扫会变成一次结果里根本没报告的、不相干的退役。

**退役仍是同一套实现。** 被清扫的成员走的是与模型主动退役完全相同的 `retireMember`——排空、先立碑、移动产物、保留上限、宿主侧效果——它的墓碑记录 `retireReason: 'ephemeral member: its turn ended'`。清扫确实退役了东西时，触发操作的结果会加上 `swept` 与 `swept_targets`；什么都没退役时，结果与加这个特性之前逐字节相同。

四个事件对每个相态下的临时成员分别做什么：

| 相态 | 退役 | 发消息 | replace | 清扫 |
|---|---|---|---|---|
| `provisioning` | 排空（通常无事可做）并立碑；子代理发布后会被排空 | 按矩阵投递或拒绝；一旦受理就清掉标记 | 先启动继任者，再给这条预留立碑 | 从不——没有 `startedAt`，无从证明它运行过 |
| `active` | 正常退役协议 | 投递，并清掉标记：它不再是一次性的 | 正常替换交接 | 只在它不再驻留时退役；运行中的成员永不被清扫 |
| `retired` | 无操作，`reason: 'already-retired'` | 拒绝 `retired` | 正常替换，交接书来自墓碑 | 无操作 |
| `failed` | 受理；通常没有可排空的 | 拒绝 `failed` | 正常替换 | 无操作——它从未运行，记录保持可见 |

#### 4.3.3 成员定义在 spawn、replace 与 message 三处（v0.17.0）

定义只在它被点名的那一次 spawn 上被读取，之后它携带的每个字段要么落在记录上、要么落在活着的子代理上、要么哪里都不落。`name`、`label` 与 `prompt` 遵循 §4.6 的优先级规则；下表是其余每一个可接受字段，因为它们每一个都能让只写了文件、没读调用的人意外。每行一个字段，每个格子回答同样三个问题：该事件上文件贡献什么、调用能覆盖什么、效果是什么。事件就是 §4.3 已经命名的那三个：`spawn`（不带 `replace`）、`replace` 与 `message`（`message_member`）。

**`message_member` 从不读取文件。** 消息作用于已经启动的成员，因此定义在那里不贡献任何东西：消息还能触及的两个字段，是它记录的 assignment 与它清除的一次性标记，文件的其他字段在之后某次 `spawn_member` 为另一个成员读取它之前，都不会再被查询。

| 字段 | `spawn`（不带 replace） | `replace` | `message` |
|---|---|---|---|
| `assignment` | 文件：提供持久的 assignment；调用：调用上显式给出的 `assignment` 覆盖它；效果：记录带上它，`list_members` 报告它。 | 文件：**仅当前任没有记录过时**才提供；调用：调用上的 assignment 同时压过两者，而前任记录在案的 assignment 压过文件；效果：继任者被交接的是工作本身而不是角色的常驻语句，结果用 `definition.assignment`（`call`、`predecessor` 或 `file`）说明胜出者。 | 文件：读了也没用；调用：消息被受理后 `message_member.assignment` 替换记录在案的 assignment；效果：该成员的下一个继任者被交接的是新文本。 |
| `ephemeral` | 文件：把成员标记为一次性；调用：`ephemeral: false` 覆盖它；效果：惰性清扫在它跑过并停下后退役它（§4.3.1）。 | 文件：**作用于继任者**——文件描述的是角色，而 replace 启动的就是这个角色；调用：`ephemeral: false` 或 `ephemeral: true` 覆盖它；效果：一次性的继任者会在本轮结束时自行退役，它刚刚继承的工作——包括同一次调用交给它的任务——随之变为无主，并通过 `unowned`/`unowned_tasks` 报告（ADR 0017）。 | 文件：不贡献任何东西；调用：任何被受理的消息都会**清除**该标记；效果：该成员不再是一次性的，之后的清扫会放过它。 |
| `cwd` | 文件：提供工作目录；调用：`spawn_options.cwd` 覆盖它；效果：子代理就在那里启动，原样传入。 | 文件：提供它；调用：`spawn_options.cwd` 覆盖它；前任自己的 `cwd` **不会**被继承，因为记录不保存它；效果：继任者按文件或调用说的目录启动，可能与前任运行的位置不同。 | 文件：不贡献任何东西；效果：在该成员一生中固定——换目录需要新的 spawn 或替换。 |
| `provider` | 文件：提供它；调用：`spawn_options.agent_options.provider` 覆盖它；效果：该成员的模型请求走这个路由。 | 与 `spawn` 相同，且前任的路由不会被继承——它不在记录上。 | 不贡献任何东西；在该成员一生中固定。 |
| `model` | 文件：提供它；调用：`spawn_options.agent_options.model` 覆盖它；效果：选定的模型绝不会无声，`started_with` 会回显转发了什么。 | 与 `spawn` 相同；前任的模型不会被继承。 | 不贡献任何东西；在该成员一生中固定。 |
| `reasoning_effort` | 文件：提供它；调用：`spawn_options.agent_options.reasoning_effort` 覆盖它；效果：更换 provider 或 model 后省略它，会让新路由解析自己的默认值。 | 与 `spawn` 相同。 | 不贡献任何东西；在该成员一生中固定。 |
| `max_tokens` | 文件：提供它，不是正整数则拒绝；调用：`spawn_options.agent_options.max_tokens` 覆盖它；效果：限制该成员的输出 token。 | 与 `spawn` 相同。 | 不贡献任何东西；在该成员一生中固定。 |
| `agent_preset` | 文件：提供它；调用：`spawn_options.agent_preset` 覆盖它；效果：它决定成员的 preset、人格与工具集，profile 未声明的 id 是带类型的拒绝。 | 与 `spawn` 相同。 | 不贡献任何东西；在该成员一生中固定。 |

这些格子依赖的前提：

- **连续性正是替换的意义，而文件里的一个字段足以打断它。** `assignment` 规则就是 v0.17.0 的要点：在此之前，带 `assignment` 的文件会把每个继任者都交接成角色的常驻语句，而不是前任正在做的事，这同时推翻了 ADR 0009 与本插件「工作随人走」的主张。调用是 Lead 的明确表态，仍然优先；文件是「没有可继承之物」时的兜底。这一点调整的是 ADR 0018 第 4 点——它写的是全新 spawn 的合并规则，还没有把前任列为来源（ADR 0019）。
- **`ephemeral` 是文件在陈述角色，而它的后果被明说，不被藏起。** 一个被替换后、在本轮结束就自行退役的成员，正是这张矩阵存在的原因：替换刚刚转给它的任务，会在下一次 `list_members` 或 `spawn_member` 清扫它时失去所有者，而清扫的结果会点名这些任务（§4.3.1、ADR 0017）。想让继任者保住工作的 Lead，给它发一次消息（消息会清除该标记），或者在替换调用上传 `ephemeral: false`。另一条路是「在 replace 上忽略文件的 `ephemeral`」，它被否决了：定义**就是**角色，而一个一次性的角色不会因为第一位持有者被替换就不再一次性（ADR 0019）。
- **前任的 `cwd` 与模型路由不会被继承，也无法被继承。** 它们是启动选项，不是记录字段：`started_with` 是工具结果上的一张收据，不是持久状态（§4.2），所以继任者只拿到文件或调用的值。想让继任者待在前任目录里的 Lead，自己传进去。
- **交接矩阵（§4.3.2）不因以上任何一条而改变。** 不论文件怎么写，替换仍然在同一次调用里搬走前任的未完成任务；上表的 `ephemeral` 那一行只决定下一步由谁失去它们。

### 4.4 退役与替换

退役是一套协议而不是删除，因为成员的会话是持久的、工作可能做了一半。`retire_member` 按代码里的顺序做这些事：

1. **记下原因**——模型给出的 `reason` 写进墓碑的 `retireReason`。
2. **排空**——`ctx.subagents.drainChildren(lead, [childId])` 停掉子代理，释放它的激活名额与驻留。从未发布过的、或已经结束的子代理没有可排空的；两种情况都继续退役，因为生命周期事实由记录掌握。
3. **立碑**——记录转为 `retired`，带上 `retiredAt`、`assignment`、原因，以及下一步准备使用的回收站路径，并标记 `trashState: 'pending'`（没有可移动之物时直接是 `'none'`）；这一步发生在碰文件系统**之前**（§2.5）。在这里崩溃留下的是“退役记录 + 要么没移动、要么已进回收站的产物”；`pending` 表示无从确定，恢复会先去回收站找，因此两种情况都能收尾。
4. **移动产物并确认**——持久化会话移入插件的回收站目录，记录随后确认为 `trashState: 'done'`，并写上 `trashPath`、`originalPath` 与 `trashKind`。没有可移动的产物时，改由工作区归档隐藏会话，丢弃计划中的回收站字段，记录与返回结果都会说明这一点（`archived: true`、`trashState: 'none'`）。`archived` 与 `trashPath` 互斥：只有没发生移动时才会走归档分支。
5. **只在此时约束回收站**——成功移入过产物的那次退役，会从这个 Lead 的回收站目录里按最旧优先移除超出**生效上限**的条目；生效上限是 `apply` 解析出的 `trashLimit` 配置（默认 `DEFAULT_TRASH_LIMIT`，20），而不是代码里的常量；每个被移除的墓碑保留 `trashPath` 并把 `trashState` 置为 `pruned`（ADR 0011、ADR 0012）。候选只有目录名与墓碑都能解析的直接子项，`pending` 的移动计入上限但永不被剪除，而且只删本插件自己移入回收站的副本——平台没有会话删除 API，唯一官方的“藏起来”机制是可逆的工作区归档，它无法约束字节数。没有移动过产物的退役不会剪除任何东西。不存在定时器，也不存在读取时清理。
6. **隐藏**——宿主投影出口不再下发已退役 id，所有客户端因此丢掉该成员；花名册保留回收站路径以便手工恢复。
7. **报告**——返回结果带 `retired`、`drained`、`archived`、`trashed`、`pruned`（没有移除任何东西时为 0），有回收站路径时再带 `trash_path`；`pruned` 大于 0 时，消息会说明移除了多少产物、用的是哪个上限以及原因。重复调用是无操作，返回 `retired: true, drained: false, pruned: 0, reason: 'already-retired'`。

工作的持久陈述就是成员的 `assignment`：模型用 `spawn_member.assignment` 写入，用
`message_member.assignment` 保持最新；上限 1000 个字符，因此记录不会无限增长。

**替换。** `spawn_member` 带 `replace: <target>` 会为继任者合成一份简短、自足的提示词：继任者的名字、前任的 target 与 label、记录在案的职责、前任已离场这一事实、它未完成任务按 id 与标题的清单，以及按前任名字指向该 Lead 自有任务板的指针。任务板上的行是被**交接**过去的，不复制、不重复。之后它会对前任执行第 2–6 步。**同一次调用里先启动继任者、再退役前任**：启动失败则前任原封不动且仍然活着；退役失败则返回 `predecessor_retired: false` 与原因，再调一次 `retire_member` 即可收尾。目标已经退役时同样接受，由墓碑提供交接书。ADR 0009 记录了该顺序以及被否掉的替代方案；ADR 0017 记录交接本身。

**继任者按调用方为它点名的选项启动。** `spawn_options` 对替换的作用与对普通 spawn 完全相同；前任的活记录以及它日后的墓碑都不受影响。Harness 拒绝的启动——profile 没有声明该 preset id，或 provider 不具备所请求的能力——就是上文顺序已经覆盖的启动失败：前任保持活着，结果说明 `predecessor_retired: false`，失败的预留会被列出，便于重试时换一个已声明的 preset 或干脆省略该字段（ADR 0016）。

继任者拿到的是被继承的工作，而不是前任状态的副本：除非模型重新记录，继任者继承前任的
`assignment`，因此反复替换不会让记录一代比一代更薄。

**交接书的形状由 Lead 决定，被继承的工作由记录决定。** 反复替换成员的 Lead 用 `handoff_template`（§4.5）存一份模板，合成时就用它；从不保存模板的 Lead 得到内置形状。占位符是 `{successor}` 与 `{predecessor}`（两个 target）、`{label}`（前任的职责）、`{assignment}`（记录在案的职责）与 `{task_board}`（指向该 Lead 自有任务板的指针）。`{assignment}` 是必须的：省掉它，继任者只拿到前任的角色与任务板指针，却不知道继承了什么工作——而这正是交接的意义。模板在写入时就校验：未知占位符会被按名字拒绝，因此拼写错误不会以字面文本的形式进入子代理。继任者自己的任务始终追加在渲染结果之后，任何模板都无法把它丢掉。渲染出的这一段上限 2000 个字符，超过就拒绝而不是截断；上限只在存了模板时才量，这正是“没有模板的 profile 与 P4-02 之前逐字节相同”的原因。模板属于某个 Lead 的花名册记录，因此两个 Lead 不会共用一份，`list_members` 的行也永远不带它。

**任务板随交接书一起过去，并且有上限。** 交接书不是工作区快照：一个从 200 行长清单起步的成员，比只拿到五个 id 的成员更糟。因此合成会追加**一行**，按 id **和**标题点出前任的未完成任务——只给其中一样都不好用：继任者查不到的 id 要多一次往返，而只有标题又没法把任务标成完成——并且这一行有两重上限：最多 5 行、最多 600 个字符，后者相当于五条满长标题（`TASK_TITLE_MAX`，200）再加 id 的余量。任何一重上限过不去，整行就被丢掉，继任者仍拿到 `{task_board}` 指针句，也就是 P2-09 之前那个版本给出的交接书。因此当前任没有任何未完成任务时，交接书与旧版逐字节相同，并有测试钉住这一串——只有确实在途的工作才会以 id 与标题进入交接书，而且永远不含 `done` 行。

**已存模板保有自己的那一行。** 继承任务这一行追加在渲染结果之后、继任者自己的任务之前，因此模板既丢不掉它也重复不了它，而 `{task_board}` 占位符的含义和以前完全一样：指针。模板并不要求提到任务板——会提到的是默认形状。

**尚未实现、因此不作为行为描述。** 没有“成员自己写交接书”这回事，也没有交接书文件：向成员索要交接书要花一次模型往返，而需要交接时它往往正好无响应或已失败，所以交接书由记录与任务板合成。代码里也没有任何“用工作区核对职责或任务”的步骤——那是 Lead 的判断，插件只负责点出它存下的那些行。

### 4.5 模型侧接口

本插件只有 Host 半区，因此它拥有的每个操作都是工具（ADR 0008）。全部为 Lead 专属，`list_members` 行的 `target` 就是所有面向成员的工具接受的唯一选择器（`handoff_template` 不接受 target：它作用于 Lead 自己的记录）。行上的 `child_id` 是宿主自有列表展示的持久身份；它只被报告，不作为第二个选择器——否则七个工具都要同时支持它才一致，而 target 在可寻址成员中本来就唯一。Lead 判定刻意留有余地：没有父会话的活智能体就是根智能体，按 Lead 对待，因此一次失败的成员关系投影不会让所有工具失效。

| 工具 | 行为 |
|---|---|
| `spawn_member` | 占用基名的下一代次，并作为可续聊子代理启动；带 `definition` 时从随项目提交的成员定义启动，文件里的字段补齐调用省略的部分（§4.6）；带 `replace` 时，让继任者从交接书启动、把前任的未完成任务交给它，并在同一次调用里退役前任（§4.4、§4.3.2）。可选的 `spawn_options` 让成员用自己的 `cwd`、`agent_options`（`provider`、`model`、`reasoning_effort`、`max_tokens`）或 `agent_preset` 启动；省略的字段继承 Lead 的值——但改了 `provider` 或 `model` 却未给 `reasoning_effort` 时，新路由解析自己的默认值——而 `started_with` 报告的是插件转发出去的内容，不是子代理解析出的结果。Harness 拒绝的启动是带类型的结果（`started: false`，`reason` 说明出路），绝不是宿主错误；读不出来的成员定义也以同样的方式回答（ADR 0016、ADR 0018）。带 `ephemeral: true` 的成员会在运行过并停止后自行退役（§4.3.1），该次调用也会先清扫已经结束的临时成员。 |
| `list_members` | Lead 控制的每个成员与子代理：本花名册、收养的官方成员、收养的子代理后代（§4.5.1）。行带 `target`、`child_id`、相态、代次、标签、记录在案的 `assignment`、一次性成员上的 `ephemeral`、实时状态与 `compactable`；压力字段（`pressure_tokens`、`context_window`、`usage_ratio`）只在驻留时出现。读取会先清扫已经结束的临时成员，并在退役了成员时报告 `swept` 与 `swept_targets`——被清扫的成员留下未完成任务时，再加 `unowned`/`unowned_tasks`（§4.3.2）。 |
| `wait_members` | 对这个 Lead 成员的实时状态做一次有界等待：某个成员的 `agent/status` 在 `idle` ⇄ `running` 之间变化时返回，或超时后返回，并报告是哪个成员、变成了什么。超时默认 30 秒，超过 1 小时即拒绝；若没有 `running` 成员也没有 `provisioning` 预留，则立刻回答 `no_progress`，因为被阻塞的 Lead 无法唤醒空闲成员。它只观察调用之后的变化，绝不唤醒任何人（§4.5）。 |
| `message_member` | 给活着的目标投递一条消息，并可顺带替换其记录在案的 `assignment`；运行中的子代理在下一步看到，已卸载的可续聊子代理会冷恢复。给临时成员发消息会清掉它的标记，因此它不会被清扫。目标已退役或已失败时拒绝，`reason` 分别是 `retired` 或 `failed`；目标不存在则为 `missing`。当该名字的另一个代次还活着时，拒绝还会带上 `current_holder` 并在消息里说明。 |
| `stop_member` | 只取消目标当前轮，保留激活与收件箱；对已退役或已失败的目标按与 `message_member` 相同的带类型原因拒绝，并以同样方式携带 `current_holder`。 |
| `retire_member` | 排空、立碑、把会话产物移入回收站、执行每个 Lead 的保留上限并刷新宿主侧效果（§4.4）；结果报告 `pruned`，重复调用是无操作，返回 `reason: 'already-retired'`，此时若名字已被另一代次接手，结果会指出那个活持有者。它是一次没有继任者的退役，因此该成员的未完成任务会失去 owner，结果用 `unowned`/`unowned_tasks` 点出它们（§4.3.2）。 |
| `restore_member` | 把回收站里的产物移回，记录转回 `active`；结果会说明实际走了哪条分支，记录本来就处于活动状态时是无操作成功而不是报错，被剪除的墓碑则回答 `reason: 'pruned'` 且不触碰工作区；该名字的另一代次还活着时，拒绝会带上 `current_holder`。它不分配任何工作：`unowned`/`unowned_tasks` 报告仍在等待 owner 的未完成行（§4.3.2）。 |
| `compact_member` | 对驻留且空闲的目标调用 `ctx.compaction.compactNow(agent, signal)` 强制压缩一次，返回结构化结果而不是抛异常：`done`、`busy`、`not-resident`、`nothing-to-compact`、`failed`。 |
| `handoff_template` | 读取、保存或清除这个 Lead 的交接书模板：省略 `template` 读取已存的那份，给一个模板则在校验后保存，给空字符串则清除并回到内置交接书（§4.4）。每个 Lead 一份，写入时校验；已存的值一旦不再通过校验，读取会报告 `valid` 与 `problem` 而不是悄悄丢掉，合成则退回内置形状。 |
| `task_board` | 这个 Lead 自有的工作板：`create` 新建任务，`list` 读取整块板，`update` 设置任务的 `status` 与／或 `owner`（`owner: null` 表示清空），`release` 清掉 owner，`delete` 删除该行（§4.3.2）。一个工具配 `action` 枚举，而不是五个名字：五种操作共用同一种行形状与同一套拒绝说法，每个动作最多多带两个字段。任务 id 是 UUID，标题超过 200 个字符即拒绝，一个 Lead 最多 200 条任务；已存的行一旦标题不再通过读取规则，会带 `problem` 照常返回而不是被丢掉（§4.2）。`list` 会报告未完成任务数，以及其中无主的数量。 |

操作体在 `actions.js`；`index.js` 只保留参数校验、Lead 专属权限检查与工具结果 schema。替换刻意不新增工具：`spawn_member` 与 `message_member` 各多一个参数，而不是让模型为同一件事再学第三个名字（ADR 0009）。交接书的**形状**则多了一个工具，而不是 `spawn_member` 的又一个参数，因为一个持久偏好不该作为创建成员的副作用而改变（ADR 0015）。任务板是一个工具而不是五个，理由正相反：五个名字会让接口为同一种行形状翻三倍（ADR 0017），而它的两件事——工作板与交接——以同一套词汇到达模型。

官方花名册的 spawn、等待与任务工具已由 bundle 补丁禁用（P2-07，v0.14.0）——`spawn_teammate`、`wait_agent` 与 `team_task_*` 工具——本插件的工具就是 Lead 用来操作花名册的那套界面；补丁条目本身写明了它移除了什么、代价是什么（`cordis.patch.yml`）。官方 `agent-team` 服务发布的三件工具仍留在列表里：`list_agents`、`send_message`、`interrupt_agent`，因为禁用那条服务行会连收养、成员判定与投影过滤一起带走。被禁用那行拥有的工具在这里都有替代，`wait_agent` 也不例外：`wait_members` 监听的是 Harness 的 `agent/status` 事件，并按本 Lead 花名册上的子会话 id 过滤。官方的 `agentTeams.waitForChange` 同样由这个事件驱动，但只对它自己的成员判定能解析出的 Agent 生效，而通过 `ctx.subagents` 启动的成员不在它的日志里——所以这里的等待是本插件自己的监听，而不是对那项服务的一次调用。

#### 4.5.1 收养就是控制面

`ensureAdopted`（`actions.js`）是这套接口完整可用的原因：它读取官方团队花名册与子代理注册表，把每个不认识的子代理记成成员；从官方花名册收养的成员沿用官方名字，相态从 `active` 开始。注册表读取是 `ctx.subagents.listDescendants(rootSessionId, signal)`（安装版 seam `dsh-subagent` `0.2.2-rc.1`，`lib/index.js` 第 3181–3183 行委托到第 2380–2446 行）；子行是 `{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`，`kind: 'diagnostic'` 行跳过；有 label 的子代理按与官方名字相同的规范化规则命名，没有 label 的命名为 `subagent-<id>`。收养按子会话 id 幂等，而让幂等成立的正是退役记录这块墓碑——排空子代理不会删掉父代持久 catalog 里的那一行。消息投递通过 Lead 的直接子代权限寻址，而退役即使排空被拒绝也会立碑。出厂深度上限是 1，所以每个后代都是直接子代；更深的树（只有调高深度上限才可能出现）会被消息投递拒绝，但仍可退役。

### 4.6 成员定义（v0.16.0）

成员过去只作为一种工具调用存在：提示词、标签与 assignment 只活在那次调用和 Lead 的花名册记录里，于是团队无法被评审、版本化或共享，同一个「reviewer」每个会话都要重打一遍。定义把成员从调用里搬到磁盘上——每个成员一个 markdown 文件，放在 Lead 工作目录下的 `team/`，随项目一起提交——花名册则仍是运行时状态（ADR 0018）。

**路径。** `<Lead 工作目录>/team/*.md`，由 `workingDirectory` 服务解析：`ctx.get('workingDirectory').ensure(leadAgent, signal)`（§5）。这与安装版 spawn seam 解析相对 `request.cwd` 用的是同一个服务、同一个方法，所以定义读到的目录，正是 `spawn_options.cwd` 相对解析的那个目录。该服务是可选的，与 `compaction` 一样用 `ctx.get` 读取；profile 没有挂载它、或它的 `ensure` 抛错，都是带类型的拒绝（`reason: "working-directory-unavailable"`），而不是猜一个目录。

**文件。** 第 1 行 `---`、一段扁平 frontmatter、再一行 `---`，其后的 markdown 正文就是成员的提示词。可接受字段恰好是 `spawn_member` 本来就有的输入：`name` 与 `label` 必填，另有 `assignment`、`ephemeral`、`cwd`、`provider`、`model`、`reasoning_effort`、`max_tokens` 与 `agent_preset`。文件*名*不是身份——定义自己声明 `name`，它也正是 `spawn_member.definition` 查找用的键——调用上没有对应物的字段不在范围内。

**子集是写下来的，不是估出来的。** `key: value`，一行一对，不允许缩进；值可以是裸值，或两端加引号，不解释任何转义；允许空行与 `#` 注释。嵌套、列表、块标量（`|`、`>`）、锚点与别名（`&`、`*`）、合并键（`<<`）、流式集合（`[...]`、`{...}`）、重复键、未知字段、无值键，以及缺少 `name`/`label`，都会连文件路径与行号一起被拒绝；未知字段的那句话还会列出可接受字段集。这里没有 YAML 库，因为 bundle 不导入 Node 内置之外的任何东西（ADR 0002）：本仓库的解析器就是规范，它不实现的写法一律拒绝，而不是被误读。

**优先级：调用侧优先，replace 时记录压过文件，且结果会说明这一点。** 传给 `spawn_member` 的每个字段都按字段覆盖定义里的值，`agent_options` 内部也一样；返回结果中的 `definition` 对象给出文件名、取自文件的字段（`from_file`）以及被调用替换掉的字段（`overridden`）。`prompt` 是一个例外：正文是成员的常驻提示词，调用里的 `prompt` 是这次的任务，所以调用文本追加在正文之后，`definition.prompt` 报成 `file` 或 `file+call`。另一个是 `assignment`，它还有第三个来源：`replace` 时，前任记录在案的 assignment 压过文件的常驻语句，因为继任者继承的是工作而不是角色（ADR 0009、ADR 0019），`definition.assignment` 报出 `call`、`predecessor` 或 `file` 中哪一个提供了它——文件只在没有可继承之物时生效。文件里的东西绝不会被悄悄丢掉——「模型以为自己覆盖了定义、其实没有」正是这份回报要防的失败。

**一个坏文件不会藏起其他文件。** 扫描收集能读的，并报告读不了的：成功 spawn 上的 `definition.problems`、拒绝上的 `problems`，每行是 `{path, line?, problem}`。同一个名字被两个文件声明时两边都不可用，因为悄悄挑一个会让另一个文件的修改不可见。名字未知时回答 `definition-not-found` 并带 `available`（同一次扫描能用的名字）；若目录里同时还有被拒绝的文件，则回答 `definition-invalid`，因为那名字可能就声明在里面。这与存下的任务遵循的规则相同（ADR 0017）：一条坏记录不能藏起其余记录。

**上限是拒绝。** 单文件 16 KiB（`DEFINITION_FILE_MAX`），单次扫描 64 个文件（`DEFINITION_LIMIT`），绝不截断、绝不部分读取。大小上限按文件计，所以超大定义被拒绝而邻居照常可用；数量上限按目录计，所以超量目录整次扫描被拒绝，而不是只服务一个残缺子集。拒绝时不预留任何东西——不写成员记录、不启动子代理——所以修好文件重试仍用同一个名字。

**接口只有一个参数。** `spawn_member.definition` 就是整个特性：没有创建/更新/删除工具，因为版本控制与编辑器才是让文件优于工具的原因，模型用自己的文件工具写这些文件。`spawn_member` 的结果 schema 是二分支 `oneOf`——成员行，或定义拒绝——因为拒绝是一种回答而不是宿主错误，这也正是 ADR 0016 对「被拒绝的启动」已经定下的规则。

## 5. 使用的 Harness 扩展点

| 需求 | 机制 |
|---|---|
| 启用一条官方但被关闭的行 | bundle 补丁 `- id: <row>` 配 `disabled: false` |
| 按 Agent 生效的行为 | 在 `agent/created` 里注册到 `agent.ctx`，在 `agent/disposed` 时卸载 |
| 注册工具 | `agent.ctx.tools.register(definition)`，定义用规范 JSON Schema |
| 上下文压力 | `ctx.tokenMeter.contextPressure(session)` |
| 压缩 | `ctx.get('compaction').compactNow(agent, signal)` |
| 成员判定 | `ctx.agentTeams.tryMembership(agent)` |
| 子代理生命周期 | `ctx.subagents.startActivation`、`sendMessage`、`interrupt`、`drainChildren` |
| 让成员用自己的目录、模型路由或 preset 启动 | `ctx.subagents.startActivation` 上的 `request.cwd`／`request.agentOptions`／`request.agentPreset`；受 provider 声明能力的约束，而工具限制除了 agent preset 没有别的途径（§4.1、ADR 0016） |
| 列出全部子代理后代 | `ctx.subagents.listDescendants(rootSessionId, signal)`；行带 `id`、`mode`、`label?`、`parentId`、`depth` |
| 得知某个子代理已停止 | `subagent/end`（一次运行结算时发布）以及 `agent/status` 的 `idle` 边沿；两者都不持久，所以临时成员清扫仍自带证据（§4.3.1、ADR 0013） |
| 等待成员的实时状态 | 在插件自己的上下文里 `ctx.on('agent/status', ({ agent, status }))`，并按本花名册持有的子会话 id 过滤；该分发带作用域过滤，而未加作用域的监听者会被放行（§4.5） |
| 插件自有持久状态 | `ctx.storageDomain` 域，而不是会话事件（ADR 0003） |
| 解析 Lead 的工作目录，以及成员定义读取的 `team/` | `ctx.get('workingDirectory').ensure(agent, signal)`——与 spawn seam 解析相对 `cwd` 用的是同一个服务与方法；该服务可选，所以没有它的 profile 会拒绝定义 spawn，而不是猜一个目录（§4.6、ADR 0018） |
| 隐藏产物移不动的会话 | `ctx.workspaceRegistry.archiveSession`／`unarchiveSession`（可逆，不删除；退役与恢复的兜底分支） |
| 让客户端丢掉已退役成员 | 包装 `sessionController` 的列表／投影／流出口（ADR 0004） |
| 补偿官方花名册名额 | 补丁旧花名册的 `maxMembers` getter 与 `spawn`（ADR 0004） |
| 把退役会话挪开 | `ctx.get('sessionPersistence').stat(id).location.path` + rename 进回收站 |

## 6. 风险与边界

- **没有应用内视图。** 花名册只通过 `list_members` 对模型可见，没有设置页。宿主自有的子代理选择器仍照旧渲染，只是少了已退役 id（ADR 0008）。
- **官方花名册仍是它创建的那些成员的来源。** 它的 spawn、等待与任务工具被禁用（P2-07），但服务没有，因为收养与投影过滤需要它：`list_members` 会报出这些成员，本插件保留它们的墓碑，而那项服务的三件模型侧工具（`list_agents`、`send_message`、`interrupt_agent`）仍然注册着。
- **官方任务板已不可达。** Lead 的工作在自有任务板上（§4.3.2）；官方任务板上的行本插件读不到，而能读到它们的工具已在 v0.14.0 被禁用。退役既不转交也不取消认领它们：想要这些行的 Lead 在 `task_board` 上重新创建（ADR 0017）。
- **恢复有界，平台记录没有真正抹除**——已退役成员的会话在这个 Lead 的回收站未超上限前都可恢复；被剪除的产物字节则永久消失，记录会如实说 `pruned` 而不是假装还在。官方 catalog 仍知道该成员存在过，因为平台从不删除它自己的东西（ADR 0011）。退役是我们花名册里的生命周期事实，不是平台的删除。
- **转发的目录、路由与 preset 由调用方决定，插件只负责转发。** 在 Harness 解析之前，插件无法判断某个 `cwd` 是否可用；在注册表查询之前，它也无法判断某个 preset id 是否存在，因此两处拒绝都是把 seam 的答案翻译成带类型的结果，而不是一个可能与 Host 判断不一致的预检（ADR 0016）。
- **Harness API 漂移**——本文点到的每个 Service 都来自已安装的 asar，版本会变；一次 Harness 升级就能让本文作废，而本仓库什么都没改。安装版的子代理 seam 与公开源码树不是同一代：公开树有成员 `name` 和 `resolveName`，安装版没有。采信任何公开示例之前，先读安装版的 `lib/index.js`。
- **交接质量取决于记录在案的职责与任务板上的行**——插件读不到官方任务板，也读不到前任的对话，因此继任者的交接书只能由记录与自有任务板合成。一个从未记录过 `assignment`、任务板上也没有未完成行的成员，交接出去的就只是角色与任务板指针，而不是摘要。
- **成员定义是插件只读的文件。** 它无法判断一份定义是否过期、其提示词是否符合 Lead 心里的工作，也无法判断同一个工作目录下的 `team/` 是否被两个 Lead 共用；那是项目的版本控制要管的事，不是本插件的职责。它能保证的事情更窄、也更可核对：调用方能用的定义，恰好是调用那一刻 `team/` 下可读的那些 `.md` 文件；读不出来的文件会连路径与行号一起被拒绝，而不是只应用一半（§4.6、ADR 0018）。
- **压缩是 profile 级的**——启用后端会改变该 profile 内每个会话的行为。这是把官方特性打开，不是自研代码，但它并不只作用于本插件的成员。
