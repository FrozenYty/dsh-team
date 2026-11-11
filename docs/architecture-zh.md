# 架构

> Owner: @FrozenYty · Revisit when: Harness 升级改动了本插件使用的某个 Service

本文说明插件是什么、现在做什么，以及正在构建的花名册设计。设计背后的决策记录在 `docs/adr/`；本文描述结果。

## 1. 插件是什么

一个 DeepSeek Harness **profile bundle**。安装它会做两件事：

1. 选中一条 profile 默认关闭的官方插件行（`compaction-basic`）；
2. 插入一个我们自己写的 Host 插件（`@local/team-control`）。

没有构建步骤，也没有运行时依赖：官方行由已安装的 Harness 自己解析，我们的入口不导入任何东西（ADR 0002）。

## 2. v0.1，已交付

### 2.1 启用压缩

profile 把 `compaction-basic` 置为 `inactive`，所以没有任何东西在压缩，每个智能体——Lead 和所有成员——都会一路涨向模型窗口。bundle 把该行覆盖为 `disabled: false`。这个后端注册的是不带作用域的 `agent/pre-step`、`agent/request`、`agent/request-error` 监听器，因此进程内每个 Agent 都被覆盖，包括子代理。

本机 DeepSeek 路由的默认值（窗口 1,048,576，输出预留 256,000，headroom 65,536）：自动压缩在
`floor(min(窗口 × 0.8, 窗口 − 输出 − headroom))` = 727,040 tokens 触发，按 `窗口 − 输出` 的 16% 原样保留最近内容。要调，就在更高层补丁里对同一行给一个 `config` 覆盖。

`command-compact`（`/compact`）刻意**不**启用：它需要 `commands` 服务，而本 profile 同样没有挂载，所以即使启用该行也只会停在 `absent`。

### 2.2 两个 Lead 专属工具

两者都注册在 Team Lead 的确切 Agent 上下文上（`agent/created`），并在 `agent/disposed` 时卸载。不遮蔽任何官方工具名，也不写任何会话事件。

| 工具 | 行为 |
|---|---|
| `member_context` | 每个成员一行：角色、实时状态、是否驻留、`pressure_tokens`、`context_window`、`usage_ratio`、`under_pressure`、`compactable` 和一条说明。同时报告压缩器是否挂载。 |
| `compact_member` | 对单个成员调用 `ctx.compaction.compactNow(agent, signal)`，返回结构化结果而不是抛异常：`done`、`busy`、`not-resident`、`nothing-to-compact`、`failed`。 |

实测到的限制塑造了后续设计：本地子代理空闲即被卸载，而 `compactNow()` 要求 Agent 驻留且空闲。因此“对已完成的成员按需压缩”几乎没有窗口；可行路径是用消息唤醒它，让自动压缩在它下一步之前生效。

## 3. 为什么不扩展官方花名册

官方花名册是 Lead 会话只追加日志的折叠。成员相态为 `provisioning | active | failed`；投影拒绝任何离开终态的转换，而被拒绝的事件会记成永久 `failure`，使该 Lead 的 Team 服务失效。因此伪造一条“已退役”记录不会安全失败。`maxMembers` 检查的是一个永不收缩的列表，名字永不复用，上游重构也仍在延后删除。

完整论证与被否掉的替代方案见 ADR 0001。

## 4. v0.2，进行中：自建花名册

### 4.1 底座

成员是通过 `ctx.subagents.startActivation(...)` 创建的普通子代理，它已经提供可续聊的子代理、收件箱消息、打断、排空、冷恢复和实时并发上限。插件只拥有 Harness 不提供的部分：花名册、它的生命周期，以及由此产生的模型侧工具。

### 4.2 花名册记录

每个成员一条持久记录，存在插件自己的存储里，以 Lead 会话 id 为键（具体服务在 P2-01 选定，随后补 ADR）。

```
memberId      稳定身份，由本插件生成
name          模型侧名字，在 Lead 的花名册内唯一
generation    名字的第一位持有者是 1，继任者是 2，以此类推
childId       子代理会话 id；provisioning 期间可能没有
phase         provisioning | active | dormant | retired | failed
label         给模型看的职责描述
createdAt     ISO 时间戳
retiredAt     仅在 phase = retired 时存在
briefPath     退役成员写的交接书路径（如果写了）
predecessor   被本成员替换掉的 memberId（如果它是继任者）
```

