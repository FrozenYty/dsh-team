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
trashDir      退役给这个回收站目录起的名字，在墓碑上；也是数据根移动后仍然成立的那一部分
trashRelPath  该目录相对数据根的位置，在墓碑上；绝对路径在读取时才算出
trashPath     某次移动用过的绝对路径，仅出现在 v0.26.0 之前写下的墓碑上
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

有一个字段属于花名册而不是成员：`retiredChildIds` 列出这个 Lead 曾经有过的全部已退役子会话 id，**包括已归档的那些**，并且每次写入都会重写它，因此被恢复的成员会从中离开。官方宿主钩子是**按子会话 id** 摘除面板行的，所以让已退役成员不出现在那里的，是这份 id 列表而不是墓碑本身（ADR 0030）。

`trashState` 与 `phase` 一样会在加载时校验：未知值会被拒绝，而不是被猜测。`pruned` 保留
`trashDir`、`trashKind` 与 `originalPath`——墓碑仍记录哪个目录被剪除了、产物原本从哪里来，而 v0.26.0 之前
写下的记录保留的是它的绝对 `trashPath`——并且是唯一会让
`restore_member` 在不做任何移动的情况下直接给出带类型拒绝的取值（ADR 0028）。

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

**只在此时约束回收站**——成功移入过产物的那次退役，会从这个 Lead 的回收站目录里按最旧优先移除超出**生效上限**的条目；生效上限是 `apply` 解析出的 `trashLimit` 配置（默认 `DEFAULT_TRASH_LIMIT`，20），而不是代码里的常量；每个被移除的墓碑保留它记录的那个目录名——`trashDir`，或 v0.26.0 之前写下的记录里的绝对 `trashPath`——并把 `trashState` 置为 `pruned`（ADR 0011、ADR 0012、ADR 0028）。候选只有名字能解析的直接子项，而墓碑是**按目录名**与候选匹配的：这个目录名正是回收站位置里在数据根移动后仍然成立的部分，名字里的 id 是**子会话 id**、不是记录的 `memberId`，所以翻转时比对的是记录自己的 id 而不是从名字里解析出的 id（ADR 0028）。`pending` 的移动计入上限但永不被剪除，而且只删本插件自己移入回收站的副本——平台没有会话删除 API，唯一官方的“藏起来”机制是可逆的工作区归档，它无法约束字节数。没有移动过产物的退役不会剪除任何东西。不存在定时器，也不存在读取时清理。

**恢复从不相信记录下来的绝对路径**——产物按顺序在三条腿上查找：生效中的数据根（记录的相对路径，或由目录名重建的布局）、记录自己携带的绝对路径、以及冻结的 `~/.dsh/team-roster`。重复项会被去掉，所以常规情形每条腿只有一个候选，而任何更早版本写下的墓碑都无需迁移即可恢复（ADR 0028）。

**墓碑在它的产物不可能还存在之后离场。** 超出最新的 `trashLimit` 条墓碑之后，保留上限早就把字节删掉了，那里的恢复只可能回答 `pruned`；这些记录会移入 `archive.jsonl`——只追加、一行一个 JSON 对象、热路径上永不读取——而且只在同时满足三条时：记录写有回收站目的地、它的移动不是 `pending`、并且它的产物在上文那条链的**每一条腿**上都不存在。窗口由生效上限推导而来，因此不可能与上限脱节；而这条约束在该 Lead 的**每一次写入**上执行，而不是某一个操作上：已经越过窗口的记录会在下一次写入时被冲走，无需迁移脚本，读取永远不触发。没有目的地的记录、字节仍在磁盘上的记录、以及存储域模式都刻意不受约束，归档文件本身也不受约束（ADR 0030）。恢复一条已归档的墓碑会以 `reason: 'archived'` 点名该文件，`list_members` 则报告 `archived_records`，并在该数不为零时给出 `archive_file`。

## 4. 文件放在哪里，谁可以写

**每个工作区一个文件。** 记录是本插件自己的 `roster.json`，位于 Lead 工作区的 `.agents/team/` 下，与 memory 笔记本并排，旁边还有它的导入标记、`provenance.json` 与 `archive.jsonl`；回收站也在同一个根下。若 profile 设置了 `DSH_TEAM_DATA_DIR`，或冻结的 `DSH_TEAM_ROSTER_DATA_DIR`，则使用该目录（ADR 0014）。Lead 在第一次使用时就绑定到它的根，绑定只存在于运行中的进程里，因此同一会话之后调用 `working_directory` 无法移动这个根、也无法让它已经写入的东西变成孤儿。工作区无法解析的会话继续使用存储域，`list_members` 会在 `storage` 里说明这一点。文件一旦存在，存储域就不再被写入，也永不被删除：它是那一次性的导入来源，而删除 `roster.json` 就是回滚。记录以“临时文件加重命名”替换，因此崩溃要么留下完整的旧文件、要么留下完整的新文件；读不出来的文件，或其中一条记录被加载器拒绝的文件，会回退到存储域而不是抛错。

**每个工作区一个写入者。** 同一工作区里的两个 Lead 会话按设计共用这个文件，二者之间没有任何串行化——锁文件会引入一个无人清理的陈旧锁失败模式。每次写入都会先重读该文件，因此并发改动是被合并而不是被覆盖；本进程没有写过的序号会在 `list_members` 里以 `foreign_write_at` 报出。检测发生在本进程的下一次读或写，而不是第二个写入者落笔的瞬间。
