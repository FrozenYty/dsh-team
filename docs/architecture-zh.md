# 架构

> Owner: @FrozenYty · Revisit when: Harness 升级改动了本插件使用的某个 Service

本文说明插件是什么、现在做什么，以及正在构建的花名册设计。设计背后的决策记录在 `docs/adr/`；本文描述结果。

## 1. 插件是什么

一个 DeepSeek Harness **profile bundle**。安装它会做两件事：

1. 选中一条 profile 默认关闭的官方插件行（`compaction-basic`）；
2. 插入一个我们自己写的 Host 插件（`dsh-team-roster`）。

没有构建步骤，也没有运行时依赖：官方行由已安装的 Harness 自己解析，我们的入口不导入任何东西（ADR 0002）。bundle 只有 Host 半区：没有浏览器半区（ADR 0008）。

它唯一的可调项是每个 Lead 的会话回收站上限，由 bundle 自己补丁行上的 `trashLimit` 字段承载（`- id: team-roster`，`config: { trashLimit: <整数> }`）。`apply(ctx, config)` 在注册任何东西之前先解析它：字段缺失取 `DEFAULT_TRASH_LIMIT`（20），至少为 1 的整数原样采用，其他值则让加载失败，报错信息里点名字段、看到的值与最小值（ADR 0012）。本入口刻意不声明 `Config` schema，因此 Host 的 Config 提供方仍报 `absent`：该投影只接受原生 Schemastery 图，而零导入的 bundle 无法提供，字段改由 `apply` 校验。

## 2. v0.1，已交付

### 2.1 启用压缩

profile 把 `compaction-basic` 置为 `inactive`，所以没有任何东西在压缩，每个智能体——Lead 和所有成员——都会一路涨向模型窗口。bundle 把该行覆盖为 `disabled: false`。这个后端注册的是不带作用域的 `agent/pre-step`、`agent/request`、`agent/request-error` 监听器，因此进程内每个 Agent 都被覆盖，包括子代理。

本机 DeepSeek 路由的默认值（窗口 1,048,576，输出预留 256,000，headroom 65,536）：自动压缩在
`floor(min(窗口 × 0.8, 窗口 − 输出 − headroom))` = 727,040 tokens 触发，按 `窗口 − 输出` 的 16% 原样保留最近内容。要调，就在更高层补丁里对同一行给一个 `config` 覆盖。

`command-compact`（`/compact`）刻意**不**启用：它需要 `commands` 服务，而本 profile 同样没有挂载，所以即使启用该行也只会停在 `absent`。

### 2.2 上下文工具

每个 Lead 专属工具都注册在 Team Lead 的确切 Agent 上下文上（`agent/created`），并在 `agent/disposed` 时卸载。不遮蔽任何官方工具名，也不写任何会话事件。

| 工具 | 行为 |
|---|---|
| `list_members` | 花名册：相态、代次、标签、实时状态，驻留时还给出 `pressure_tokens`、`context_window`、`usage_ratio` 与 `compactable`。 |
| `compact_member` | 对单个驻留且空闲的成员调用 `ctx.compaction.compactNow(agent, signal)`，返回结构化结果而不是抛异常：`done`、`busy`、`not-resident`、`nothing-to-compact`、`failed`。 |

`member_context` 存在于 v0.1，已移除：它的行与 `list_members` 重复，而且读的是官方花名册而不是本插件的。

实测到的限制塑造了后续设计：本地子代理空闲即被卸载，而 `compactNow()` 要求 Agent 驻留且空闲。因此“对已完成的成员按需压缩”几乎没有窗口；可行路径是用消息唤醒它，让自动压缩在它下一步之前生效。

### 2.3 自建花名册工具（v0.2，已实测）

