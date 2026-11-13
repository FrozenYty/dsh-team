# 架构

> Owner: @FrozenYty · Revisit when: Harness 升级改动了本插件使用的某个 Service

本文说明插件是什么、各版本交付了什么、它建立在哪些 Harness 底座之上、对外发布哪些接口，以及风险与边界。原先只因相邻而留在这里的主题各自独立成文：成员的一生见 `docs/member-lifecycle-zh.md`，工作板见 `docs/task-board-zh.md`，交接书及其模板见 `docs/handoff-zh.md`，存储记录与其保留策略见 `docs/roster-storage-zh.md`。设计背后的决策记录在 `docs/adr/`；本文描述结果与分层。

## 1. 插件是什么

一个 DeepSeek Harness **profile bundle**。安装它会做三件事：

1. 选中一条 profile 默认关闭的官方插件行（`compaction-basic`）；
2. 插入一个我们自己写的 Host 插件（`dsh-team`）；
3. 禁用官方那条面向模型的团队工具行（`tool-agent-team`），它的工具由本插件顶替（P2-07、§2.3、§5）。

没有构建步骤，也没有运行时依赖：官方行由已安装的 Harness 自己解析，我们的入口不导入任何东西（ADR 0002）。bundle 只有 Host 半区：没有浏览器半区（ADR 0008）。

官方那条团队**服务**行（`agent-team`）刻意不动：收养（§5.1）与投影过滤（§2.4）都要读它。

插件在 v0.10.0 由 `dsh-team-roster` 改名而来，而它的存储域（`team_roster`）、补丁行 id（`team-roster`）与回收站目录（`~/.dsh/team-roster`）刻意保留了旧拼写（ADR 0014）。

它唯一的可调项是每个 Lead 的会话回收站上限，由 bundle 自己补丁行上的 `trashLimit` 字段承载（`- id: team-roster`，`config: { trashLimit: <整数> }`）。`apply(ctx, config)` 在注册任何东西之前先解析它：字段缺失取 `DEFAULT_TRASH_LIMIT`（20），至少为 1 的整数原样采用，其他值则让加载失败，报错信息里点名字段、看到的值与最小值（ADR 0012）。本入口刻意不声明 `Config` schema，因此 Host 的 Config 提供方仍报 `absent`：该投影只接受原生 Schemastery 图，而零导入的 bundle 无法提供，字段改由 `apply` 校验。

## 2. 交付了什么、什么时候

一张简短的对应表，不是变更日志：每条只说明该版本新增了什么，以及今天由哪一节负责。

- **v0.1**——在 profile 级启用压缩后端（§2.1）与上下文工具（§2.2）。
- **v0.2**——自建花名册：spawn、发消息、停止、退役与恢复（§5），退役协议及其交接（`docs/member-lifecycle-zh.md` §3），把产物移入回收站（`docs/member-lifecycle-zh.md` §4），以及退役会刷新的两个可选宿主侧效果（`docs/architecture-zh.md` §2.4）。
- **v0.4**——只面向模型的接口（ADR 0008）：设置面板与其 HTTP 桥被删除，收养范围扩大到 Lead 控制的每个后代（§5.1）。
- **v0.7–v0.8**——每个 Lead 的回收站有上限，上限是 bundle 的 `trashLimit` 配置字段（`docs/member-lifecycle-zh.md` §4、ADR 0011、ADR 0012）。
- **v0.9**——临时成员：创建时可标记为一次性，模型本来就会调用的那些花名册操作会在它运行过并停止后，用惰性清扫把它退役（`docs/member-lifecycle-zh.md` §2、ADR 0013）。
- **v0.10**——改名：包名、补丁行的 `name` 与显示标题变为 `dsh-team` /「团队」，而存储域、补丁行 id 与回收站目录保留改名前的名字（§1、ADR 0014）。
- **v0.11**——每个 Lead 一份可复用的交接书模板，由一个工具写入，替换交接用它合成继任者的交接书（`docs/member-lifecycle-zh.md` §3、`docs/architecture-zh.md` §5、ADR 0015）。
- **v0.12**——成员可以用自己的 cwd、模型路由或 agent preset 启动；Harness 拒绝的启动变成带类型的结果；陈旧 target 的拒绝会指出该名字现在的活持有者（§4、`docs/member-lifecycle-zh.md` §1、§3、`docs/architecture-zh.md` §5、ADR 0016）。
- **v0.13**——插件拥有的是工作本身，而不只是成员：任务板放在 Lead 的花名册记录上，替换会把前任的未完成任务交给继任者，而没有继任者的退役会让这些任务变为无主并点出它们的 id（`docs/roster-storage-zh.md` §1、`docs/task-board-zh.md` §2、`docs/member-lifecycle-zh.md` §3、`docs/architecture-zh.md` §5、ADR 0017）。
- **v0.14**——官方团队工具行退役：bundle 补丁禁用 `tool-agent-team`，于是那行的 `spawn_teammate`、`wait_agent` 与 `team_task_*` 工具不再注册，Lead 由本插件自己的工具服务。被保留的 `agent-team` 服务还发布三件模型侧工具——`list_agents`、`send_message`、`interrupt_agent`——它们仍在（§1、§2.3、§5、§8）。
- **v0.15**——阻塞式等待回到本插件自己的接口：`wait_members` 监听 Harness 的 `agent/status`，范围是本 Lead 花名册上的子会话；这件事原本由被禁用那行的 `wait_agent` 覆盖，而官方服务看不到这些成员（§5）。
- **v0.16**——成员可以定义在磁盘上：`spawn_member.definition` 读取 Lead 工作目录下 `team/` 里带扁平 frontmatter 的 markdown 文件，调用自己的参数优先于文件内容，结果会说明每一部分来自哪里（§5、§6、ADR 0018）。
- **v0.19**——团队作用域补上这套划分的另一半：成员定义旁边可以有一个可选的 `team/team.md`，正文就是交接书模板。生效模板依次取自该文件、记录里存下的模板、内置形状；读取形式会报告实际生效的来源，而文件存在时 `handoff_template` 的写入与清除都会被拒绝（`docs/member-lifecycle-zh.md` §3、`docs/architecture-zh.md` §5、`docs/handoff-zh.md` §2、ADR 0021）。
- **v0.20**——成员作用域拿到任务正文本就该有的那次读取：`list_my_tasks`，一件注册在成员 Agent 上的只读工具，只返回 `owner` 正好是该成员自己 target 的行。Lead 的工具集不变，工作板仍然只有一个写入者，而交接书里的 `{task_board}` 指针改为指向本插件自己的任务板与这件工具，而不是官方任务板（`docs/member-lifecycle-zh.md` §3、`docs/architecture-zh.md` §5、§5.2、ADR 0022）。
- **v0.22**——成员用启动它的那个会话的 API 启动：`spawn_member` 解析 Lead 当前的 `provider` 与 `model` 并转发，把路由记在成员记录上，`list_members` 则标出路由已不再是 Lead 当前路由的成员。任何解析失败都是被记录下来的兜底，而不是一次失败的 spawn；`reasoningEffort` 从不转发（§2.5、`docs/roster-storage-zh.md` §1、`docs/architecture-zh.md` §5、ADR 0024）。
- **v0.24**——三个宿主钩子改为在它们所包装的服务存在时才安装，而不是在插件加载时安装，因此一条早于 Web 层激活的行不会再让该能力在整个进程生命周期里丢失；官方 `list_agents` 读取也会丢掉已退役成员；`list_members` 报告 `host_hooks`，于是缺席的钩子是一个有类型的答案（§2.4、§5、ADR 0025）。
- **v0.25**——成员的生存期在 spawn 调用上声明：`standing` 是角色，永不自动退役；`one-shot` 是扇出场景，只有“跑过、已停下、且不拥有任何 `open` 行”三者同时成立时，才由惰性清扫退役。工作板只能否决清扫、永不触发清扫；退役一个 standing 成员必须带回本人的原话；消息只会重新打开一次性成员，而不会改写它的声明；定义文件从此不能声明生存期（`docs/roster-storage-zh.md` §1、`docs/member-lifecycle-zh.md` §2、`docs/architecture-zh.md` §6.1、§5、§6、ADR 0026）。
- **v0.25.1**——同意门槛收窄到“这个 standing 成员还带着什么”：记录在案的 assignment、本 Lead 工作板上的一条 `open` 行、或它被反复交派的证据。三者都没有的 standing 成员属于清理，Lead 只要写一个 `reason` 就能一次调用退役；两种拒绝各自说明是哪条规则挡住了调用（`needs-confirmation` 带 `carries`，或 `needs-reason` 带 `carries: []`），而第三条依据所依赖的反复交派计数从这时起对每个成员都写（`docs/roster-storage-zh.md` §1、`docs/member-lifecycle-zh.md` §2、§3、`docs/architecture-zh.md` §5、ADR 0026）。