`name` 只在**当前**成员之间唯一。继任者复用它并把 `generation` 加一——官方花名册做不到这一点，因为它把名字视为永久占用。

### 4.3 状态矩阵

实现转移之前，每个格子都要先被决定（AGENTS.md §4.8）。事件是插件操作与 Harness 通知；`—` 表示该事件被带类型地拒绝。

| 相态 \ 事件 | spawn | 发消息 | 停止 | 退役 | 子代理完成 | 子代理失败 |
|---|---|---|---|---|---|---|
| provisioning | 拒绝 | 排队直到 active | 拒绝 | 标记 retired 并排空 | `active` | `failed` |
| active | 拒绝 | 投递 | `active`（仅停止本轮） | `retired` 并排空 | `dormant` | `failed` |
| dormant | 拒绝 | 投递，转为 `active` | 无操作 | `retired` | 不适用 | 不适用 |
| retired | 拒绝 | 拒绝，带类型原因 | 无操作 | 无操作 | 忽略 | 忽略 |
| failed | 拒绝 | 拒绝，带类型原因 | 无操作 | `retired` | 忽略 | 忽略 |

有两个格子代价最高，特意点名：

- **provisioning 期间退役**——记录立刻变 `retired`，在途子代理发布后被排空。成员绝不能退役后复活。
- **active 期间退役**——退役优先于在途工作。成员先写交接书；如果它已经退化到写不了，就由 Lead 代写（见 4.4）。

### 4.4 退役与替换

退役是一套协议而不是删除，因为成员的会话是持久的、工作可能做了一半：

1. **交接书**——向成员索要一份有界的、固定 schema 的交接书：目标、已完成、进行中、下一步、涉及文件、继任者不得重做的事，写到 Lead 可读的路径。如果成员无响应、已退化或已失败，则由 Lead 代写。绝不引入第三个摘要模型。
2. **对账**——Lead 在采信之前，用花名册和工作区核对交接书；与仓库矛盾的交接书是发现，不是计划。
3. **排空**——通过 `ctx.subagents.drainChildren(lead, [childId])` 排空子代理，释放它的激活名额与驻留。
4. **立碑**——记录转为 `retired`。该成员不再能被花名册工具寻址，名字可供 `generation + 1` 的继任者使用。
5. **替换（可选）**——继任者只带交接书的**指针**启动（绝不给前任的完整对话），并在动手编辑前做一次复述门禁。

### 4.5 模型侧接口

插件将提供 `list_members`、`spawn_member`、`message_member`、`stop_member`、`retire_member`、`replace_member`，并由 bundle 补丁禁用官方花名册工具，避免两个花名册说法不一致（P2-07）。工具 schema 随 P2-06 落地。

## 5. 使用的 Harness 扩展点

| 需求 | 机制 |
|---|---|
| 启用一条官方但被关闭的行 | bundle 补丁 `- id: <row>` 配 `disabled: false` |
| 按 Agent 生效的行为 | 在 `agent/created` 里注册到 `agent.ctx`，在 `agent/disposed` 时卸载 |
| 注册工具 | `agent.ctx.tools.register(definition)`，定义用规范 JSON Schema |
| 上下文压力 | `ctx.tokenMeter.contextPressure(session)` |
| 压缩 | `ctx.get('compaction').compactNow(agent, signal)` |
| 成员判定 | `ctx.agentTeams.tryMembership(agent)`（仅 v0.1） |
| 子代理生命周期 | `ctx.subagents.startActivation`、`sendMessage`、`interrupt`、`drainChildren` |
| 插件自有持久状态 | 存储服务，而不是会话事件（P2-01） |

## 6. 风险与边界

- **迁移期两个花名册并存**——在 P2-07 落地前，官方花名册和我们自己的都可能对模型可见。补丁步骤是阶段门禁的一部分，不是事后补丁。
- **没有真正的抹除**——退役成员的会话仍在磁盘上，官方 catalog 也仍知道它存在过。退役是我们花名册里的生命周期事实，不是文件系统删除。
- **Harness API 漂移**——本文点到的每个 Service 都来自已安装的 asar，版本会变；一次 Harness 升级就能让本文作废，而本仓库什么都没改。
- **压缩是 profile 级的**——启用后端会改变该 profile 内每个会话的行为。这是把官方特性打开，不是自研代码，但它并不只作用于本插件的成员。
