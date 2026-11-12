# 花名册存储

> Owner: @FrozenYty · Revisit when: 记录结构、加载规则或保留上限发生变化时

本插件自有的持久形态：每个 Lead 会话一条花名册记录、它携带哪些字段以及加载时拒绝什么、哪些字段有各自的规则，以及约束本 Lead 回收站的保留上限。这些记录会经历的相态见 `docs/member-lifecycle-zh.md` §1；它们携带的任务见 `docs/task-board-zh.md`。相关决策：ADR 0003、ADR 0010、ADR 0011、ADR 0012、ADR 0014。

## 1. 花名册记录

每个 Lead 会话一条花名册记录，里面是该团队的成员记录；表以 Lead 会话 id 为键（ADR 0003）。

```
memberId      稳定身份：本插件启动的成员在此生成，收养的子代理用它的子会话 id
name          模型侧名字，只在当前成员之间唯一
generation    名字的第一位持有者是 1，继任者是 2，以此类推
childId       子代理会话 id，随预留一起写入
phase         provisioning | active | retired | failed
label         给模型看的职责描述
assignment    成员正在做什么，由模型写入；最多 1000 个字符（member-lifecycle §3）
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
              移动已落地但产物后来被保留上限剪除时为 `pruned`（member-lifecycle §4）
archived      产物移不动、改由工作区归档隐藏会话时为 true
ephemeral     成员是一次性时为 true：它是 spawn 调用上声明的生存期在记录上的拼写，也是两种生存期
              唯一会写的字段（member-lifecycle §2、ADR 0026）。可选；standing 成员没有该字段，因此它的记录与以前
              完全一致。消息不会清掉它
startedAt     一次性成员上记录其子代理启动时刻的 ISO 时间戳。这是惰性清扫所要求的正面证据，
              因此从未发布过的预留永远不会被清扫。消息会删除它，而之后某次读取若观察到该子代理驻留，
              会重新写入它——这正是让该证据始终是“最后一次交派工作之后的观察”的原因
messageCount  spawn 之后给它发过多少条消息，**每个**成员都会写（v0.25.1 起；在此之前只有一次性成员）。
              它有两个读者：`list_members` 只对一次性成员据此给出建议——两条及以上说明这多半是个
              standing 角色；而退役门槛对任何 standing 成员都读它，两条及以上意味着这个成员被反复交派、
              因此不是赤裸的残留（ADR 0026）。可选
assignmentCount  spawn 之后为它写过多少次 assignment，之所以是计数而不是推断，是因为 `assignment`
              字段只保留最后一个值。写入与读取的用途与 `messageCount` 相同。可选
route         成员启动时所在的路由，以及这条路由从哪来：`{ source, provider?, model?, select_reason? }`。
              `source` 为 `caller`（spawn 调用或其定义点名了路由）、`plugin`（插件解析并转发了 Lead
              当前路由）或 `inherited`（什么都没转发，`select_reason` 说明走的是哪种兜底：
              `no-session-route` 或 `capability-absent`）。随预留写入一次、之后永不改写——它是关于
              那次启动的事实，而 `started_with` 是那次请求的收据。可选，因此 v0.22.0 之前写下的每条
              记录都能照常加载、行为不变（architecture §2.5、ADR 0024）
handoffTemplate  在花名册记录上、不在成员上：这个 Lead **存下**的交接书模板，替换时由它插值（member-lifecycle §3）。
              它是**第二个**来源：Lead 项目里的 `team/team.md` 只要存在就压过它（handoff §2）。可选，因此
              任何更早版本写下的记录都能照常加载、行为不变
tasks         在花名册记录上、不在成员上：这个 Lead 的工作板，一个任务行数组。每行是
              `{ id, title, body?, status, owner?, created_at, updated_at? }`：`id` 是创建时生成的
              UUID，`title` 是受上限约束的展示文本（`TASK_TITLE_MAX`，200），`body` 是这条任务自己
              写下的“完成指什么”与“停在哪里”（`TASK_BODY_MAX`，2000，只有带正文的行才有该字段，用
              `body: null` 清空），`status` 是 `open | done`，`owner` 是承担该工作的成员 target，
              `created_at` 是 ISO 时间戳，首次改动后才出现 `updated_at`。可选，因此 P2-09 之前写下的
              记录都能照常加载、行为不变；工作板为空的 Lead，就是那条从未获得该字段的记录
              （ADR 0017、ADR 0020）
```

`trashState` 与 `phase` 一样会在加载时校验：未知值会被拒绝，而不是被猜测。`pruned` 保留
`trashPath`、`trashKind` 与 `originalPath`——墓碑仍记录产物去了哪里——并且是唯一会让
`restore_member` 在不做任何移动的情况下直接给出带类型拒绝的取值。

没有其他字段；特别地，没有 `dormant` 相态（`docs/member-lifecycle-zh.md` §1），也没有 `briefPath`：交接书在替换时由
`assignment` 与生效模板——`team/team.md` 文件、记录里的 `handoffTemplate`、内置形状，按此顺序——
合成（`docs/member-lifecycle-zh.md` §3、`docs/handoff-zh.md` §2）。`ephemeral` 与 `startedAt` 是 P4-01 引入的一对字段，`messageCount` 与
`assignmentCount` 是 v0.25 引入的一对，四个都可选：任何更早版本写下的记录都能照常加载，行为不变。
v0.25 没有给已存字段改名——`ephemeral` 是每条花名册本来就带着的东西——所以 `lifetime` 只存在于调用与
行上，而 `lifetimeOf` 是二者之间唯一的翻译。v0.25.1 也没有增加任何字段：那两个计数从“只有一次性成员”
变成“每个成员”，是因为退役门槛要读它们（ADR 0026）。

## 2. `assignment` 与 `name`：两个有规则的字段

`assignment` 是继任者交接书所依据的持久陈述：用 `spawn_member.assignment` 写入，用
`message_member.assignment` 替换，出现在每一行 `list_members` 上，退役后仍留在墓碑里。

`name` 只在**当前**成员之间唯一。继任者复用它并把 `generation` 加一——官方花名册做不到这一点，因为它把名字视为永久占用。每次改动都是花名册表上的一次原子 `update`，不是“先读再 put”；每个操作在决定之前都重读花名册，因此同一模型轮次里的两次工具调用看到的是彼此的写入，而不是互相覆盖（`docs/member-lifecycle-zh.md` §1）。

## 3. 回收站与保留上限

**只在此时约束回收站**——成功移入过产物的那次退役，会从这个 Lead 的回收站目录里按最旧优先移除超出**生效上限**的条目；生效上限是 `apply` 解析出的 `trashLimit` 配置（默认 `DEFAULT_TRASH_LIMIT`，20），而不是代码里的常量；每个被移除的墓碑保留 `trashPath` 并把 `trashState` 置为 `pruned`（ADR 0011、ADR 0012）。候选只有目录名与墓碑都能解析的直接子项，`pending` 的移动计入上限但永不被剪除，而且只删本插件自己移入回收站的副本——平台没有会话删除 API，唯一官方的“藏起来”机制是可逆的工作区归档，它无法约束字节数。没有移动过产物的退役不会剪除任何东西。不存在定时器，也不存在读取时清理。