### 2.1 启用压缩

profile 把 `compaction-basic` 置为 `inactive`，所以没有任何东西在压缩，每个智能体——Lead 和所有成员——都会一路涨向模型窗口。bundle 把该行覆盖为 `disabled: false`。这个后端注册的是不带作用域的 `agent/pre-step`、`agent/request`、`agent/request-error` 监听器，因此进程内每个 Agent 都被覆盖，包括子代理。

本机 DeepSeek 路由的默认值（窗口 1,048,576，输出预留 256,000，headroom 65,536）：自动压缩在
`floor(min(窗口 × 0.8, 窗口 − 输出 − headroom))` = 727,040 tokens 触发，按 `窗口 − 输出` 的 16% 原样保留最近内容。要调，就在更高层补丁里对同一行给一个 `config` 覆盖。

`command-compact`（`/compact`）刻意**不**启用：它需要 `commands` 服务，而本 profile 同样没有挂载，所以即使启用该行也只会停在 `absent`。

### 2.2 上下文工具

上下文工具在 v0.1 交付；它们现在的行在 §5，接口由那一节负责。每个 Lead 专属工具都注册在 Team Lead 的确切 Agent 上下文上（`agent/created`），并在 `agent/disposed` 时卸载。不遮蔽任何官方工具名，也不写任何会话事件。

`member_context` 存在于 v0.1，已移除：它的行与 `list_members` 重复，而且读的是官方花名册而不是本插件的。

实测到的限制塑造了后续设计：本地子代理空闲即被卸载，而 `compactNow()` 要求 Agent 驻留且空闲。因此已完成的成员无法按需压缩；可行路径是用消息唤醒它，让自动压缩在它的下一步运行。

### 2.3 自建花名册工具

自建花名册及其工具在 v0.2 交付。工具接口由 §5 负责，退役协议由 `docs/member-lifecycle-zh.md` §3 负责，收养由 `docs/architecture-zh.md` §5.1 负责，而这些工具读写的那条记录由 `docs/roster-storage-zh.md` §1 负责。

收养（§5.1）让 `retire_member`、`message_member`、`stop_member` 对本插件从未创建过的子代理同样有效——正是以前完全不可见的那批。一次性（one-shot）子代理同样会被收养，可停止、可退役；它不能冷恢复，所以 `message_member` 只在它驻留时可送达。

记录存在一个以 Lead 会话 id 为键的 `storageDomain` 域里（ADR 0003）。命名规则：代次 1 用裸名字；代次 2 起用 `<base>-g<N>`，因此继任者绝不会与已退役的名字相撞。退役后再用同一个基名创建，就是替换操作：`probe-a` 退役、`probe-a-g2` 启动，两条记录都在。

官方团队花名册与本花名册不再呈现两套 spawn、等待与任务工具：从 v0.14.0 起，补丁禁用官方的 `tool-agent-team` 行（P2-07），因此 `spawn_teammate`、`wait_agent` 与 `team_task_*` 工具不在 Lead 的工具列表里，唯一的列表是 `list_members`。官方花名册的**服务**仍然挂载，所以 `list_members` 照旧报出它创建的成员——再加上收养的全部后代与本插件启动的成员——也是那项服务发布的三件模型侧工具 `list_agents`、`send_message`、`interrupt_agent` 仍在该列表里的原因：禁用服务行会连收养、成员判定与投影过滤一起带走。

**工作本身从不并存**：从 v0.13.0 起，替换交接的是本 Lead 自有任务板上的行（`task_board`），它存放在花名册记录旁边，插件的交接不再读取、也不再指向官方任务板（`docs/task-board-zh.md` §2）。官方任务板上已有的行不迁移，本插件也读不到——而从 v0.14.0 起，能看到它们的工具也已消失，所以想让它们回到自有任务板上，就由 Lead 重新创建（ADR 0017）。

### 2.4 宿主侧效果

三个效果让退役对客户端可见、让本插件的成员出现在官方团队面板与官方 `list_agents` 工具里，并让官方的成员名额重新可用。每个效果都通过 `ctx.inject` 挂在自己所包装的服务上，所以在本插件激活**之后**才发布的服务——`sessionController` 就是常态，它需要 Web 层——仍然能装上；每个效果都在插件卸载时精确还原，且都不写 Lead 会话（ADR 0004、ADR 0023、ADR 0025）。

| 效果 | 机制 | 宿主形状缺失时 |
|---|---|---|
| 投影过滤 | 包装 `sessionController.list`／`projections`／`control`／`follow`；先从 `subagentCatalog` 与 `agentTeam` 帧里摘掉已退役 id，再把该 Lead 的活成员追加到同一个 `agentTeam` 值上 | 钩子等待服务，并报告 `panel_filter: absent`；退役仍生效，客户端仍显示该成员，但看不到本插件的成员 |
| 官方花名册读取 | 替换 `agentTeams.listMembers`，同步丢掉 id 属于已退役子会话的行，于是官方 `list_agents` 工具不再返回它们 | 报告 `roster_filter: absent`；`list_agents` 仍显示已退役成员 |
| 名额补偿 | 替换旧花名册的 `maxMembers` getter 并包装 `spawn`，在一次 spawn 期间按发起 Lead 的退役数临时抬高上限 | 报告 `slot_credit: absent`；退役仍生效，官方名额仍被占用 |

三个效果共用同一份退役 id 集合。`retire_member` 与 `restore_member` 在写记录的同一个调用里使它失效，所以退役不会卡在两秒缓存后面；读取失败时保留上一份可用的集合，并报告 `tombstone_read_failed`——第一版是清空集合、把所有行原样下发。投影过滤的活成员直接同步读花名册表：它们随 spawn 变化，缓存只会多出一段陈旧窗口；官方花名册读取同理，因为调用方不 await 就直接 `.map` 数组，缓存或异步都会让答案陈旧或改变返回类型。

**装没装上属于工具表面的一部分。** `list_members` 总是返回 `host_hooks`，并在该工具的输出 schema 里声明：每个钩子是 `installed` 还是 `absent`、装上的过滤器当前摘掉多少个墓碑 id（`stripped_ids`）、上一次墓碑读取是否失败，以及一条 `message`，指出缺席的钩子和它需要的服务。于是一个永远装不上的钩子是一个有类型的答案，而不是一个没有解释的空面板（ADR 0025）。

