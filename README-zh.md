# dsh-team

[English](README.md)

> 只是换人，不是换活。

一个 DeepSeek Harness 的 profile bundle，专补官方智能体花名册做不到的那件事：让成员离场。Lead 可以退役成员、从自己掌控的回收站把它恢复回来，也可以换成一位继任者——继任者接手 assignment、当时正在推进的工作，以及指向 Lead 自有任务板的指针。花名册归本插件所有，没有浏览器半区。

[github.com/FrozenYty/dsh-team](https://github.com/FrozenYty/dsh-team)

## 插件是什么

一个 Host 插件加一条 bundle 补丁：补丁插入 `dsh-team`，启用官方默认关闭的 `compaction-basic` 行，并禁用官方的 `tool-agent-team` 行；插件不导入任何 Harness 包、不写会话事件，状态存放在以 Lead 会话 id 为键的 `storageDomain` 域里（ADR 0003）。官方的团队**服务**行（`agent-team`）保持挂载，因为收养与投影过滤都要读它。名称在 v0.10.0 改过；存储域、补丁行 id 与回收站目录刻意没有跟着改（ADR 0014）。

## 状态

- 当前版本：v0.21.1。
- **在作者本机 profile（已安装本 bundle）上实测**：退役、恢复、发消息、停止，以及一次替换——继任者完成了前任的任务（v0.5.0、v0.6.0）；回收站上限（v0.7.0）与可配置上限（v0.8.0），配置值生效、越界值在加载时被拒绝；临时成员清扫（v0.9.0）——两个临时成员跑完后，下一次 `list_members` 返回 `swept: 2` 与两个目标，两行都变为 `retired`；交接书模板（v0.11.0）——存下的模板带唯一标记，继任者原样复述整段初始消息（标记与代入后的字段都在），未知占位符被点名拒绝，不含 `{assignment}` 的模板被拒绝并给出理由，清除后回到内置交接书；`spawn_options`（v0.12.0）——成员在转发的 `cwd` 中启动并报回该目录，合法的 `agent_preset` 可以运行，未知 preset id 返回 `started: false` 与 `reason: preset-not-found` 并列出已声明的 id，换一个模型 id 可以运行并回复，不带选项的 spawn 不携带 `started_with`；任务板（v0.13.2）——任务被创建并由成员持有，带 `replace` 的 `spawn_member` 返回 `transferred: 1` 与任务 id、且前任已退役，继任者的交接书点出该 id 与标题，不带继任者的 `retire_member` 返回 `unowned: 1` 与 id。
- **工具面在真机上实测**（v0.14.0，安装前后各读一次 `listTools`）：官方那行退役后，`spawn_teammate`、`wait_agent` 与 `team_task_*` 工具已从 Lead 的工具列表消失，调用它们会回答 `unknown tool`；本插件的 `spawn_member` 与 `task_board` 仍在。另有三件工具仍在，且这条补丁移不掉：`list_agents`、`send_message`、`interrupt_agent` 由 `agent-team` **服务**行发布，而本 bundle 刻意保留这一行，因为收养、成员判定与投影过滤都要读它。`wait_agent` 在 v0.15.0 之前在这里没有对应物；现在由 `wait_members` 接替，它建立在 Harness 自己的 `agent/status` 事件上，且仅由单元测试覆盖——真机上的订阅还没有跑过。
- **只有真机安装才能暴露的两次失败**，各一行；两次都在出问题的那个版本内修复，现在各由一项检查或测试覆盖：v0.12.0 的 bundle 安装后无法激活，直到去掉一个 schema 关键字（同版本；现在 `scripts/check.mjs` 会拒绝该关键字）；v0.13.0 的替换返回了宿主拒绝的结果，直到 v0.13.2 声明了这些字段（现在 `tests/entry.test.mjs` 会用每个工具自己声明的输出 schema 校验每个回答）。
- **一次真机运行发现了本版要补的缺口。** 一位继任者枚举自己的工具，发现没有任何花名册工具（它们全都是 Lead 专属的），于是直接读取 `~/.dsh/storages/team_roster.json` 来找它继承的任务正文。v0.20.0 在成员作用域注册了一件只读工具 `list_my_tasks`，并修正了 `{task_board}` 指针——原先它指向官方任务板，还让成员去问 Lead。在真实成员里调用一次，仍是所有者安装后的验证项（ADR 0022）。
- **仅由单元测试覆盖**，没有真机 profile 跑过：`label` 与 `assignment` 写入时的长度上限；spawn 尚在进行时发起退役；两个花名册操作重叠时的丢失更新保护；“仍在运行的成员永不被清扫”；不带 `spawn_options` 的 spawn 拼出的精确 request；任务板写入时的上限与真机没走到的交接矩阵格子；任务正文的 2000 字符上限、真机上必然看不到的“读取与写入之间插入一次交接”这种交错（测试用表自己的串行 `update` 钩子模拟），以及工作板写入不会覆盖交接这条规则；`wait_members` 的事件接线、超时、取消与无进展路径；整个成员定义层（v0.16.0）——读文件、优先级回报与每一类拒绝；团队文件层（v0.19.0）——三来源优先级、写入拒绝、占位符退路与保留文件名；以及成员作用域（v0.20.0）——owner 过滤、空答案、非成员拒绝、注册到成员 Agent 上，以及一次真实回答的 schema 一致性。由定义真正启动一个成员、真机读取一次团队文件，或由真实成员调用一次 `list_my_tasks`，是所有者安装后的验证项（ADR 0018、ADR 0021、ADR 0022）。
- 安装进 profile 有真实副作用，是否安装由所有者决定。
- 完整历史（只追加）：[PROGRESS.md](PROGRESS.md)。

## 为什么需要它

官方实验性 Agent Teams 的花名册无法真正让成员离场。它由 Lead 会话的只追加事件日志折叠而来，成员相态封闭为 `provisioning | active | failed`：投影对任何离开终态的转换都会抛错，并把这次抛错记为永久失败，此后该 Lead 的每一次 Team 读取和变更都会抛错——伪造一条“已退役”记录不是安全失败，而是彻底毒化该会话的投影（ADR 0001）。`maxMembers`（16）检查的是一个只增不减的列表；名字永不复用；整套契约里没有删除；上游进行中的重构依旧把删除推后。另外，这个 profile 出厂关掉了压缩后端。

本插件补上缺的那一半，不 fork 官方花名册：在 Harness 子代理底座上维护自己的花名册，有真正的 `retired` 相态、下一代可复用的名字，以及一个“移动而非删除”的会话回收站。

## 能做什么

| 工具 | 行为 |
|---|---|
| `spawn_member` | 把成员作为一个可续跑的子代理启动，可用 `definition` 从磁盘上的成员定义启动，也可通过 `spawn_options` 给它自己的工作目录、模型路由或 agent preset；带 `replace` 时从交接书启动继任者，并在同一次调用里退役前任；带 `ephemeral` 时标记为一次性成员，之后由清扫在它跑完并停下后退役。 |
| `list_members` | 该 Lead 控制的全部成员与子代理：本插件的花名册、官方花名册创建的成员，以及用官方 `subagent`／`subagent_fork` 工具启动的每个子代理。每行带回 target、子会话 id、相态、代次、label、记录在案的 assignment、一次性成员上的 `ephemeral`、实时状态、`compactable`，驻留时还有上下文压力。 |
| `wait_members` | 阻塞当前这一轮，直到某个成员的实时状态发生变化或超时到期，并报告是哪个成员、变成了什么。有界：默认 30 秒，最长一小时。没有成员处于 running 或 provisioning 时立刻回答 `no_progress`，绝不唤醒任何人，也不等待任务板写入或消息被处理。 |
| `message_member` | 向活着的成员投递一条消息，并可顺带替换记录在案的 assignment；已卸载的可续跑成员会从自己的会话冷恢复，一次性子代理不能。 |
| `stop_member` | 取消成员当前这一轮；激活与收件箱保留，稍后再发消息即可继续。 |
| `retire_member` | 排空、立碑、把持久化会话移进回收站（移不动时改由工作区归档隐藏），再执行保留上限。对已退役成员重复调用是无操作，并会说明这一点。 |
| `restore_member` | 把回收站里的会话移回记录的原始路径，记录转回 `active`；产物已被剪除时给出带类型的拒绝。 |
| `compact_member` | 对驻留且空闲的成员强制压缩一次，返回 `done`、`busy`、`not-resident`、`nothing-to-compact` 或 `failed`。 |
| `handoff_template` | 读取、设置或清除继任者收到的交接书：不传 `template` 即读取生效的那份及其 `source`（`file`、`stored` 或 `builtin`），传入模板即保存，传空串则回到内置版本。Lead 项目里的 `team/team.md` 只要存在就胜出，因此保存或清除都会带着该文件的路径被拒绝，并要求编辑它。 |
| `task_board` | 该 Lead 自有的工作板：用 `action` 选择 `create`、`list`、`update`、`release` 或 `delete`。一条任务有 id、标题、一段有上限的正文（说明“完成指什么”、工作停在哪里）、`open` 或 `done`，以及可选的成员 `owner`；未完成的任务会随替换一起过去，正文随之移动。 |
| `list_my_tasks` | **成员自己的工具，不是 Lead 的**：只读返回 `owner` 正好是本成员 target 的行，每行带 id、标题、正文、状态与时间戳，以及还有多少条未完成。它不接受参数——调用方的会话就是选择器。名下没有任务的成员得到空列表，而不是报错；其他成员的行、无主的行与 Lead 的整块工作板都看不见。工作板只有 Lead 能写，所以成员在回复里说明某条任务已完成，由 Lead 把该行标记为 done。 |

**成员可以换个目录、换个模型、少几件工具。** `spawn_member.spawn_options` 转发 Harness 本就支持的三个字段，任何一个省略都继承 Lead 的值——只有一个例外：改了 `provider` 或 `model` 却没给 `reasoning_effort` 时，新路由解析自己的默认值。`cwd` 用于单独的检出或 worktree（相对路径按 Lead 的目录解析，子代理保留 Lead 的权限根，因此沙箱授权之外的目录仍会被拒绝）；`agent_options` 携带 `provider`、`model`、`reasoning_effort` 与 `max_tokens`，最后一项是 token 上限，也是挑更便宜模型的地方；`agent_preset` 用于更窄的工具集——preset 是获得只读成员的**唯一**途径，因为 Harness 没有按次调用的工具白/黑名单，而 preset id 来自 profile 的 bundle 补丁，不是某个目录路径。`started_with` 是插件转发内容的回执，不是子代理解析结果的确认：它原样回显传入的字段，既不解析也不回读，所以模型有没有真正生效，要靠成员的第一条请求去确认，而不是这个字段。Harness 拒绝的启动会返回 `started: false`、原因与出路；陈旧 target 的拒绝会带 `current_holder` 指出该名字现在的活持有者，于是换过人的 Lead 可以直接改投新名字。

每次退役都在会话列表出口触发两项宿主侧效果，两者都带能力探测：投影先是从 `subagentCatalog` 与 `agentTeam` 帧中剔除已退役 id，于是顶部子代理选择器和内置团队面板不再渲染该成员（不改宿主源码，不重建 Web 应用）；同一个 `agentTeam` 值随后还会追加该 Lead 的活成员，于是官方**成员**面板会列出本插件启动的成员，点击即可打开该成员真实的会话。已退役成员则是**离场**——面板不会把它留成一行并标注“已退役”，因为面板的相态词表里没有这个值。spawn 期间，官方花名册的有效 `maxMembers` 按该 Lead 的退役数临时抬高，于是退役一个就还回一个名额。另外，补丁把官方 `compaction-basic` 行以 `disabled: false` 启用，自动压缩因此覆盖进程内所有智能体，子代理也包括在内。

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

## 定义成员

成员可以是一个文件，而不是工具调用里的一段话：`spawn_member` 带 `definition: "<name>"` 时，会从 Lead 工作目录下的 `team/` 读取成员定义。这个文件随项目一起提交、评审与版本化，而花名册仍是运行时状态——这正是本插件词汇所借用的那套划分。插件只读这些文件；写它们用你自己的文件工具（ADR 0018）。

```markdown
---
name: reviewer
label: Review the diff
assignment: Check every changed file for behaviour changes
model: a-cheaper-model
---
You review changes. Report only findings that change behaviour, with the file and the line.
```

两条 `---` 之间是扁平 frontmatter，其下的 markdown 正文就是成员的提示词。`name` 与 `label` 必填，其余可接受字段都是 `spawn_member` 本来就有的：`assignment`、`ephemeral`、`cwd`、`provider`、`model`、`reasoning_effort`、`max_tokens` 与 `agent_preset`。这份清单就是全部子集——嵌套值、锚点、块标量、列表、重复键或未知字段，都会连文件名与行号一起被拒绝，而不是被猜测；带引号的值只去掉引号，不解释任何转义。

**调用侧优先，且返回结果会说明这一点。** 传给 `spawn_member` 的每个字段都会覆盖文件里的同名项，返回结果中的 `definition` 对象会给出文件名、来自文件的部分（`from_file`）以及被你覆盖的部分（`overridden`）。有两个字段的来源不是调用。`prompt` 是调用无法覆盖的那个：正文是成员的常驻提示词，调用里的 `prompt` 会追加在它之后，`definition.prompt` 会把这个事实报成 `file+call`。另一个是 `replace` 时的 `assignment`：前任记录在案的 assignment 压过文件里的，因为继任者继承的是工作而不是角色——文件里的只在「前任没有记录」时才生效——而 `definition.assignment` 会报出 `call`、`predecessor` 或 `file` 中哪一个胜出。文件里的 `cwd`、模型路由与 preset 确实会作用于继任者；前任的那几项不会被继承，因为它们是启动选项，不是记录字段（ADR 0019）。

**一个坏文件不会藏起其他文件。** 格式错误的定义会在本来成功的 spawn 结果里，用 `definition.problems` 按路径与行号报出，合法的定义照常可用。同一个名字被两个文件声明时，两边都不可用——因为悄悄挑一个会让另一个文件的修改彻底不可见。上限是拒绝而不是截断：单文件 16 KiB，单次扫描 64 个文件——超过这个数量时整次扫描被拒绝，而不是只服务一个残缺的子集。路径同样绝不猜：profile 若没有挂载 `workingDirectory` 服务，就返回 `started: false` 与 `reason: "working-directory-unavailable"`，并且不预留任何成员。

`team/team.md` 预留给团队作用域，不是成员定义：成员仍然可以在别的文件里声明 `name: team`，但这个文件名本身会被定义扫描跳过。这正是避免同一个文件在每次 spawn 时都被报成坏定义的原因（ADR 0021）。

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

`spawn_member` 加 `replace: <target>` 就是完整的一次替换。继任者的提示词由前任的记录拼成：继任者自己的名字、前任的 target 与 label、记录在案的 assignment、前任已离场这一事实、按 id 与标题列出的前任未完成任务，以及指向本 Lead 自有任务板的指针——指针里点名了成员可用的读取工具。除非模型重新记录，继任者继承该 assignment。

**退役会对工作做什么。** 工作不是一句话：从 v0.13.0 起，它是本插件自有任务板上的行，而这两个生命周期事件正是围绕它们展开的。替换会在退役前任的同一次调用里，把前任所有未完成任务转给继任者，并在继任者的交接书里点名——于是继任者拿到的是自己现在拥有的 id，而不是指向别人任务板的指针。相反，**没有**继任者的退役会让这些行保持 `open` 且无人认领，并用 `unowned` 连同 id 报告出来，因为工作依然欠着，只是现在没有人扛；`task_board` 的 `action: list` 会报告同一批任务，恢复则说明其中有多少还在等待认领。`done` 任务永不移动：已完成的工作留在完成它的那条记录上，而让任务不再被继承的，是 `task_board` 的 `action: update, status: done`。

从 v0.18.0 起，一条任务还带有**正文**——最多 2000 个字符，写的是这条任务“完成指什么”以及前任停在哪里——用 `create` 或 `update` 写入，用 `body: null` 清空。交接书仍然只点 id 与标题：冷启动的子代理为每一个字付费，五行满长正文会撑破那一行的上限，所以继任者用 `list_my_tasks` 从任务板上读正文，而它返回的正好是自己名下的行，别的什么都不含（Lead 用 `task_board` 读同一批正文）。工作板写入也不会再抹掉交接：`update` 只应用调用点名的字段，因此替换刚刚改过 owner 的任务会保留那个 owner；而 `release` 或 `delete` 若发现这一行在调用读取之后变过，会带着找到的那一行回答 `changed: false`（并点名接手它的 owner），而不会把继任者刚拿到的工作变成无主或直接删掉。重新读一次再调一次，就会照你说的执行（ADR 0020）。

- **先启动继任者，再退役前任，都在同一次调用里。** 启动失败时前任原封不动，失败的预留会记成继任者的 `failed` 记录；退役失败则返回 `predecessor_retired: false`，再调一次 `retire_member` 即可收尾（ADR 0009）。目标已经退役时同样接受，由墓碑提供交接书。
- **assignment 是持久字段，且有长度上限。** `spawn_member.assignment` 在启动时写入，`message_member.assignment` 在工作变化时替换，两者都限制在 1000 个字符以内，超长直接拒绝而不是截断；`list_members` 会报告它，墓碑也会保留它。
- **交接书的形状可以放在两个地方，而文件胜出。** 在成员定义旁边提交 `team/team.md`，frontmatter 留空、正文写模板；它是项目的形状，因此同一个项目里的两个 Lead 共用它。或者用 `handoff_template` 把一份模板存在这个 Lead 的花名册记录上。顺序是文件、已存模板、内置形状，读取形式会用 `source` 报出实际生效的是哪一个。两者适用同一套占位符——`{successor}`、`{predecessor}`、`{label}`、`{assignment}` 与 `{task_board}`；没有引用 `{assignment}` 的模板会被拒绝，因为继任者若不知道接手的是什么，就不算完成交接；未知占位符会被按名字拒绝，模板 1000 字符的上限是拒绝而不是截断。文件存在时，`handoff_template` 的保存与清除都会被拒绝，并点名要编辑的文件：文件会遮蔽写入，接受它就成了静默无操作。坏文件会在 `file_problem` 里报告，且不会成为生效模板；接下来是已存模板，最后是内置形状。两者都没有的 Lead 得到的字句与以前完全一样（ADR 0015、ADR 0021）。

## 临时成员

`spawn_member` 带 `ephemeral: true` 会把成员标记为一次性成员，`list_members` 会在该行报告 `ephemeral: true`；缺省为 `false`。插件收不到完成事件，所以负责退役这类成员的清扫只在 `list_members` 与 `spawn_member` 调用开始时运行，并且只退役它有确凿证据表明“跑过且已停下”的成员：从未启动过的不会被清扫，仍在运行的也不会。被清扫的成员走的是普通退役流程，因此墓碑仍然列出，名额也照常返还。触发清扫的那次调用会报告 `swept` 与 `swept_targets`，一个都没退役时不加任何字段。

给一次性成员发消息会清除该标记：再次给它派活，就是声明它不再是一次性的；没有这条规则，清扫就可能吃掉刚刚送达的消息所要保留的工作。

**定义可以让继任者变成一次性的。** 文件里的 `ephemeral: true` 在 `replace` 时同样生效，因为文件描述的是角色，而替换启动的就是这个角色。用之前要知道的后果是：继任者会在本轮结束时自行退役，而替换刚刚交给它的任务会变为无主——清扫会把它们报在 `unowned` 与 `unowned_tasks` 里。给继任者发一次消息即可清除该标记，或者在替换调用上传 `ephemeral: false`（ADR 0019）。

## 限制与刻意省略

五件本 bundle 不做的事，每一件都是决定，而不是遗漏。

- **每个 Lead 一条记录，没有跨进程锁。** 花名册与这个 Lead 的任务板放在同一个 `storageDomain` 域的同一份 JSON 文档里，以 Lead 会话 id 为键（ADR 0003）。该设施没有跨进程锁（ADR 0010），所以两个 Harness 进程共用一份存储时是“后写者赢”：如果两边同时写同一个 Lead，后一次写入会替换前一次，而它没读到的更新就此丢失。对单个正在运行的 Harness 来说这是正确的，子代理本身也这样工作；插件不再加第二把锁，也没有合并协议。
- **没有自己的浏览器半区。** 没有本插件自己的面板、没有 HTTP 桥、没有客户端 bundle。v0.3 的设置页面板从未在真实 profile 里渲染过，点击也无效，因此 v0.4 选择删除而不是修复（ADR 0008）。面板显示的内容是在宿主会话列表出口覆盖上去的（ADR 0023）：**成员**区列出本插件的活成员，已退役成员则离开面板而不是被标注。覆盖层只读：它既不能退役也不能替换任何东西，更不能写会话日志，所以官方折叠那套封闭相态（ADR 0001）约束不到它。所有操作仍然是面向模型的工具；将来若要做 UI，那是一个新决定，起点是 `actions.js` 里的操作。
- **官方的 `agent-team` 服务行保持挂载。** 收养、成员判定与投影过滤都要读它，所以补丁不能把它禁用——而这项服务自己也发布三件面向模型的工具：`list_agents`、`send_message`、`interrupt_agent`，它们因此仍留在 Lead 的工具列表里。补丁退役的是官方**工具**行（`tool-agent-team`）；移除那三件会连服务、连同本插件的收养一起带走（ADR 0017）。
- **被剪除的墓碑无法恢复。** 成功移入产物的那次退役会执行每个 Lead 的回收站上限，删掉超出的最旧条目。墓碑保留 `trashPath`，状态记为 `trashState: pruned`，但字节已经不在，因此 `restore_member` 以 `reason: "pruned"` 拒绝，且绝不调用工作区（ADR 0011）。长期存续的团队若需要超过 20 份可恢复会话，请提前调大上限。
- **任务板是交接通道，不是项目跟踪器。** 一条任务只有 id、标题、一段有上限的正文、`open`/`done` 和可选的 owner，刻意没有优先级、依赖、评论、子任务与截止日期（ADR 0017、ADR 0020）。依赖尤其如此：它需要一张图和一条排序规则，而交接还得决定“依赖仍未完成的任务怎么办”；这个先后顺序留给 Lead 判断。任务板只回答一个问题：继任者现在扛着什么。

## 成本与模型路由

**这一节要回答的怀疑。** 接上中转供应商之后，所有者自己的账户仍在计费，本插件的成员看起来就是嫌疑人。并不是：下面写清楚本插件选择什么、Harness 替它选择什么，以及这份 profile 里唯一一个不看会话路由、自己钉死端点的组件。

### 谁来选成员的模型

`spawn_member` 只在调用方提供时转发 `spawn_options.agent_options`；不带 `spawn_options` 时，请求就是 `{ prompt, parent }`，插件不指定任何 `provider` 与 `model`（ADR 0016）。此后的一切由 Harness 决定：

- **继承的是父会话当前的模型路由，而不是创建时的快照。** 子代理 seam 从父会话最近一次记录的请求头里取 `provider`、`model` 与 `reasoningEffort`，只有在还没有记录过任何请求时才退回父 Agent 的创建选项（`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:49-92`）。Lead 先切到中转再 spawn，成员拿到的就是中转路由；那个旧快照是退路，不是常规路径。
- **成员不会冻结在启动时的模型上。** 同一套解析在每次 spawn 时都执行，因此路由改动之后启动的成员继承新路由；创建时的退路只覆盖“还没发过请求”的父会话（`:49-92`）。
- **路由一变，seam 就会丢掉父会话的 effort**，让选中的模型解析自己的默认值，而不是带着它从未声明过的 effort 去失败（`:88-90`）。

插件自己的活，就是把调用方点名的那几项转发出去。它刻意不在每次 spawn 时强塞一条显式路由：父会话的 `reasoningEffort` 只在路由没变时才会保留（`:88-90`），而官方 subagent 工具那条路由预检并不在这条路径上（`@deepseek-ai/dsh-tool-subagent/lib/index.js:440-448`），所以强塞一个该路由并不支持的 effort，会在成员已经被记为启动之后，让子代理的第一条请求失败。真正会拒绝它的是 provider 一侧的能力门（`@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`）；Session 级的路由白名单属于官方工具（`@deepseek-ai/dsh-tool-subagent/lib/index.js:89-96`），本插件不使用它。

### 没有模型调用，压缩行走会话自己的路由

bundle 自己不发起任何模型调用：没有任何 Host 模块碰 `ctx.llm`，也没有任何代码路径调用 `prepareCall`。补丁启用的那一行 `compaction-basic`，摘要目标是 `configured ?? session.requestHeader().config ?? agent.options`（`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`），也就是会话自己的路由；因此在实测的 profile 里，启用它没有带来新的计费。

### 例外：网页搜索钉死了自己的端点

`web_search` 不属于本插件，而它是这里唯一不看会话路由的组件。基础 bundle 的补丁选中 `searchProvider: deepseek-official`（`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`），而 `dsh-web-search-deepseek` 把端点和模型钉成 `https://api.deepseek.com/anthropic/v1` 与 `deepseek-v4-flash`（`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`），无论聊天路由是什么都发往那里（`:319-320`）。在实测的 profile 里，它产生了 107 次官方请求，其中两次发生在某个会话已经切到中转之后。

**为什么不能简单地改指别处。** 那个插件要求检索在服务端完成：它读取 `web_search_tool_result` 块，一个都没有就抛 `WEB_PROVIDER_ERROR`（`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:61-62`）。一个提供 Anthropic 形状 Messages API 的中转端点照样可能把搜索退回给调用方：直接测中转的 `/v1/messages`，它返回 200，但在带上 `web_search` 工具时回答 `stop_reason: "tool_use"`——正是那个会被拒绝的形状；而它的 `/anthropic/v1/messages` 路径返回 404。

**两条诚实的出路。** 要么在 profile 里禁用那一行（或 `web` 行），不再有请求发往那个端点，搜索就此不可用；要么把它指向真正执行原生搜索的端点。区分两者的测试只有一次请求：带 `web_search` 工具发一条 Messages 请求，读它的回答。出现 `web_search_tool_result` 块，或者一个带回结果的正常结束，说明端点自己在跑搜索；以 `tool_use` 停下，说明它是在让调用方去跑，而本插件会拒绝这种回答。

边界就一句话：**会话的路由管住每一个聊天请求；自己钉死端点的组件是例外，本插件不属于这一类。**

## 运行要求与兼容性

**运行**本 bundle 需要已安装的 Harness 以及它读取的官方包，而不是 npm 依赖：bundle 以链接方式装进 profile，且不导入任何 `@deepseek-ai/*` 包（ADR 0002），所以真正运行的就是这棵工作树。它读取子代理 seam（`startActivation`、`drainChildren`、`sendMessage`、`interrupt`、`listDescendants`）、官方 `agent-team` 服务（收养与成员判定）、`sessionController`（投影过滤与面板覆盖层；宿主没有这项就跳过）、token 计量（上下文压力）、存储域设施，以及智能体注册表与它的 `agent/status` 事件（等待）。`compact_member` 还需要已挂载的压缩后端，补丁里的 `compaction-basic` 条目会启用它。宿主侧效果都带能力探测：Harness 形状变了就跳过那项效果，而不是让加载失败。没有挂载实验性团队 bundle 的 profile 里没有 `tool-agent-team` 行可供补丁禁用；Loader 会就这个缺失目标告警，并跳过该条目。

**开发**测试套件需要 Node 24 和 CI 钉住的那个 flag：`.github/workflows/ci.yml` 设置 `node-version: "24"`，并运行 `node --test --test-isolation=none tests/*.test.mjs`。这个 flag 不是可选项。Node 22 把它写作 `--experimental-test-isolation`，所以这个拼写本身就固定了大版本；而默认 runner 会为每个测试文件起一个进程，作者机器上的沙箱拒绝这种 spawn。CI 与本机跑同一条命令，所以本机通过的含义与 CI 通过相同。

## 从 v0.13 或更早版本升级

v0.14.0 禁用了官方的 `tool-agent-team` 行，因此用过它的 profile 会失去下表中的工具。v0.13.0 的花名册与任务板其余部分不变：存储域、补丁行 id、回收站目录、改名前的环境变量以及记录形状都照旧，所以升级不需要迁移（ADR 0014）。

| v0.14.0 移除的工具 | 改用什么 |
|---|---|
| `spawn_teammate` | `spawn_member`；带 `replace` 的 `spawn_member` 会在同一次调用里启动继任者并退役前任。 |
| `wait_agent` | `wait_members`（v0.15.0）：对成员的实时状态做有界等待。它不唤醒任何人，且在没有成员处于 running 或 provisioning 时立刻回答 `no_progress`。 |
| `team_task_create` | `task_board` 配 `action: "create"`。 |
| `team_task_list` | `task_board` 配 `action: "list"`。 |
| `team_task_get` | `task_board` 配 `action: "list"`，再按 id 读那一行。 |
| `team_task_update` | `task_board` 配 `action: "update"`（状态与 owner）、`"release"`（清空 owner）或 `"delete"`。依赖、优先级与评论的编辑没有替代：自有任务板没有这些字段（ADR 0017）。 |

官方任务板上的行不会迁移，本插件也读不到。把工作留在那里的 Lead 用 `task_board` 重新创建即可，那只是几次 `create` 调用，不是一次迁移。官方的 `list_agents`、`send_message` 与 `interrupt_agent` **不在**被移除之列：它们由 `agent-team` 服务行发布，而那一行保持挂载。

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
- 没有成员在跑时 `wait_members` 回答 `no_progress`；用 `message_member` 唤醒某个成员后，它会在超时之内返回该成员的 target 与 `status: "idle"`；
- Lead 的工具列表里有本插件的工具（含 `wait_members`），没有 `spawn_teammate`、官方的 `wait_agent` 或 `team_task_*` 工具，但仍有 `agent-team` 服务发布的三件：`list_agents`、`send_message`、`interrupt_agent`；
- 官方团队面板的**成员**区列出用 `spawn_member` 启动的成员，空闲成员显示“未运行”，点击可打开它的会话；`retire_member` 之后该行消失，而不是被改标注；
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

没有浏览器半区、没有 HTTP 桥、没有客户端 bundle；v0.3 的设置页面板从未真正渲染，实际也点不动，因此选择移除而不是修复（ADR 0008）。唯一的内置视图是官方团队面板，本插件在宿主会话列表出口对它做只读覆盖：**成员**区列出本插件的活成员，已退役成员则离开这个列表（ADR 0023）。对 Lead 来说，`list_members` 就是控制面：它覆盖官方花名册的成员，以及用官方 `subagent` 工具启动的每个子代理；其余 Lead 工具都从它报告的内容出发——按成员寻址的工具取某一行的 `target`，而 `task_board`、`handoff_template` 与 `wait_members` 读写的是 Lead 自己的记录与这些行所描述的实时状态。

另一个作用域属于成员。`list_my_tasks` 注册在成员 Agent 上而不是 Lead 上，不接受参数，且只读：调用方的会话决定花名册行，因此也决定它能看到哪些行；成员只看得到自己名下的工作，Lead 的工具列表保持不变。正因如此，“继任者从任务板上读正文”这句话才成立——名下有任务的继任者不必再问 Lead，也不必去读插件的存储文件（ADR 0022）。

补丁禁用了官方的团队工具行（P2-07），所以 Lead 能用的花名册调用就是本插件自有的十个工具。官方那行的 `spawn_teammate`、`wait_agent` 与 `team_task_*` 工具都已不在——调用它们会回答 `unknown tool`——每一件在这里都有替代：`spawn_member`、`message_member`、`list_members`、`stop_member`、`task_board`，以及接替 `wait_agent` 的 `wait_members`（v0.15.0）。`wait_members` 监听的是 Harness 自己的 `agent/status`，范围限定在本花名册的成员——官方的等待看不到这些成员；它只观察调用开始之后的变化，所以空闲成员仍要用 `message_member` 唤醒。另有三件工具仍在，且这条补丁移不掉：`list_agents`、`send_message`、`interrupt_agent` 由官方的 `agent-team` **服务**行发布，而那一行保持挂载，因为收养、成员判定与投影过滤都要读它；`list_members` 依旧报出它创建的成员，也正是因为这项服务还在；消失的是官方那行自己的工具集。

## 开发

```sh
node --check index.js actions.js roster.js definitions.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

Node 24 的要求以及 `--test-isolation=none` 为何不可省略，见上面的[运行要求与兼容性](#运行要求与兼容性)；本地门槛就是这三条命令。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `index.js` | Host 插件入口：工具定义、参数校验、Lead 专属权限检查 |
| `actions.js` | 模型侧工具背后的花名册操作 |
| `roster.js`、`trash.js` | 持久花名册（相态、代次命名、收养、迁移），以及带恢复与保留上限的会话回收站 |
| `definitions.js` | `team/` 层：扁平 frontmatter 解析器、成员定义扫描及其上限、团队文件的交接书模板，以及两者解析所用的工作目录 |
| `host-hooks.js` | 投影过滤（剔除已退役 id，并把本插件的活成员追加进团队面板）与花名册名额补偿 |
| `tests/`、`scripts/check.mjs` | 单元测试，以及 CI 会跑的仓库检查 |
| `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg`、`.github/` | bundle 本体、CI workflow 与模板 |
| `PLAN.md`、`PROGRESS.md`、`docs/` | 待办任务、只追加的变更日志，以及双语的设计文档与 ADR |

## 文档与参与

[docs/INDEX-zh.md](docs/INDEX-zh.md) 是文档地图；设计文档在 [docs/architecture-zh.md](docs/architecture-zh.md)；难以回退的决策在 [docs/adr/](docs/adr/)。AI 助手请先读 [AGENTS.md](AGENTS.md)；分支、提交与 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