| 工具 | 行为 |
|---|---|
| `spawn_member` | 先占用一个带代次的名字并**持久化这条预留**，再通过 `ctx.subagents.startActivation` 以生成的 `childId` 和 `delivery: 'parent'` 启动可续聊子代理。启动失败会留下一条可见的 `failed` 记录，绝不会留下看不见的子代理。带 `replace` 时，同一次调用会退役前任，并让继任者从交接书启动（§4.4）。 |
| `list_members` | 每条记录给出相态、代次、实时状态，驻留时还给出上下文压力。已退役成员仍以 `retired` 列出。 |
| `retire_member` | 排空子代理、给记录立碑（带上回收站路径与原始路径，以及是否改由工作区归档隐藏会话），再把持久化会话移入回收站目录。对已退役成员重复退役是无操作，返回 `retired: true, drained: false, reason: 'already-retired'`。对“已结束的成员”和“正在跑的成员”两种情形都实测通过。 |
| `restore_member` | 把回收站里的产物移回退役时记录的原始路径并清除墓碑；已有活成员占用该目标时拒绝。没有墓碑可逆时是无操作成功，结果的 `reason` 会说明实际走了哪条分支。 |
| `message_member` | `ctx.subagents.sendMessage(caller, childId, [text], { signal })`。运行中的成员在下一步收到；已卸载的成员从自己的会话冷恢复。实测：投递唤醒了卸载成员并得到回复。 |
| `stop_member` | `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: caller })`。只取消当前轮，保留激活、名额与收件箱。实测：成员正跑长命令时被中断，且没有留下收尾消息。 |

**收养。** 花名册在第一次被读取时，会收录 Lead 控制、但花名册尚不认识的每个成员与子代理：

- 官方团队花名册创建的成员：记录以子会话 id 为身份、沿用官方名字、相态为 `active`。
- 子代理注册表报告的每个后代，包括官方 `subagent` 与 `subagent_fork` 工具启动的子代理。读取调用是 `ctx.subagents.listDescendants(rootSessionId, signal)`（安装版 seam `dsh-subagent` `0.2.2-rc.1`，`lib/index.js` 第 3181–3183 行的服务方法，遍历在第 2380–2446 行）。子行形状为 `{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`；读不到的分支返回 `kind: 'diagnostic'` 行，收养时跳过。有 label 的子代理按与官方名字相同的规范化规则命名；没有 label 的命名为 `subagent-<id>`。

因此 `retire_member`、`message_member`、`stop_member` 对本插件从未创建过的子代理同样有效——正是以前完全不可见的那批。收养按子会话 id 幂等，而让幂等真正成立的是墓碑：排空子代理不会删掉父代持久 catalog 里的那一行，所以退役记录必须留在花名册里，否则下一次读取会把成员收养回来。一次性（one-shot）子代理同样会被收养，可停止、可退役；它不能冷恢复，所以 `message_member` 只在它驻留时可送达。

记录存在一个以 Lead 会话 id 为键的 `storageDomain` 域里（ADR 0003）。命名规则：代次 1 用裸名字；代次 2 起用 `<base>-g<N>`，因此继任者绝不会与已退役的名字相撞。退役后再用同一个基名创建，就是替换操作：`probe-a` 退役、`probe-a-g2` 启动，两条记录都在。

在 P2-07 关闭官方工具行之前，两个花名册并存。`list_agents` 是官方工具，报官方花名册；`list_members` 报的是官方花名册的成员**加上**收养的全部后代与本插件启动的成员，因此它是 `list_agents` 的超集，而不是另一个不相交的集合。

### 2.4 宿主侧效果

两个效果让退役对客户端可见，并让官方的成员名额重新可用。两者都做能力探测、都在插件卸载时精确还原，且都不写 Lead 会话（ADR 0004）。

| 效果 | 机制 | 宿主形状缺失时 |
|---|---|---|
| 投影过滤 | 包装 `sessionController.list`／`projections`／`control`／`follow`，从 `subagentCatalog` 与 `agentTeam` 帧里摘掉已退役 id | 退役仍生效，客户端仍显示该成员 |
| 名额补偿 | 替换旧花名册的 `maxMembers` getter 并包装 `spawn`，在一次 spawn 期间按发起 Lead 的退役数临时抬高上限 | 退役仍生效，官方名额仍被占用 |