#### 2.4.1 面板覆盖层：插件可以在哪里写，面板又读什么

官方团队面板（中文界面里的**成员**与**共享任务**）渲染 `projectionsBySession[lead].values.agentTeam`，也就是 Lead 会话团队折叠的线格式视图。那个折叠只听得见官方花名册追加的 `team/member` 与 `team/task` 事件，所以通过 `ctx.subagents` 启动的成员在那里不可见。投影过滤因此在同一组四个出口上做第二件事：把该 Lead 的活成员追加到即将发出的副本里，并且只合成严格线格式所要求的字段。

| 覆盖层写入 | 面板如何读取 | 来源 |
|---|---|---|
| `id` | 行 key 与成员的会话身份：模型查询、运行状态，以及点击打开该成员的会话 | 花名册记录上的 `childId` |
| `name` | 行标签 | 面向模型的 target（`reviewer`、`reviewer-g2`） |
| `role: 'teammate'` | 面板不直接读；严格线格式要求它 | 合成 |
| `phase: 'active'` | 该会话正在运行则显示“运行中”，否则显示“未运行” | 记录为 `active` 且带子会话 id |

**插件可以在哪里写**正是这张表的要点：只能写**即将发出的副本**。每个发布点都会先用 `wire.viewSchema.parse` 校验这个值，而该解析会构造新对象，所以改它既到不了投影保存的状态单元，也追加不了会话事件。它不能写日志：成员相态封闭为 `provisioning | active | failed`，任何离开终态的转换都会抛错，而投影会把这次抛错记成永久 `failure`（§3、ADR 0001）。已退役成员根本不写入——行从值里消失，面板就少画一行——因为线格式枚举里没有“已退役”的诚实写法（ADR 0023）。值里已经存在的 id 原样保留，所以覆盖层从不重复、改名或改角色。

面板的**共享任务**那一半没有覆盖。一个任务视图需要本插件任务板没有的十个字段（`revision`、`blockedBy`、`writeScopes`、`ownerName`、`ready`、`writeScopeWarnings` 等），而一行成员只需要四个；那是下一步，不是这次（ADR 0023）。

### 2.5 成本与模型路由

**路由由插件说明，掉队的成员由插件报出来。** `spawn_member` 从 `caller.session.requestHeader()?.config`
解析调用方 Lead 当前的 provider 与 model——这正是 seam 自己的继承来源
（`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:49-62`）——并把它作为激活请求的 `agentOptions`
转发，因此子代理用启动它的那个会话的 API 启动，说出来的是插件而不是 seam 的隐式兜底（ADR 0024）。
调用方给的 `spawn_options.agent_options` 仍然逐字段优先，而调用方没给的那一半由同一次读取补全，
这样记录在成员上的路由就是子代理真正运行的完整路由。**`reasoningEffort` 从不转发**：seam 只在它解析
出的路由与父路由不同时才丢掉父会话的 effort（`:88-90`），而转发父会话自己的路由恰恰是“没变”的那种
情形，所以 Lead 的 effort 无需发送也会在合并中保留下来；官方工具那条路由预检不在这条路径上
（`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`），因此强塞一个该路由不支持的 effort，会在成员
已经被记为启动之后才让子代理的第一条请求失败。

**每一次解析失败都是兜底，而不是失败。** 读不到会话请求头（`no-session-route`）与 provider 没有声明
`agentOptions`（`capability-absent`，能力门在 `@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`）这两种
情况都不转发任何东西，把成员的路由记为 `source: 'inherited'` 并带上原因，然后交给 Harness 按本版本之前
的方式继承。原因之所以记下来，是因为这两种兜底是不同的运维事实，而其中只有一种与这份 profile 的配置有关。

成员的路由在启动时记录、在读取时比较：`list_members` 给每一行报出 `route`，并在成员的路由不是 Lead 当前
路由时标出 `route_stale: true` 与一句 `route_note`。活的成员无法被改路由——它的路由就在自己已记录的
`request/header` 里——所以补救办法是一次替换：继任者在当前路由上启动，并在同一次调用里接手前任的未完成
工作（`docs/member-lifecycle-zh.md` §3、ADR 0024）。

Session 级路由白名单属于官方工具（`@deepseek-ai/dsh-tool-subagent/lib/index.js:89-96`），本插件不使用它：
这里转发的是该会话已经在发请求的路由，因此它是被证明过的而不是被提议的，不需要预检。实测到的图景——
60 份会话日志里有 18 份在切到中转站之后仍停在 `deepseek-official/deepseek-flash`，其中数份是成员——正是
本节要回答的问题。

bundle 自己不发起任何模型调用，它启用的 `compaction-basic` 行按会话自己的路由做摘要（`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`，§2.1）。实测到的例外在本插件之外，是网页搜索：基础 bundle 的补丁选中 `searchProvider: deepseek-official`（`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`），而 `dsh-web-search-deepseek` 钉死了自己的端点与模型（`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`、`:319-320`），并要求回答里有 `web_search_tool_result`（`:61-62`）。任何会话路由都到不了它；profile 要么禁用那一行，要么把它指向真正执行原生搜索的端点。面向用户的说法在 `docs/routes-zh.md` 里。

## 3. 为什么不扩展官方花名册

官方花名册是 Lead 会话只追加日志的折叠。成员相态为 `provisioning | active | failed`；投影拒绝任何离开终态的转换，而被拒绝的事件会记成永久 `failure`，使该 Lead 的 Team 服务失效。因此伪造一条“已退役”记录不会安全失败。`maxMembers` 检查的是一个永不收缩的列表，名字永不复用，上游重构也仍在延后删除。

完整论证与被否掉的替代方案见 ADR 0001。

## 4. 底座：Harness 提供了什么

成员是通过 `ctx.subagents.startActivation(...)` 创建的普通子代理，它已经提供可续聊的子代理、收件箱消息、打断、排空、冷恢复和实时并发上限。插件只拥有 Harness 不提供的部分：花名册、它的生命周期，以及由此产生的模型侧工具。

安装版的 seam 是 `dsh-subagent` **0.2.2-rc.1**，与公开源码树并非同一代。它的激活请求是：

```
{ provider, label, request: { prompt, parent, cwd?, agentPreset?, agentOptions?, outputSchema?, maxDepth? },
  signal, delivery, childId? }
```

没有 `name` 字段，也没有 `resolveName`／`namesOf`。因此名字属于我们：插件生成一个 UUID `childId` 传给 `startActivation`，把 name→childId 的映射放在自己的花名册里——与官方 Team 的做法一致。并发上限是 `maxActiveSubagents`（默认 8），按子代理树、进程内计数；排空一个子代理解放它的名额。

**request 的组合规则。** 插件发送 `{ prompt, parent }`，再加上模型通过 `spawn_member.spawn_options`（§5）点名的可选字段：`cwd`、`agentOptions` 与 `agentPreset`，以及调用方一个都没点名时插件自己解析出的路由（§2.5、ADR 0024）。任何一个字段省略，都表示该成员继承 Lead 的值；这里要记下唯一的例外，因为不写出来这条规则读起来像是绝对的：改了 `provider` 或 `model` 却没给 `reasoningEffort` 时，新路由解析自己的默认值，而不是继承 Lead 的 effort。这里“继承 Lead 的值”指的是 Lead 当前的模型路由：每次 spawn 时从会话最近一次请求头解析，而不是 Lead Agent 创建时的选项（§2.5）。只有当路由解析不出来（或该 provider 无法应用路由）时，spawn 才组合出与以前完全一样的 request——有测试专门钉住这条路径上的那个对象。`cwd` 原样转发：seam 会把相对路径解析到父代理的 cwd 上（`resolveDirectory`），而子代理保留父代理的权限根，因此沙箱授权之外的目录仍会被拒绝；如果插件自己先解析路径，就会与 Host 的判断不一致。两个能力门属于 provider：`agentOptions` 需要 `provider.capabilities.agentOptions`，`agentPreset` 需要 `provider.capabilities.agentPreset`——进程内的 spawn/fork provider 为 true，所有外部后端为 false（其能力声明就是 `NO_START_CAPABILITIES`）——两者都在 manager 预留任何资源之前断言；插件自己对第一道门的探测，正是把一次本会发生的拒绝变成继承路径的东西。有三个 Harness 事实塑造了这个接口，写在这里是因为读者不会预期它们：**没有按次调用的工具白/黑名单**，因此 `agentPreset` 是获得工具受限或只读成员的唯一途径，seam 也明确拒绝 `toolFilter`；**preset id 必须由 profile 的 bundle 补丁声明**，因为注册表既不扫描目录也不接受路径；**没有 worktree 字段**，worktree 是先 `ctx.worktrees.create(...)`、再把它的 `path` 当 `cwd` 传，而那个服务是可选的、实验性的，所以本插件不自己创建（ADR 0016）。

有两个 Harness 事实塑造了退役流程：

- `drainChildren(parent, [childId])` 停掉单个子代理、释放名额与驻留，但子代理的会话与父会话里的 `subagent/catalog` 条目会保留。被排空的子代理会被官方花名册自己的列表永久列出，这正是我们要有自己的列表工具的原因。
- `ctx.workspaceRegistry.archiveSession` 会把一个会话从所有工作区界面隐藏。它可逆、不删除任何东西，因此适合作为“产物移不动”时的兜底。

## 5. 模型侧接口

本插件只有 Host 半区，因此它拥有的每个操作都是工具（ADR 0008）。其中十件是 Lead 专属，`list_members` 行的 `target` 就是所有面向成员的 Lead 工具接受的唯一选择器（`handoff_template` 不接受 target：它作用于 Lead 自己的记录）。另一件是面向成员的只读工具 `list_my_tasks`：它注册在成员 Agent 上而不是 Lead 上，两种作用域的权限模型见 §5.2。行上的 `child_id` 是宿主自有列表展示的持久身份；它只被报告，不作为第二个选择器——否则每个面向成员的工具都要同时支持它才一致，而 target 在可寻址成员中本来就唯一。Lead 判定刻意留有余地：没有父会话的活智能体就是根智能体，按 Lead 对待，因此一次失败的成员关系投影不会让所有工具失效。