两者都通过一个两秒缓存读取退役记录，`retire_member` 会主动使缓存失效；两者对其他插件透明：参数相同、返回形状相同，载荷是原地修改而不是复制，调用方持有的引用继续有效。

### 2.5 退役会移走产物

`retire_member` 先排空子代理、写出墓碑（带上即将使用的回收站路径与 `trashState: 'pending'` 标记），再把持久化会话移入
`~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`，最后把记录确认为 `trashState: 'done'`。顺序是刻意的：先让记录退役、再碰文件系统，因此两者之间崩溃留下的是“一条 `retired` 记录配一份要么还没移动、要么已经进回收站的产物”——两种情况都可恢复，因为 `pending` 表示“移动可能发生也可能没有”，而恢复会先去回收站找。反过来则会留下“已进回收站的会话 + `active` 记录”，之后任何一次读取都解释不通。真正让成员从宿主的自有发现里消失的是**移动**——session-query 会摘掉已经不在的文件。移动本身不删除任何东西：跨设备兜底是这一步里唯一会移除源的分支；产物移不动时改由工作区归档隐藏会话（`archived: true`、`trashState: 'none'`，并丢弃计划中的回收站字段），记录与返回结果都会说明走的是哪一条。

随后，**真正移入过产物**的那次退役会在同一次调用里执行每个 Lead 的回收站上限（ADR 0011），因为这次移动正是回收站增长的唯一时刻：超出**生效上限**的最旧条目被移除——生效上限是 `apply` 从 `trashLimit` 配置里解析出的值，profile 什么都没配时就是 `DEFAULT_TRASH_LIMIT`（20）——每个被移除的墓碑保留 `trashPath` 并把 `trashState` 置为 `pruned`，结果用 `pruned` 报告移除了多少、以及用的是哪个上限。不存在定时清理，也不存在读取时清理；`pending` 的移动计入上限但永不被剪除；只有这一个 Lead 回收站目录的直接子项、且目录名与墓碑都能解析时才成为候选。`apply` 读的是配置字段而不是代码里的字面量（ADR 0012），而且它只删本插件自己移入回收站的副本——平台没有会话删除 API，唯一官方的“藏起来”机制是可逆的工作区归档，它无法约束字节数。

恢复是同样明确的逆操作：记录里保留了原始路径和产物类型（`trashKind`——会话目录或单个产物文件），所以 `restore_member` 是**移动**而不是猜测，返回结果会说明实际走的是哪条分支——移回、工作区取消隐藏，还是记录本来就处于活动状态。它绝不覆盖已存在的目标、拒绝活成员已占用的名字，移动失败时记录保持退役状态。

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

有两个 Harness 事实塑造了退役流程：