| 工具 | 行为 |
|---|---|
| `spawn_member` | 占用基名的下一代次，并作为可续聊子代理启动；带 `definition` 时从随项目提交的成员定义启动，文件里的字段补齐调用省略的部分（§6）；带 `replace` 时，让继任者从交接书启动、把前任的未完成任务交给它，并在同一次调用里退役前任（`docs/member-lifecycle-zh.md` §3、`docs/task-board-zh.md` §2）。`lifetime` 声明成员能活多久——`standing`（默认）或 `one-shot`，而 `ephemeral: true` 是 v0.25 之前 `one-shot` 的拼写——它只属于这次调用：既不是前任的，也不是文件的（`docs/member-lifecycle-zh.md` §2、ADR 0026）。可选的 `spawn_options` 让成员用自己的 `cwd`、`agent_options`（`provider`、`model`、`reasoning_effort`、`max_tokens`）或 `agent_preset` 启动；省略的字段继承 Lead 的值——但改了 `provider` 或 `model` 却未给 `reasoning_effort` 时，新路由解析自己的默认值。一个 `agent_options` 都不给的 spawn 仍然跑在这个会话的路由上：插件解析 Lead 当前的 `provider` 与 `model` 并转发它们，因此成员用的是启动它的那个会话的 API，而 `started_with.route_source` 说明路由是调用方给的（`caller`）、插件解析并转发的（`plugin`），还是未解析而继承的（`inherited`，具体兜底原因记在 `route.select_reason`）；`started_with` 报告的是插件转发出去的内容，不是子代理解析出的结果（`docs/architecture-zh.md` §2.5、ADR 0024）。Harness 拒绝的启动是带类型的结果（`started: false`，`reason` 说明出路），绝不是宿主错误；读不出来的成员定义也以同样的方式回答（ADR 0016、ADR 0018）。一次性成员会在它跑过、停下且不拥有任何未完成任务之后被清扫退役，而该次调用也会先清扫已经处于该状态的成员（`docs/member-lifecycle-zh.md` §2）。 |
| `list_members` | Lead 控制的每个成员与子代理：本花名册、收养的官方成员、收养的子代理后代（§5.1）。行带 `target`、`child_id`、相态、代次、标签、记录在案的 `assignment`、该成员 spawn 时声明的 `lifetime`（`standing` 或 `one-shot`，旁边还有记录上的 `ephemeral`）、被交派工作两次及以上的一次性成员上的 `retasked: true` 与 `retasked_note`、成员启动时的 `route`、实时状态与 `compactable`；压力字段（`pressure_tokens`、`context_window`、`usage_ratio`）只在驻留时出现。当 Lead 自己的路由读得出来、且与某个成员记录的路由不同时，该行还会带 `route_stale: true` 与一句 `route_note`，点出两条路由以及替换该成员的那一次调用（§2.5、ADR 0024）。读取会先清扫“跑过、停下且不拥有任何未完成任务”的一次性成员，并在退役了成员时报告 `swept` 与 `swept_targets`——而被工作板否决留下的成员，则通过 `blocked`、`blocking_tasks` 与 `blocking_note` 报告；`unowned`/`unowned_tasks` 只在否决读取与退役之间有新行被创建时才出现（`docs/member-lifecycle-zh.md` §2、`docs/task-board-zh.md` §2、ADR 0026）。它总是带 `host_hooks`：`panel_filter`、`roster_filter` 与 `slot_credit` 各是 `installed` 还是 `absent`，过滤器装上时的 `stripped_ids` 与 `tombstone_read_failed`，以及一条 `message`，点出缺席的钩子、它需要的服务，以及这对官方面板和 `list_agents` 意味着什么（`docs/architecture-zh.md` §2.4、ADR 0025）。它还报告 `archived_records`——离开花名册进入只追加归档的墓碑数——并在该数不为零时用 `archive_file` 点名那个文件；因此从这个列表里消失的 target 可能仍在归档里，而不是消失了（`docs/roster-storage-zh.md` §3、ADR 0030）。它还总是带 `storage`：`source: 'file'` 与这个工作区 `roster.json` 的 `path`，文件是由导入存储域创建时附 `imported_at`，另一个写入者改过该文件时附 `foreign_write_at`，文件不可用而该 Lead 仍留在域上时附 `read_problem`——而文件不可用时报 `read_problem` 而不是回退——或者，对从未被本进程绑定过的 Lead 为 `source: 'none'`（存储 API 能碰到，生产碰不到）。"由存储域提供服务"不再是 schema 会发布的值，因为它已经不可能发生（`docs/roster-storage-zh.md` §4、ADR 0031）。 |
| `wait_members` | 对这个 Lead 成员的实时状态做一次有界等待：某个成员的 `agent/status` 在 `idle` ⇄ `running` 之间变化时返回，或超时后返回，并报告是哪个成员、变成了什么。超时默认 30 秒，超过 1 小时即拒绝；若没有 `running` 成员也没有 `provisioning` 预留，则立刻回答 `no_progress`，因为被阻塞的 Lead 无法唤醒空闲成员。它只观察调用之后的变化，绝不唤醒任何人（§5）。 |
| `message_member` | 给活着的目标投递一条消息，并可顺带替换其记录在案的 `assignment`；运行中的子代理在下一步看到，已卸载的可续聊子代理会冷恢复。消息永不改变生存期：给一次性成员发消息会重新打开它（完成证据被丢掉，结果回答 `reopened: true` 与未变的 `lifetime`），因此在它再次跑过并停下之前，清扫会放过它（`docs/member-lifecycle-zh.md` §2、ADR 0026）。每一条被受理的消息都会在成员记录上计数，任何成员都算，因为退役门槛要读这些计数（`docs/roster-storage-zh.md` §1、`docs/member-lifecycle-zh.md` §2）。目标已退役或已失败时拒绝，`reason` 分别是 `retired` 或 `failed`；目标不存在则为 `missing`。当该名字的另一个代次还活着时，拒绝还会带上 `current_holder` 并在消息里说明。 |
| `stop_member` | 只取消目标当前轮，保留激活与收件箱；对已退役或已失败的目标按与 `message_member` 相同的带类型原因拒绝，并以同样方式携带 `current_holder`。 |
| `retire_member` | 排空、立碑、把会话产物移入回收站、执行每个 Lead 的保留上限并刷新宿主侧效果（`docs/member-lifecycle-zh.md` §3）；结果报告 `pruned`，重复调用是无操作，返回 `reason: 'already-retired'`，此时若名字已被另一代次接手，结果会指出那个活持有者。**当 `standing` 成员还带着东西时不会被这一次调用退役**——记录在案的 `assignment`、一条 `open` 行、或反复交派的证据：它回答 `retired: false, reason: 'needs-confirmation'`，带回要问本人的 `question`、说明查到什么的 `carries`、有才出现的 `owns_tasks`/`assignment`，以及说明下一步怎么做的 `message`；退役发生在下一次调用上，那次调用把 `confirmed` 设成本人原话的引文，并会在结果里回显它。**什么都没带的 `standing` 成员由 Lead 自己清掉，只要写一个 `reason`**；没有 reason 的调用回答 `reason: 'needs-reason'` 与 `carries: []`。一次性成员、由 `spawn_member` 带 `replace` 启动的继任者、以及处于 `failed`（或已 `retired`）的记录都豁免，因为它们都不是这次调用要结束的角色（`docs/member-lifecycle-zh.md` §2、ADR 0026）。它是一次没有继任者的退役，因此该成员的未完成任务会失去 owner，结果用 `unowned`/`unowned_tasks` 点出它们（`docs/task-board-zh.md` §2）。 |
| `restore_member` | 把回收站里的产物移回，记录转回 `active`；结果会说明实际走了哪条分支，记录本来就处于活动状态时是无操作成功而不是报错，被剪除的墓碑则回答 `reason: 'pruned'` 且不触碰工作区；该名字的另一代次还活着时，拒绝会带上 `current_holder`。它不分配任何工作：`unowned`/`unowned_tasks` 报告仍在等待 owner 的未完成行（`docs/task-board-zh.md` §2）。 |
| `compact_member` | 对驻留且空闲的目标调用 `ctx.compaction.compactNow(agent, signal)` 强制压缩一次，返回结构化结果而不是抛异常：`done`、`busy`、`not-resident`、`nothing-to-compact`、`failed`。 |
| `handoff_template` | 读取、保存或清除这个 Lead 的交接书形状：省略 `template` 读取生效的那份及其 `source`（`file`、`stored` 或 `builtin`），给一个模板则在校验后保存，给空字符串则清除。文件 `team/team.md` 只要存在就胜出，因此保存与清除都会带着文件路径被拒绝，并要求编辑该文件；坏文件会通过 `file_problem` 报告，且不会遮住可用的已存模板。已存的值一旦不再通过校验，读取会报告 `valid` 与 `problem`，合成则退回内置形状（`docs/handoff-zh.md` §2）。 |
| `task_board` | 这个 Lead 自有的工作板：`create` 新建任务，`list` 读取整块板，`update` 设置任务的 `status`、`owner` 与／或 `body`（`owner: null` 与 `body: null` 表示清空），`release` 清掉 owner，`delete` 删除该行（`docs/task-board-zh.md` §2）。一个工具配 `action` 枚举，而不是五个名字：五种操作共用同一种行形状与同一套拒绝说法，每个动作最多多带三个字段。任务 id 是 UUID，标题超过 200 个字符即拒绝，正文超过 2000 个字符即拒绝，一个 Lead 最多 200 条任务；已存的行一旦标题或正文不再通过读取规则，会带 `problem` 照常返回而不是被丢掉（`docs/roster-storage-zh.md` §1）。`list` 会报告未完成任务数、其中无主的数量，以及每一行的正文——也就是交接书不携带的那份“完成指什么”与“停在哪里”。按 id 定位的写入在串行化的改动内部基于已存行构建，因此 `update` 会保留它没有点名的字段，而 `release` 或 `delete` 若发现这一行在调用读取之后变过，会带着找到的那一行回答 `changed: false`，而不会抹掉一次交接（ADR 0020）。 |
| `list_my_tasks` | 注册在**成员** Agent 上而不是 Lead 上：只读返回 `owner` 正好是本成员自己 target 的行，每行带 id、标题、正文、状态、时间戳，以及 Lead 的工作板同样会报的读取期 `problem`，另加 `open` 与该成员的 `target`（§5.2）。它不接受参数：调用方的会话就是选择器。名下没有任务的成员得到 `tasks: []` 与一句说明，而不是报错；其他成员的行、无主的行与 Lead 的整块工作板都不出现。工作板没有成员写入者——成员报告完成的工作，由 Lead 把行关掉（ADR 0022）。 |

操作体在 `actions.js`；`index.js` 只保留参数校验、Lead 专属权限检查与工具结果 schema。替换刻意不新增工具：`spawn_member` 与 `message_member` 各多一个参数，而不是让模型为同一件事再学第三个名字（ADR 0009）。交接书的**形状**则多了一个工具，而不是 `spawn_member` 的又一个参数，因为一个持久偏好不该作为创建成员的副作用而改变（ADR 0015）。任务板是一个工具而不是五个，理由正相反：五个名字会让接口为同一种行形状翻三倍（ADR 0017），而它的两件事——工作板与交接——以同一套词汇到达模型。

官方花名册的 spawn、等待与任务工具已由 bundle 补丁禁用（P2-07，v0.14.0）——`spawn_teammate`、`wait_agent` 与 `team_task_*` 工具——本插件的工具就是 Lead 用来操作花名册的那套界面；补丁条目本身写明了它移除了什么、代价是什么（`cordis.patch.yml`）。官方 `agent-team` 服务发布的三件工具仍留在列表里：`list_agents`、`send_message`、`interrupt_agent`，因为禁用那条服务行会连收养、成员判定与投影过滤一起带走。被禁用那行拥有的工具在这里都有替代，`wait_agent` 也不例外：`wait_members` 监听的是 Harness 的 `agent/status` 事件，并按本 Lead 花名册上的子会话 id 过滤。官方的 `agentTeams.waitForChange` 同样由这个事件驱动，但只对它自己的成员判定能解析出的 Agent 生效，而通过 `ctx.subagents` 启动的成员不在它的日志里——所以这里的等待是本插件自己的监听，而不是对那项服务的一次调用。

### 5.1 收养就是控制面

`ensureAdopted`（`actions.js`）是这套接口完整可用的原因：它读取官方团队花名册与子代理注册表，把每个不认识的子代理记成成员；从官方花名册收养的成员沿用官方名字，相态从 `active` 开始。注册表读取是 `ctx.subagents.listDescendants(rootSessionId, signal)`（安装版 seam `dsh-subagent` `0.2.2-rc.1`，`lib/index.js` 第 3181–3183 行委托到第 2380–2446 行）；子行是 `{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`，`kind: 'diagnostic'` 行跳过；有 label 的子代理按与官方名字相同的规范化规则命名，没有 label 的命名为 `subagent-<id>`。收养按子会话 id 幂等，而让幂等成立的正是退役记录这块墓碑——排空子代理不会删掉父代持久 catalog 里的那一行。消息投递通过 Lead 的直接子代权限寻址，而退役即使排空被拒绝也会立碑。出厂深度上限是 1，所以每个后代都是直接子代；更深的树（只有调高深度上限才可能出现）会被消息投递拒绝，但仍可退役。

### 5.2 权限模型：Lead 看得到什么、成员看得到什么，以及为什么（v0.20.0）

成员拿不到任何 Lead 工具，Lead 也拿不到成员工具。这是两个作用域，而不是同一件工具上的两种权限；正是因为这样划分，工作板才能保持只有一个写入者，而干活的人又读得到自己名下的工作（ADR 0022）。

| 调用方 | 拿到的工具 | 能读什么 | 能写什么 |
|---|---|---|---|
| 某个 Team 的 Lead | 十件 Lead 专属工具；`list_my_tasks` 不在其中 | 用 `task_board list` 读整块板，用 `list_members` 读所有成员 | 所有花名册操作与所有工作板写入 |
| 成员：非根 Agent，且其会话被某条花名册记录点名 | 只有 `list_my_tasks` | 该花名册中 `owner` 正好是自己 target 的行——未完成与已完成都包括 | 工作板上什么都不写：它报告完成的工作，由 Lead 把行标成 `done` |
| 名下没有任务的成员 | `list_my_tasks` | `tasks: []`、`open: 0` 与一句说明 | 什么都不写 |
| 没有任何花名册记录点名的子代理（根 Agent，或尚未被收养的子代理） | `list_my_tasks` | 一次拒绝：对 Lead 点名 `task_board`，对子代理点名收养触发点；读取绝不执行收养 | 什么都不写 |

**权限来自调用方的会话，绝不来自参数。** `requireMember` 在所有花名册中查找 `childId` 等于调用会话的那条记录并返回该行；过滤用的就是该行的 target。因此成员无法靠点名去读别人的行，也不存在第二种寻址方式。这次读取刻意不写：收养本来就由 `list_members` 与 `spawn_member` 执行，而成员的读取不该把记录悄悄写进一个它看不见的 Lead 名下。

**只有一个写入者是这套设计的不变量，不是便利取舍。** 工作板是一份串行化的文档，它的交接是一次在立碑之前重新指派行的改动（`docs/task-board-zh.md` §2），它的 `release`/`delete` 只作用于读到的状态（ADR 0020）。交接矩阵里每个转换都恰好只有一个执行者，正因为成员从不写入。若给成员一个改状态的能力，就会多出第二套权限规则、第二套针对 Lead 交接的比较并写入逻辑，以及一行分不清“成员说完成了”还是“Lead 认可了”的 `done`。成员的汇报与 Lead 的转换是两件不同的事实，为此多花的一次往返，比消除这个歧义所省下的更便宜。

**注册跟着 Agent 走，和 Lead 一样。** `installMember` 在加载时与 `agent/created` 时注册到成员 Agent 自己的 `agent.ctx`，由 `agent/disposed` 与插件卸载移除。成员据以读取的 `target` 在调用时才解析，所以注册可以覆盖所有非根 Agent，而答案仍旧窄到只有点名它的那条花名册记录。

## 6. 成员定义（v0.16.0）

成员过去只作为一种工具调用存在：提示词、标签与 assignment 只活在那次调用和 Lead 的花名册记录里，于是团队无法被评审、版本化或共享，同一个「reviewer」每个会话都要重打一遍。定义把成员从调用里搬到磁盘上——每个成员一个 markdown 文件，从工作区的 `.agents/team/definitions/`、或它的 `team/` 目录读取，或来自本 bundle 随包提供的五个模板——花名册则仍是运行时状态（ADR 0018、ADR 0029）。

**路径。** 定义从三个目录组成的链上读取，越具体越先：`<Lead 工作目录>/.agents/team/definitions`，然后 `<Lead 工作目录>/team`，最后是 bundle 内 `templates/definitions` 里的五个模板。同一个名字的第一个声明胜出；在**同一个**目录里被声明两次的名字仍然会被拒绝并点出两个文件；一个坏文件只挡住它自己声明的那个名字（ADR 0029）。工作区的两个目录都由 `workingDirectory` 服务解析：`ctx.get('workingDirectory').ensure(leadAgent, signal)`（§7）。这与安装版 spawn seam 解析相对 `request.cwd` 用的是同一个服务、同一个方法，所以定义读到的目录，正是 `spawn_options.cwd` 相对解析的那个目录。该服务是可选的，与 `compaction` 一样用 `ctx.get` 读取；profile 没有挂载它、或它的 `ensure` 抛错，都是带类型的拒绝（`reason: "working-directory-unavailable"`），而不是猜一个目录。**团队文件不属于这条链：** 它仍在 `<Lead 工作目录>/team/team.md`（ADR 0021），因为它不是成员定义、也没有随包对应物——`.agents/team/` 放花名册文件与插件自有的定义，`team/` 放项目自己的团队文件（ADR 0029）。

**文件。** 第 1 行 `---`、一段扁平 frontmatter、再一行 `---`，其后的 markdown 正文就是成员的提示词。可接受字段恰好是 `spawn_member` 本来就有的、用于描述角色的输入：`name` 与 `label` 必填，另有 `assignment`、`cwd`、`provider`、`model`、`reasoning_effort`、`max_tokens` 与 `agent_preset`。**`lifetime` 不在其中**，而 `ephemeral` 在 v0.25.0 被移除：生存期是关于某一个成员的声明，也是本人同意它自行离开的凭据，因此它只在 spawn 调用上做出，永远不会从文件继承（`docs/member-lifecycle-zh.md` §2、`docs/architecture-zh.md` §6.1、ADR 0026）。文件*名*不是身份——定义自己声明 `name`，它也正是 `spawn_member.definition` 查找用的键——调用上没有对应物的字段不在范围内。

**子集是写下来的，不是估出来的。** `key: value`，一行一对，不允许缩进；值可以是裸值，或两端加引号，不解释任何转义；允许空行与 `#` 注释。嵌套、列表、块标量（`|`、`>`）、锚点与别名（`&`、`*`）、合并键（`<<`）、流式集合（`[...]`、`{...}`）、重复键、未知字段、无值键，以及缺少 `name`/`label`，都会连文件路径与行号一起被拒绝；未知字段的那句话还会列出可接受字段集。这里没有 YAML 库，因为 bundle 不导入 Node 内置之外的任何东西（ADR 0002）：本仓库的解析器就是规范，它不实现的写法一律拒绝，而不是被误读。