- `drainChildren(parent, [childId])` 停掉单个子代理、释放名额与驻留，但子代理的会话与父会话里的 `subagent/catalog` 条目会保留。被排空的子代理会被官方 `list_agents` 永久列出，这正是我们要有自己的列表工具的原因。
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
```

`trashState` 与 `phase` 一样会在加载时校验：未知值会被拒绝，而不是被猜测。`pruned` 保留
`trashPath`、`trashKind` 与 `originalPath`——墓碑仍记录产物去了哪里——并且是唯一会让
`restore_member` 在不做任何移动的情况下直接给出带类型拒绝的取值。

没有其他字段；特别地，没有 `dormant` 相态（§4.3），也没有 `briefPath`：交接书在替换时由
`assignment` 合成，可复用的存储模板仍属 P4-02。

`assignment` 是继任者交接书所依据的持久陈述：用 `spawn_member.assignment` 写入，用
`message_member.assignment` 替换，出现在每一行 `list_members` 上，退役后仍留在墓碑里。

`name` 只在**当前**成员之间唯一。继任者复用它并把 `generation` 加一——官方花名册做不到这一点，因为它把名字视为永久占用。每次改动都是花名册表上的一次原子 `update`，不是“先读再 put”；每个操作在决定之前都重读花名册，因此同一模型轮次里的两次工具调用看到的是彼此的写入，而不是互相覆盖（§4.3）。

### 4.3 状态矩阵

实现转移之前，每个格子都要先被决定（AGENTS.md §4.8）。四个相态就是 `PHASE` 里的那四个。**拒绝**表示刻意不受理：调用会说明原因而不是执行，既不是崩溃，也不是遗漏。“同基名”指启动某个基名，而该基名的前一持有者正处于该相态。

| 相态 \ 事件 | 收养 | spawn（同基名） | replace | 发消息 | 停止 | 压缩 | 退役 | 恢复 |
|---|---|---|---|---|---|---|---|---|
| `provisioning` | 收养不会产生该相态——被收养的记录从 `active` 或 `failed` 开始 | 预留下一代次；本行不受影响 | 先启动继任者，再排空并给这条预留立碑 | 通过 `sendMessage` 投递；尚未发布的子代理会被子代理服务拒绝，错误如实上报 | 子代理未驻留时无操作，已驻留则取消本轮 | 在它驻留且空闲之前拒绝 `not-resident` | 先排空，再立碑；此时产物通常还移不动，因此 `trashed: false`，由归档分支决定 | 无操作成功——没有墓碑可逆 |
| `active` | 无操作——身份就是子会话 id，已认识的子代理不会被收养两次 | 预留下一代次；本行不受影响 | 继任者从交接书启动，随后本成员被排空并立碑 | 投递；运行中的子代理在下一步看到，已卸载的会冷恢复 | 取消当前轮；激活、收件箱与记录保留 | 驻留且空闲时原地压缩；运行中拒绝 `busy`，已卸载拒绝 `not-resident` | 排空、立碑（`pending`）、移动并确认、刷新宿主侧效果 | 无操作成功：`restored: true, reason: 'already-active'` |
| `retired` | 无操作——墓碑持有子会话 id，这正是阻止重新收养的东西 | 允许：同基名的下一代次启动，不带替换关系（§2.3） | 继任者用墓碑里的交接书启动；退役这一半是无操作（`reason: 'already-retired'`） | 拒绝 `retired` | 拒绝 `retired` | 拒绝——只有 `provisioning` 与 `active` 可寻址 | 重复调用：无操作成功，`retired: true, drained: false, reason: 'already-retired'` | 把产物移回，或走工作区取消隐藏分支；`reason` 说明走的是哪条。`trashState: 'pruned'` 的墓碑则返回 `restored: false, reason: 'pruned'`，且绝不调用工作区 |
| `failed` | 无操作——已知子会话 id | 预留下一代次；本行不受影响 | 先启动继任者，再给这条记录立碑 | 拒绝 `failed`——子代理从未启动，没有东西能接收 | 拒绝 `failed` | 拒绝——只有 `provisioning` 与 `active` 可寻址 | 受理并立碑；通常既没有可排空的，也没有可移动的 | 无操作成功——不是墓碑，没有可逆内容 |

Harness 通知是任何插件操作都无法阻止的事件：

| 相态 \ 通知 | 子代理本轮结束 | 子代理本轮失败 | 宿主排空或卸载该子代理 | 持久化会话消失 |
|---|---|---|---|---|
| `provisioning` | 不适用——预留发生在任何轮次之前 | `failed`，启动错误写进 `note`；这是本插件唯一记录的失败 | 观察不到；预留一直保留到启动有结果 | 退役返回 `trashed: false` 并给出原因，随后归档分支隐藏该会话 |
| `active` | 无持久变化——观察不到完成通知；相态保持 `active`，实时状态报 `unloaded` | 无持久变化——启动之后的失败在这里不可见，记录保持 `active` | 相态不变，实时状态 `unloaded`；仍可发消息（冷恢复），也可退役 | 退役返回 `trashed: false` 并退回归档；恢复返回原因，记录保持退役 |
| `retired` | 忽略——没有活子代理 | 忽略 | 忽略 | 恢复拒绝，记录保持退役 |
| `failed` | 忽略 | 忽略 | 忽略 | 忽略 |

这些格子依赖的前提：

- **没有 `dormant`。** 上面四个相态就是 `roster.js` 里 `PHASE` 的全部；实时状态（`running`、`idle`、`unloaded`）在调用时从 Harness 读取，从不存储。`dormant` 相态属于 P4-01，连同那个会设置它的完成钩子。
- **`replace` 是一次模型调用，由 `spawn` 与 `retire` 合成。** 每个格子里都先启动继任者，因此启动失败时这一行原封不动，而退役失败会返回 `predecessor_retired: false` 并说明原因。
- **同一模型轮次里的两个工具。** 每次调用都重读花名册，每次改动都是花名册表上的一次原子 `update`（§4.2），因此第二次调用是在第一次的结果上行动：同一轮里先 `message_member` 再 `retire_member` 会先投递再立碑，反过来则拒绝 `retired`，先 `retire_member` 再 `spawn_member` 会启动下一代次。并行的工具调用由存储表串行化，而不是由调用方。
- **已退役或失败的成员仍是一条可控记录。** 它可以被列出、退役、替换：`retire_member` 与 `restore_member` 的查找覆盖任何相态。只有需要活子代理的 `message_member` 与 `stop_member` 是窄的，它们以带类型的原因 `retired`、`failed` 或 `missing` 拒绝。
- **被剪除的墓碑仍是退役记录，而不是消失。** 保留上限（§2.5）移除的是产物，不是成员身份：记录仍在列表里，仍保留职责与路径，因此 `restore_member` 能依据记录回答 `pruned`，而不是在缺失目录上失败。这个格子是拒绝，相态保持 `retired`。

有两个格子代价最高，特意点名：

- **provisioning 期间退役**——记录立刻变 `retired`，在途子代理发布后被排空。成员绝不能退役后复活。对
  provisioning 成员执行 `replace` 时，继任者启动之后对前任做同样的事。
- **active 期间退役**——退役优先于在途工作。记录里的 `assignment` 就是交接书（§4.4）；如果模型从未记录过，继任者的提示词会如实说明，并让它去共享任务板取，而不是凭空编一份摘要。

### 4.4 退役与替换

退役是一套协议而不是删除，因为成员的会话是持久的、工作可能做了一半。`retire_member` 按代码里的顺序做这些事：

1. **记下原因**——模型给出的 `reason` 写进墓碑的 `retireReason`。
2. **排空**——`ctx.subagents.drainChildren(lead, [childId])` 停掉子代理，释放它的激活名额与驻留。从未发布过的、或已经结束的子代理没有可排空的；两种情况都继续退役，因为生命周期事实由记录掌握。
3. **立碑**——记录转为 `retired`，带上 `retiredAt`、`assignment`、原因，以及下一步准备使用的回收站路径，并标记 `trashState: 'pending'`（没有可移动之物时直接是 `'none'`）；这一步发生在碰文件系统**之前**（§2.5）。在这里崩溃留下的是“退役记录 + 要么没移动、要么已进回收站的产物”；`pending` 表示无从确定，恢复会先去回收站找，因此两种情况都能收尾。
4. **移动产物并确认**——持久化会话移入插件的回收站目录，记录随后确认为 `trashState: 'done'`，并写上 `trashPath`、`originalPath` 与 `trashKind`。没有可移动的产物时，改由工作区归档隐藏会话，丢弃计划中的回收站字段，记录与返回结果都会说明这一点（`archived: true`、`trashState: 'none'`）。`archived` 与 `trashPath` 互斥：只有没发生移动时才会走归档分支。
5. **只在此时约束回收站**——成功移入过产物的那次退役，会从这个 Lead 的回收站目录里按最旧优先移除超出**生效上限**的条目；生效上限是 `apply` 解析出的 `trashLimit` 配置（默认 `DEFAULT_TRASH_LIMIT`，20），而不是代码里的常量；每个被移除的墓碑保留 `trashPath` 并把 `trashState` 置为 `pruned`（ADR 0011、ADR 0012）。没有移动过产物的退役不会剪除任何东西。不存在定时器，也不存在读取时清理。
6. **隐藏**——宿主投影出口不再下发已退役 id，所有客户端因此丢掉该成员；花名册保留回收站路径以便手工恢复。
7. **报告**——返回结果带 `retired`、`drained`、`archived`、`trashed`、`pruned`（没有移除任何东西时为 0），有回收站路径时再带 `trash_path`；`pruned` 大于 0 时，消息会说明移除了多少产物、用的是哪个上限以及原因。重复调用是无操作，返回 `retired: true, drained: false, pruned: 0, reason: 'already-retired'`。

工作的持久陈述就是成员的 `assignment`：模型用 `spawn_member.assignment` 写入，用
`message_member.assignment` 保持最新；上限 1000 个字符，因此记录不会无限增长。

**替换。** `spawn_member` 带 `replace: <target>` 会为继任者合成一份简短、自足的提示词：继任者的名字、前任的 target 与 label、记录在案的职责、前任已离场这一事实，以及按前任名字指向共享团队任务板的指针。任务板不复制、不重复。之后它会对前任执行第 2–6 步。**同一次调用里先启动继任者、再退役前任**：启动失败则前任原封不动且仍然活着；退役失败则返回 `predecessor_retired: false` 与原因，再调一次 `retire_member` 即可收尾。目标已经退役时同样接受，由墓碑提供交接书。ADR 0009 记录了该顺序以及被否掉的替代方案。

继任者拿到的是被继承的工作，而不是前任状态的副本：除非模型重新记录，继任者继承前任的
`assignment`，因此反复替换不会让记录一代比一代更薄。

**尚未实现、因此不作为行为描述（P4-02）。** 没有“成员自己写交接书”这回事，也没有交接书文件：向成员索要交接书要花一次模型往返，而需要交接时它往往正好无响应或已失败，所以交接书由记录合成。代码里也没有任何“用工作区和任务板核对职责”的步骤——那是 Lead 的判断，插件只是指向任务板。可复用的存储模板属于 P4-02。

### 4.5 模型侧接口

本插件只有 Host 半区，因此它拥有的每个操作都是工具（ADR 0008）。全部为 Lead 专属，`list_members` 行的 `target` 就是其他工具接受的唯一选择器。行上的 `child_id` 是宿主自有列表展示的持久身份；它只被报告，不作为第二个选择器——否则七个工具都要同时支持它才一致，而 target 在可寻址成员中本来就唯一。Lead 判定刻意留有余地：没有父会话的活智能体就是根智能体，按 Lead 对待，因此一次失败的成员关系投影不会让所有工具失效。

| 工具 | 行为 |
|---|---|
| `spawn_member` | 占用基名的下一代次，并作为可续聊子代理启动；带 `replace` 时，让继任者从交接书启动，并在同一次调用里退役前任（§4.4）。 |
| `list_members` | Lead 控制的每个成员与子代理：本花名册、收养的官方成员、收养的子代理后代（§4.5.1）。行带 `target`、`child_id`、相态、代次、标签、记录在案的 `assignment` 与实时状态，驻留时另带压力与 `compactable`。 |
| `message_member` | 给活着的目标投递一条消息，并可顺带替换其记录在案的 `assignment`；运行中的子代理在下一步看到，已卸载的可续聊子代理会冷恢复。目标已退役或已失败时拒绝，`reason` 分别是 `retired` 或 `failed`；目标不存在则为 `missing`。 |
| `stop_member` | 只取消目标当前轮，保留激活与收件箱；对已退役或已失败的目标按与 `message_member` 相同的带类型原因拒绝。 |
| `retire_member` | 排空、立碑、把会话产物移入回收站、执行每个 Lead 的保留上限并刷新宿主侧效果（§4.4）；结果报告 `pruned`，重复调用是无操作，返回 `reason: 'already-retired'`。 |
| `restore_member` | 把回收站里的产物移回，记录转回 `active`；结果会说明实际走了哪条分支，没有可逆内容时是无操作成功而不是报错，被剪除的墓碑则回答 `reason: 'pruned'` 且不触碰工作区。 |
| `compact_member` | 对驻留且空闲的目标强制压缩一次。 |

操作体在 `actions.js`；`index.js` 只保留参数校验、Lead 专属权限检查与工具结果 schema。替换刻意不新增工具：`spawn_member` 与 `message_member` 各多一个参数，而不是让模型为同一件事再学第三个名字（ADR 0009）。官方花名册工具保持启用：共享任务板归它们所有，而收养机制让它们创建的成员同样可退役。将来可由 P2-09 换掉任务板，再关闭官方工具行。

#### 4.5.1 收养就是控制面

`ensureAdopted`（`actions.js`）是这套接口完整可用的原因：它读取官方团队花名册与子代理注册表，把每个不认识的子代理记成成员。注册表读取是 `ctx.subagents.listDescendants(rootSessionId, signal)`（安装版 seam `dsh-subagent` `0.2.2-rc.1`，`lib/index.js` 第 3181–3183 行委托到第 2380–2446 行）；子行是 `{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`，`kind: 'diagnostic'` 行跳过。收养按子会话 id 幂等，而让幂等成立的正是退役记录这块墓碑——排空子代理不会删掉父代持久 catalog 里的那一行。消息投递通过 Lead 的直接子代权限寻址，而退役即使排空被拒绝也会立碑。出厂深度上限是 1，所以每个后代都是直接子代；更深的树（只有调高深度上限才可能出现）会被消息投递拒绝，但仍可退役。

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
| 列出全部子代理后代 | `ctx.subagents.listDescendants(rootSessionId, signal)`；行带 `id`、`mode`、`label?`、`parentId`、`depth` |
| 插件自有持久状态 | `ctx.storageDomain` 域，而不是会话事件（ADR 0003） |
| 隐藏产物移不动的会话 | `ctx.workspaceRegistry.archiveSession`／`unarchiveSession`（可逆，不删除；退役与恢复的兜底分支） |
| 让客户端丢掉已退役成员 | 包装 `sessionController` 的列表／投影／流出口（ADR 0004） |
| 补偿官方花名册名额 | 补丁旧花名册的 `maxMembers` getter 与 `spawn`（ADR 0004） |
| 把退役会话挪开 | `ctx.get('sessionPersistence').stat(id).location.path` + rename 进回收站 |

## 6. 风险与边界

- **没有应用内视图。** 花名册只通过 `list_members` 对模型可见，没有设置页。宿主自有的子代理选择器仍照旧渲染，只是少了已退役 id（ADR 0008）。
- **迁移期两个花名册并存**——在 P2-07 落地前，官方花名册和我们自己的都可能对模型可见。补丁步骤是阶段门禁的一部分，不是事后补丁。
- **恢复有界，平台记录没有真正抹除**——已退役成员的会话在这个 Lead 的回收站未超上限前都可恢复；被剪除的产物字节则永久消失，记录会如实说 `pruned` 而不是假装还在。官方 catalog 仍知道该成员存在过，因为平台从不删除它自己的东西（ADR 0011）。退役是我们花名册里的生命周期事实，不是平台的删除。
- **Harness API 漂移**——本文点到的每个 Service 都来自已安装的 asar，版本会变；一次 Harness 升级就能让本文作废，而本仓库什么都没改。安装版的子代理 seam 与公开源码树不是同一代：公开树有成员 `name` 和 `resolveName`，安装版没有。采信任何公开示例之前，先读安装版的 `lib/index.js`。
- **交接质量取决于记录在案的职责**——插件读不到共享任务板，也读不到前任的对话，因此继任者的交接书只能由记录合成。一个从未记录过 `assignment` 的成员，交接出去的是标签和任务板指针，而不是摘要。
- **压缩是 profile 级的**——启用后端会改变该 profile 内每个会话的行为。这是把官方特性打开，不是自研代码，但它并不只作用于本插件的成员。