**优先级：调用侧优先，replace 时记录压过文件，且结果会说明这一点。** 传给 `spawn_member` 的每个字段都按字段覆盖定义里的值，`agent_options` 内部也一样；返回结果中的 `definition` 对象给出文件名、取自文件的字段（`from_file`）以及被调用替换掉的字段（`overridden`）。`prompt` 是一个例外：正文是成员的常驻提示词，调用里的 `prompt` 是这次的任务，所以调用文本追加在正文之后，`definition.prompt` 报成 `file` 或 `file+call`。另一个是 `assignment`，它还有第三个来源：`replace` 时，前任记录在案的 assignment 压过文件的常驻语句，因为继任者继承的是工作而不是角色（ADR 0009、ADR 0019），`definition.assignment` 报出 `call`、`predecessor` 或 `file` 中哪一个提供了它——文件只在没有可继承之物时生效。文件里的东西绝不会被悄悄丢掉——「模型以为自己覆盖了定义、其实没有」正是这份回报要防的失败。

**一个坏文件不会藏起其他文件。** 扫描收集能读的，并报告读不了的：成功 spawn 上的 `definition.problems`、拒绝上的 `problems`，每行是 `{path, line?, problem}`。同一个名字被两个文件声明时两边都不可用，因为悄悄挑一个会让另一个文件的修改不可见。名字未知时回答 `definition-not-found` 并带 `available`（同一次扫描能用的名字）；若目录里同时还有被拒绝的文件，则回答 `definition-invalid`，因为那名字可能就声明在里面。这与存下的任务遵循的规则相同（ADR 0017）：一条坏记录不能藏起其余记录。

**上限是拒绝。** 单文件 16 KiB（`DEFINITION_FILE_MAX`），单次扫描 64 个文件（`DEFINITION_LIMIT`），绝不截断、绝不部分读取。大小上限按文件计，所以超大定义被拒绝而邻居照常可用；数量上限按目录计，所以超量目录整次扫描被拒绝，而不是只服务一个残缺子集。拒绝时不预留任何东西——不写成员记录、不启动子代理——所以修好文件重试仍用同一个名字。

**接口只有一个参数。** `spawn_member.definition` 就是整个特性：没有创建/更新/删除工具，因为版本控制与编辑器才是让文件优于工具的原因，模型用自己的文件工具写这些文件。`spawn_member` 的结果 schema 是二分支 `oneOf`——成员行，或定义拒绝——因为拒绝是一种回答而不是宿主错误，这也正是 ADR 0016 对「被拒绝的启动」已经定下的规则。

### 6.1 成员定义在 spawn、replace 与 message 三处（v0.17.0）

定义只在它被点名的那一次 spawn 上被读取，之后它携带的每个字段要么落在记录上、要么落在活着的子代理上、要么哪里都不落。`name`、`label` 与 `prompt` 遵循 §6 的优先级规则；下表是其余每一个可接受字段，因为它们每一个都能让只写了文件、没读调用的人意外。每行一个字段，每个格子回答同样三个问题：该事件上文件贡献什么、调用能覆盖什么、效果是什么。事件就是 `docs/member-lifecycle-zh.md` §1 已经命名的那三个：`spawn`（不带 `replace`）、`replace` 与 `message`（`message_member`）。

**`message_member` 从不读取文件。** 消息作用于已经启动的成员，因此定义在那里不贡献任何东西：消息唯一还能触及的字段，是它记录的 assignment，文件的其他字段在之后某次 `spawn_member` 为另一个成员读取它之前，都不会再被查询。

| 字段 | `spawn`（不带 replace） | `replace` | `message` |
|---|---|---|---|
| `assignment` | 文件：提供持久的 assignment；调用：调用上显式给出的 `assignment` 覆盖它；效果：记录带上它，`list_members` 报告它。 | 文件：**仅当前任没有记录过时**才提供；调用：调用上的 assignment 同时压过两者，而前任记录在案的 assignment 压过文件；效果：继任者被交接的是工作本身而不是角色的常驻语句，结果用 `definition.assignment`（`call`、`predecessor` 或 `file`）说明胜出者。 | 文件：读了也没用；调用：消息被受理后 `message_member.assignment` 替换记录在案的 assignment；效果：该成员的下一个继任者被交接的是新文本。 |
| `cwd` | 文件：提供工作目录；调用：`spawn_options.cwd` 覆盖它；效果：子代理就在那里启动，原样传入。 | 文件：提供它；调用：`spawn_options.cwd` 覆盖它；前任自己的 `cwd` **不会**被继承，因为记录不保存它；效果：继任者按文件或调用说的目录启动，可能与前任运行的位置不同。 | 文件：不贡献任何东西；效果：在该成员一生中固定——换目录需要新的 spawn 或替换。 |
| `provider` | 文件：提供它；调用：`spawn_options.agent_options.provider` 覆盖它；效果：该成员的模型请求走这个路由。两者都没给时，插件从 Lead 当前会话解析它（§2.5、ADR 0024）。 | 与 `spawn` 相同，且前任的路由不会被继承——它不在记录上；文件与调用都没给时，同样由插件解析。 | 不贡献任何东西；在该成员一生中固定。 |
| `model` | 文件：提供它；调用：`spawn_options.agent_options.model` 覆盖它；效果：选定的模型绝不会无声，`started_with` 会回显转发了什么。两者都没给时，插件从 Lead 当前会话解析它。 | 与 `spawn` 相同；前任的模型不会被继承。 | 不贡献任何东西；在该成员一生中固定。 |
| `reasoning_effort` | 文件：提供它；调用：`spawn_options.agent_options.reasoning_effort` 覆盖它；效果：更换 provider 或 model 后省略它，会让新路由解析自己的默认值。 | 与 `spawn` 相同。 | 不贡献任何东西；在该成员一生中固定。 |
| `max_tokens` | 文件：提供它，不是正整数则拒绝；调用：`spawn_options.agent_options.max_tokens` 覆盖它；效果：限制该成员的输出 token。 | 与 `spawn` 相同。 | 不贡献任何东西；在该成员一生中固定。 |
| `agent_preset` | 文件：提供它；调用：`spawn_options.agent_preset` 覆盖它；效果：它决定成员的 preset、人格与工具集，profile 未声明的 id 是带类型的拒绝。 | 与 `spawn` 相同。 | 不贡献任何东西；在该成员一生中固定。 |

这些格子依赖的前提：

- **连续性正是替换的意义，而文件里的一个字段足以打断它。** `assignment` 规则就是 v0.17.0 的要点：在此之前，带 `assignment` 的文件会把每个继任者都交接成角色的常驻语句，而不是前任正在做的事，这同时推翻了 ADR 0009 与本插件「工作随人走」的主张。调用是 Lead 的明确表态，仍然优先；文件是「没有可继承之物」时的兜底。这一点调整的是 ADR 0018 第 4 点——它写的是全新 spawn 的合并规则，还没有把前任列为来源（ADR 0019）。
- **生存期根本不在这张表里，这就是那个决定。** `lifetime` 之所以没有行，是因为文件不能声明它：v0.25.0 把它从可接受字段集中移除，而带 `ephemeral` 或 `lifetime` 的文件会被按名字拒绝，并给出理由与替代做法（ADR 0026）。ADR 0019 第 3 点曾让文件来描述角色的生存期，而它接受的后果——一次性的继任者会让替换刚交给它的工作变成无主——正是本人规则所禁止的那一种，所以离开的是这个字段，而不是又写下一个后果。
- **前任的 `cwd` 与模型路由不会被继承，也无法被继承。** 它们是启动选项，不是记录字段：`started_with` 是工具结果上的一张收据，不是持久状态（`docs/roster-storage-zh.md` §1），所以继任者只拿到文件、调用或——就路由而言——插件从 Lead 当前会话解析出的那一份（`docs/architecture-zh.md` §2.5、ADR 0024）。想让继任者待在前任目录里的 Lead，自己传进去。
- **交接矩阵（`docs/task-board-zh.md` §2）不因以上任何一条而改变。** 不论文件怎么写，替换仍然在同一次调用里搬走前任的未完成任务；生存期是 spawn 调用的，而那次交接写下的所有权，正是否决清扫继任者的东西（`docs/member-lifecycle-zh.md` §2）。

## 7. 使用的 Harness 扩展点

| 需求 | 机制 |
|---|---|
| 启用一条官方但被关闭的行 | bundle 补丁 `- id: <row>` 配 `disabled: false` |
| 按 Agent 生效的行为 | 在 `agent/created` 里注册到 `agent.ctx`，在 `agent/disposed` 时卸载 |
| 注册工具 | `agent.ctx.tools.register(definition)`，定义用规范 JSON Schema |
| 上下文压力 | `ctx.tokenMeter.contextPressure(session)` |
| 压缩 | `ctx.get('compaction').compactNow(agent, signal)` |
| 成员判定 | `ctx.agentTeams.tryMembership(agent)` |
| 子代理生命周期 | `ctx.subagents.startActivation`、`sendMessage`、`interrupt`、`drainChildren` |
| 让成员用自己的目录、模型路由或 preset 启动 | `ctx.subagents.startActivation` 上的 `request.cwd`／`request.agentOptions`／`request.agentPreset`；受 provider 声明能力的约束，而工具限制除了 agent preset 没有别的途径（§4、ADR 0016） |
| 列出全部子代理后代 | `ctx.subagents.listDescendants(rootSessionId, signal)`；行带 `id`、`mode`、`label?`、`parentId`、`depth` |
| 得知某个子代理已停止 | `subagent/end`（一次运行结算时发布）以及 `agent/status` 的 `idle` 边沿；两者都不持久，所以一次性清扫仍自带证据（`docs/member-lifecycle-zh.md` §2、ADR 0013、ADR 0026） |
| 等待成员的实时状态 | 在插件自己的上下文里 `ctx.on('agent/status', ({ agent, status }))`，并按本花名册持有的子会话 id 过滤；该分发带作用域过滤，而未加作用域的监听者会被放行（§5） |
| 插件自有持久状态 | `ctx.storageDomain` 域，而不是会话事件（ADR 0003） |
| 解析 Lead 的工作目录、团队文件读取的 `team/`，以及成员定义读取的那条链 | `ctx.get('workingDirectory').ensure(agent, signal)`——与 spawn seam 解析相对 `cwd` 用的是同一个服务与方法；该服务可选，所以没有它的 profile 会拒绝定义 spawn，并且看不到团队文件，而不是猜一个目录（§6、`docs/handoff-zh.md` §2、ADR 0018、ADR 0021、ADR 0029） |
| 隐藏产物移不动的会话 | `ctx.workspaceRegistry.archiveSession`／`unarchiveSession`（可逆，不删除；退役与恢复的兜底分支） |
| 让客户端丢掉已退役成员 | 包装 `sessionController` 的列表／投影／流出口（ADR 0004） |
| 让官方团队面板列出本插件的活成员 | 同一组出口：把四字段成员行追加到即将发出的 `agentTeam` 值上（ADR 0023） |
| 让官方 `list_agents` 读取丢掉已退役成员 | 用同步包装替换 `agentTeams.listMembers`，读同一份墓碑 id 集合（ADR 0025） |
| 只在所包装的服务存在后才运行宿主钩子 | `ctx.inject([service], callback)`：回调负责安装、返回的 disposer 负责卸载，服务被替换时 Cordis 会卸载并重跑它（ADR 0025） |
| 补偿官方花名册名额 | 补丁旧花名册的 `maxMembers` getter 与 `spawn`（ADR 0004） |
| 把退役会话挪开 | `ctx.get('sessionPersistence').stat(id).location.path` + rename 进回收站 |

## 8. 风险与边界

- **应用内视图是带覆盖层的官方团队面板，不是我们自己的面板。** 没有设置页（ADR 0008）。**成员**区之所以列出本插件的活成员，是因为投影过滤把它们追加到即将发出的 `agentTeam` 值上；已退役成员则从这个值里消失，而不是留成一行标注“已退役”（ADR 0023）。覆盖层只是一个视图：它不能退役、替换或修改任何东西，而且新鲜度只到下一次 `list`／`projections`／`follow` 读取或 `control` 帧为止——本插件不写会话事件，所以一次 spawn 不会自己发布团队变更帧。**共享任务**区仍然是官方任务板的，因为一个任务视图需要本插件任务板没有的十个字段。
- **官方花名册仍是它创建的那些成员的来源。** 它的 spawn、等待与任务工具被禁用（P2-07），但服务没有，因为收养与投影过滤需要它：`list_members` 会报出这些成员，本插件保留它们的墓碑，而那项服务的三件模型侧工具（`list_agents`、`send_message`、`interrupt_agent`）仍然注册着。
- **官方任务板已不可达。** Lead 的工作在自有任务板上（`docs/task-board-zh.md` §2）；官方任务板上的行本插件读不到，而能读到它们的工具已在 v0.14.0 被禁用。退役既不转交也不取消认领它们：想要这些行的 Lead 在 `task_board` 上重新创建（ADR 0017）。
- **恢复有界，平台记录没有真正抹除**——已退役成员的会话在这个 Lead 的回收站未超上限前都可恢复；被剪除的产物字节则永久消失，记录会如实说 `pruned` 而不是假装还在。官方 catalog 仍知道该成员存在过，因为平台从不删除它自己的东西（ADR 0011）。退役是我们花名册里的生命周期事实，不是平台的删除。
- **转发的目录、路由与 preset 由调用方决定，插件只负责转发。** 在 Harness 解析之前，插件无法判断某个 `cwd` 是否可用；在注册表查询之前，它也无法判断某个 preset id 是否存在，因此两处拒绝都是把 seam 的答案翻译成带类型的结果，而不是一个可能与 Host 判断不一致的预检（ADR 0016）。
- **Harness API 漂移**——本文点到的每个 Service 都来自已安装的 asar，版本会变；一次 Harness 升级就能让本文作废，而本仓库什么都没改。安装版的子代理 seam 与公开源码树不是同一代：公开树有成员 `name` 和 `resolveName`，安装版没有。采信任何公开示例之前，先读安装版的 `lib/index.js`。
- **交接质量取决于记录在案的职责与任务板上的行**——插件读不到官方任务板，也读不到前任的对话，因此继任者的交接书只能由记录与自有任务板合成。一个从未记录过 `assignment`、任务板上也没有未完成行的成员，交接出去的就只是角色与任务板指针，而不是摘要。
- **成员定义与团队文件都是插件只读的文件。** 它无法判断它们是否过期、其提示词是否符合 Lead 心里的工作，也无法判断同一个工作目录下的 `team/` 或 `.agents/team/definitions/` 是否被两个 Lead 共用；那是项目的版本控制要管的事，不是本插件的职责。它能保证的事情更窄、也更可核对：调用方能用的定义，恰好是调用那一刻它在链上搜到的那些可读 `.md` 文件——工作区的两个目录与随包模板——团队文件恰好是 `<Lead 工作目录>/team/` 下的 `team.md`；读不出来的文件会连路径与行号一起被拒绝，而不是只应用一半（§6、`docs/handoff-zh.md` §2、ADR 0018、ADR 0021、ADR 0029）。
- **压缩是 profile 级的**——启用后端会改变该 profile 内每个会话的行为。这是把官方特性打开，不是自研代码，但它并不只作用于本插件的成员。
