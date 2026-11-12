# dsh-team

[English](README.md)

> 只是换人，不是换活。

一个 DeepSeek Harness 的 profile bundle，专补官方智能体花名册做不到的那件事：让成员离场。Lead 可以退役成员、从自己掌控的回收站把它恢复回来，也可以换成一位继任者——继任者接手 assignment、当时正在推进的工作，以及指向 Lead 自有任务板的指针。花名册归本插件所有，没有浏览器半区。

[github.com/FrozenYty/dsh-team](https://github.com/FrozenYty/dsh-team)

## 插件是什么

一个 Host 插件加一条 bundle 补丁：补丁插入 `dsh-team`，启用官方默认关闭的 `compaction-basic` 行，并禁用官方的 `tool-agent-team` 行；插件不导入任何 Harness 包、不写会话事件，状态存放在以 Lead 会话 id 为键的 `storageDomain` 域里（ADR 0003）。官方的团队**服务**行（`agent-team`）保持挂载，因为收养与投影过滤都要读它。名称在 v0.10.0 改过；存储域、补丁行 id 与回收站目录刻意没有跟着改（ADR 0014）。

## 状态

- 当前版本：v0.25.1。
- **在作者本机 profile（已安装本 bundle）上实测**：退役、恢复、发消息、停止，以及一次替换——继任者完成了前任的任务（v0.5.0、v0.6.0）；回收站上限（v0.7.0）与可配置上限（v0.8.0），配置值生效、越界值在加载时被拒绝；临时成员清扫（v0.9.0）——两个临时成员跑完后，下一次 `list_members` 返回 `swept: 2` 与两个目标，两行都变为 `retired`；交接书模板（v0.11.0）——存下的模板带唯一标记，继任者原样复述整段初始消息（标记与代入后的字段都在），未知占位符被点名拒绝，不含 `{assignment}` 的模板被拒绝并给出理由，清除后回到内置交接书；`spawn_options`（v0.12.0）——成员在转发的 `cwd` 中启动并报回该目录，合法的 `agent_preset` 可以运行，未知 preset id 返回 `started: false` 与 `reason: preset-not-found` 并列出已声明的 id，换一个模型 id 可以运行并回复，不带选项的 spawn 不携带 `started_with`（那是当时的行为，也是 v0.22.0 改掉的那一条：现在这种 spawn 会报出 `started_with.route_source`）；任务板（v0.13.2）——任务被创建并由成员持有，带 `replace` 的 `spawn_member` 返回 `transferred: 1` 与任务 id、且前任已退役，继任者的交接书点出该 id 与标题，不带继任者的 `retire_member` 返回 `unowned: 1` 与 id。
- **本版要回答的成本边界，是在运行中的 profile 上实测出来的。** 切到中转之后，清点 60 份会话日志发现 18 份仍停在 `deepseek-official/deepseek-flash`——其中好几份是活团队的成员，而当时活着的 Lead 会话都在中转上——因为成员的路由在启动时就写进了自己的会话头，没有任何东西会给它改路由。v0.22.0 在 spawn 时转发 Lead 当前的路由、把它记在成员记录上，并标出路由已不再是 Lead 当前路由的成员。真机那一半——启动出的子代理**自己** `request/header` 上的路由——仍是所有者安装后的验证项（ADR 0024）。
- **工具面在真机上实测**（v0.14.0，安装前后各读一次 `listTools`）：官方那行退役后，`spawn_teammate`、`wait_agent` 与 `team_task_*` 工具已从 Lead 的工具列表消失，调用它们会回答 `unknown tool`；本插件的 `spawn_member` 与 `task_board` 仍在。另有三件工具仍在，且这条补丁移不掉：`list_agents`、`send_message`、`interrupt_agent` 由 `agent-team` **服务**行发布，而本 bundle 刻意保留这一行，因为收养、成员判定与投影过滤都要读它。`wait_agent` 在 v0.15.0 之前在这里没有对应物；现在由 `wait_members` 接替，它建立在 Harness 自己的 `agent/status` 事件上，且仅由单元测试覆盖——真机上的订阅还没有跑过。
- **只有真机安装才能暴露的两次失败**，各一行；两次都在出问题的那个版本内修复，现在各由一项检查或测试覆盖：v0.12.0 的 bundle 安装后无法激活，直到去掉一个 schema 关键字（同版本；现在 `scripts/check.mjs` 会拒绝该关键字）；v0.13.0 的替换返回了宿主拒绝的结果，直到 v0.13.2 声明了这些字段（现在 `tests/entry.test.mjs` 会用每个工具自己声明的输出 schema 校验每个回答）。
- **一次真机运行发现了本版要补的缺口。** 一位继任者枚举自己的工具，发现没有任何花名册工具（它们全都是 Lead 专属的），于是直接读取 `~/.dsh/storages/team_roster.json` 来找它继承的任务正文。v0.20.0 在成员作用域注册了一件只读工具 `list_my_tasks`，并修正了 `{task_board}` 指针——原先它指向官方任务板，还让成员去问 Lead。在真实成员里调用一次，仍是所有者安装后的验证项（ADR 0022）。
- **仅由单元测试覆盖**，没有真机 profile 跑过：`label` 与 `assignment` 写入时的长度上限；spawn 尚在进行时发起退役；两个花名册操作重叠时的丢失更新保护；“仍在运行的成员永不被清扫”；路由解析不出来时 spawn 拼出的精确 request；任务板写入时的上限与真机没走到的交接矩阵格子；任务正文的 2000 字符上限、真机上必然看不到的“读取与写入之间插入一次交接”这种交错（测试用表自己的串行 `update` 钩子模拟），以及工作板写入不会覆盖交接这条规则；`wait_members` 的事件接线、超时、取消与无进展路径；整个成员定义层（v0.16.0）——读文件、优先级回报与每一类拒绝；团队文件层（v0.19.0）——三来源优先级、写入拒绝、占位符退路与保留文件名；成员作用域（v0.20.0）——owner 过滤、空答案、非成员拒绝、注册到成员 Agent 上，以及一次真实回答的 schema 一致性；以及路由层（v0.22.0）——转发、调用方选项优先、两条兜底路径、`reasoning_effort` 从不额外添加，以及陈旧路由标记的设置、清除与“绝不猜测”；以及生存期层（v0.25.0）——声明的生存期与它的拒绝、清扫的三个条件、工作板的否决与它报出的 id、真实 `retire_member` 工具上两个方向的同意门槛、消息重新打开一次性成员而不改写声明、反复交派的建议，以及那个建议所依据的两个记录字段；v0.25.1 把它收窄到“成员带着什么”，每种携带物各有用例，什么都没带的成员要么凭一个 stated reason 退役、要么在没有 reason 时被拒绝为 `needs-reason`。由定义真正启动一个成员、真机读取一次团队文件、由真实成员调用一次 `list_my_tasks`、真实子代理自己 `request/header` 上的路由，以及一次真机清扫与一次真机同意拒绝，是所有者安装后的验证项（ADR 0018、ADR 0021、ADR 0022、ADR 0024、ADR 0026）。
- 安装进 profile 有真实副作用，是否安装由所有者决定。
- 完整历史（只追加）：[PROGRESS.md](PROGRESS.md)。

## 为什么需要它

官方实验性 Agent Teams 的花名册无法真正让成员离场。它由 Lead 会话的只追加事件日志折叠而来，成员相态封闭为 `provisioning | active | failed`：投影对任何离开终态的转换都会抛错，并把这次抛错记为永久失败，此后该 Lead 的每一次 Team 读取和变更都会抛错——伪造一条“已退役”记录不是安全失败，而是彻底毒化该会话的投影（ADR 0001）。`maxMembers`（16）检查的是一个只增不减的列表；名字永不复用；整套契约里没有删除；上游进行中的重构依旧把删除推后。另外，这个 profile 出厂关掉了压缩后端。

本插件补上缺的那一半，不 fork 官方花名册：在 Harness 子代理底座上维护自己的花名册，有真正的 `retired` 相态、下一代可复用的名字，以及一个“移动而非删除”的会话回收站。

## 能做什么

| 工具 | 行为 |
|---|---|
| `spawn_member` | 把成员作为一个可续跑的子代理启动，可用 `definition` 从磁盘上的成员定义启动，也可通过 `spawn_options` 给它自己的工作目录、模型路由或 agent preset；带 `replace` 时从交接书启动继任者，并在同一次调用里退役前任。`lifetime` 说明成员能活多久：`standing`（默认）是你预期还会再用的角色，永不自动退役；`one-shot` 为一件工作而建，清扫在它跑过、停下且不拥有任何未完成任务之后退役它——`ephemeral: true` 是 `one-shot` 较早的拼写。生存期只属于这次调用：既不会从前任继承，也不会从定义文件继承。不点名任何模型时，成员跑在**本会话当前的路由**上：插件从会话解析 `provider` 与 `model` 并转发，`started_with.route_source` 说明路由来自调用、由插件解析，还是未解析而继承。 |
| `list_members` | 该 Lead 控制的全部成员与子代理：本插件的花名册、官方花名册创建的成员，以及用官方 `subagent`／`subagent_fork` 工具启动的每个子代理。每行带回 target、子会话 id、相态、代次、label、记录在案的 assignment、它 spawn 时声明的 `lifetime`（记录上的 `ephemeral` 是同一件事）、被派活两次及以上的一次性成员上的 `retasked: true` 与一句说明、启动时的 `route`、实时状态、`compactable`，驻留时还有上下文压力。路由已不是 Lead 当前路由的成员会被标上 `route_stale: true`，并附一句 `route_note` 点出两条路由以及替换它的那次调用。读取会先清扫“跑过、停下且不拥有任何未完成任务”的一次性成员，并报告 `swept`／`swept_targets`；被工作板否决留下的成员改用 `blocked`、`blocking_tasks` 与 `blocking_note` 报告。它还会返回 `host_hooks`：面板过滤器、`list_agents` 过滤器与名额补偿各装没装上、它们正在剔除多少个墓碑 id，以及某个缺席的原因。 |
| `wait_members` | 阻塞当前这一轮，直到某个成员的实时状态发生变化或超时到期，并报告是哪个成员、变成了什么。有界：默认 30 秒，最长一小时。没有成员处于 running 或 provisioning 时立刻回答 `no_progress`，绝不唤醒任何人，也不等待任务板写入或消息被处理。 |
| `message_member` | 向活着的成员投递一条消息，并可顺带替换记录在案的 assignment；已卸载的可续跑成员会从自己的会话冷恢复，一次性子代理不能。消息永不改变生存期：给一次性成员发消息会重新打开它（完成证据被丢掉，结果回答 `reopened: true` 与未变的 `lifetime`），因此在它再次跑过并停下之前，清扫会放过它。 |
| `stop_member` | 取消成员当前这一轮；激活与收件箱保留，稍后再发消息即可继续。 |
| `retire_member` | 排空、立碑、把持久化会话移进回收站（移不动时改由工作区归档隐藏），再执行保留上限。对已退役成员重复调用是无操作，并会说明这一点。**一次调用能做什么取决于这个 standing 成员还带着什么**：带着记录在案的 assignment、一条 `open` 行、或反复交派的证据时，它回答 `retired: false, reason: "needs-confirmation"`，用 `carries` 点出查到了什么，并在下一次调用带上 `confirmed` 里本人的原话引用后才退役；三者都没有时属于打扫，一个非空 `reason` 就能一次调用退役它——没有 reason 的调用回答 `reason: "needs-reason"`。一次性成员、由替换启动的继任者、以及处于 `failed` 或已 `retired` 的记录都不需要确认。 |
| `restore_member` | 把回收站里的会话移回记录的原始路径，记录转回 `active`；产物已被剪除时给出带类型的拒绝。 |
| `compact_member` | 对驻留且空闲的成员强制压缩一次，返回 `done`、`busy`、`not-resident`、`nothing-to-compact` 或 `failed`。 |
| `handoff_template` | 读取、设置或清除继任者收到的交接书：不传 `template` 即读取生效的那份及其 `source`（`file`、`stored` 或 `builtin`），传入模板即保存，传空串则回到内置版本。Lead 项目里的 `team/team.md` 只要存在就胜出，因此保存或清除都会带着该文件的路径被拒绝，并要求编辑它。 |
| `task_board` | 该 Lead 自有的工作板：用 `action` 选择 `create`、`list`、`update`、`release` 或 `delete`。一条任务有 id、标题、一段有上限的正文（说明“完成指什么”、工作停在哪里）、`open` 或 `done`，以及可选的成员 `owner`；未完成的任务会随替换一起过去，正文随之移动。 |
| `list_my_tasks` | **成员自己的工具，不是 Lead 的**：只读返回 `owner` 正好是本成员 target 的行，每行带 id、标题、正文、状态与时间戳，以及还有多少条未完成。它不接受参数——调用方的会话就是选择器。名下没有任务的成员得到空列表，而不是报错；其他成员的行、无主的行与 Lead 的整块工作板都看不见。工作板只有 Lead 能写，所以成员在回复里说明某条任务已完成，由 Lead 把该行标记为 done。 |

**成员跑在本会话的 API 上，哪怕你一个模型都没点名。** 没有 `spawn_options.agent_options` 时，`spawn_member` 从会话本身解析 Lead 当前的 `provider` 与 `model` 并转发，因此成员用的是启动它的那个会话的 API；插件转发出去的这条路由同时记在成员记录上，并在行里报回来。`started_with.route_source` 说明走的是哪条路径——`caller` 表示调用（或其定义）点名了路由，`plugin` 表示插件解析并转发了它，`inherited` 表示什么都没能转发。只有最后一条路径把继承交给 Harness 自己，原因的认领字段 `route.select_reason` 会说明是哪种：`no-session-route`（会话此刻还没有可读的路由）或 `capability-absent`（spawn provider 没有声明 `agentOptions`）。**`reasoning_effort` 从不额外加上**：转发 Lead 自己的路由本来就让它原有的 effort 在合并里保留，而为一个插件从未询问过的模型塞一个 effort，正是会让子代理第一条请求失败的做法。

**成员可以换个目录、换个模型、少几件工具。** `spawn_member.spawn_options` 转发 Harness 本就支持的三个字段，任何一个省略都继承 Lead 的值——只有一个例外：改了 `provider` 或 `model` 却没给 `reasoning_effort` 时，新路由解析自己的默认值。`cwd` 用于单独的检出或 worktree（相对路径按 Lead 的目录解析，子代理保留 Lead 的权限根，因此沙箱授权之外的目录仍会被拒绝）；`agent_options` 携带 `provider`、`model`、`reasoning_effort` 与 `max_tokens`，最后一项是 token 上限，也是挑更便宜模型的地方；`agent_preset` 用于更窄的工具集——preset 是获得只读成员的**唯一**途径，因为 Harness 没有按次调用的工具白/黑名单，而 preset id 来自 profile 的 bundle 补丁，不是某个目录路径。`started_with` 是插件转发内容的回执，不是子代理解析结果的确认：它原样回显传入的字段，既不解析也不回读，所以模型有没有真正生效，要靠成员的第一条请求去确认，而不是这个字段。Harness 拒绝的启动会返回 `started: false`、原因与出路；陈旧 target 的拒绝会带 `current_holder` 指出该名字现在的活持有者，于是换过人的 Lead 可以直接改投新名字。

**在模型切换之前启动的成员会一直留在旧路由上，而花名册会把它们点出来。** 活的成员无法被改路由：它的 provider 与 model 在启动时就写进了自己会话的请求头，之后发消息或唤醒都沿用它们。因此 `list_members` 会把每个成员记录在案的 `route` 与 Lead 当前路由比较，凡是不一致的就标上 `route_stale: true`，并附一句 `route_note` 点出两条路由。这个标记回答的就是「我的哪个成员还在用旧 API 计费」。**清掉它的办法是替换掉这个成员**：`spawn_member { replace: "<target>" }` 会在当前路由上启动继任者，并在同一次调用里接手前任的未完成工作（ADR 0009、ADR 0017），那条陈旧的行随后以 retired 离开 `list_members`。这里刻意没有 reroute 工具：人换了，工作本来也得跟着走。

三个宿主侧效果让已退役成员离开内置列表，也让本插件的成员出现在其中。会话列表出口的投影会从 `subagentCatalog` 与 `agentTeam` 帧中剔除已退役 id，于是**子智能体**选择器与内置**成员**面板不再渲染该成员（不改宿主源码，不重建 Web 应用）；同一个 `agentTeam` 值随后还会追加该 Lead 的活成员，于是面板会列出本插件启动的成员，点击即可打开该成员真实的会话。已退役成员则是**离场**——面板不会把它留成一行并标注“已退役”，因为面板的相态词表里没有这个值。`list_agents` 工具背后的官方花名册读取也会丢掉同一批已退役 id。spawn 期间，官方花名册的有效 `maxMembers` 按该 Lead 的退役数临时抬高，于是退役一个就还回一个名额。三个效果都挂在自己所包装的服务上，因此在插件激活之后才发布 `sessionController` 的 profile 仍然能装上过滤器，而不是悄悄丢掉它；`list_members` 会返回 `host_hooks`，逐个报告 `installed`／`absent` 与正在剔除的 id 数，于是缺席的钩子有解释而不是靠猜（ADR 0025）。另外，补丁把官方 `compaction-basic` 行以 `disabled: false` 启用，自动压缩因此覆盖进程内所有智能体，子代理也包括在内。

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

两条 `---` 之间是扁平 frontmatter，其下的 markdown 正文就是成员的提示词。`name` 与 `label` 必填，其余可接受字段都是 `spawn_member` 本来就有的、用来描述角色的那些：`assignment`、`cwd`、`provider`、`model`、`reasoning_effort`、`max_tokens` 与 `agent_preset`。**定义不能声明生存期**：`lifetime` 不是可接受字段，`ephemeral` 在 v0.25.0 被移除，因此文件里带任何一个都会连名字与理由一起被拒绝，并指出该用哪次调用。生存期是关于某一个成员的声明——本人同意它自行离开的凭据——而文件描述的是角色，所以在 `replace` 上继承一个生存期会退役继任者、并让它刚接手的工作变成无主。这份清单就是全部子集——嵌套值、锚点、块标量、列表、重复键或未知字段，都会连文件名与行号一起被拒绝，而不是被猜测；带引号的值只去掉引号，不解释任何转义。

**调用侧优先，且返回结果会说明这一点。** 传给 `spawn_member` 的每个字段都会覆盖文件里的同名项，返回结果中的 `definition` 对象会给出文件名、来自文件的部分（`from_file`）以及被你覆盖的部分（`overridden`）。有两个字段的来源不是调用。`prompt` 是调用无法覆盖的那个：正文是成员的常驻提示词，调用里的 `prompt` 会追加在它之后，`definition.prompt` 会把这个事实报成 `file+call`。另一个是 `replace` 时的 `assignment`：前任记录在案的 assignment 压过文件里的，因为继任者继承的是工作而不是角色——文件里的只在「前任没有记录」时才生效——而 `definition.assignment` 会报出 `call`、`predecessor` 或 `file` 中哪一个胜出。文件里的 `cwd`、模型路由与 preset 确实会作用于继任者；前任的那几项不会被继承，因为它们是启动选项，不是记录字段（ADR 0019）。

**一个坏文件不会藏起其他文件。** 格式错误的定义会在本来成功的 spawn 结果里，用 `definition.problems` 按路径与行号报出，合法的定义照常可用。同一个名字被两个文件声明时，两边都不可用——因为悄悄挑一个会让另一个文件的修改彻底不可见。上限是拒绝而不是截断：单文件 16 KiB，单次扫描 64 个文件——超过这个数量时整次扫描被拒绝，而不是只服务一个残缺的子集。路径同样绝不猜：profile 若没有挂载 `workingDirectory` 服务，就返回 `started: false` 与 `reason: "working-directory-unavailable"`，并且不预留任何成员。

`team/team.md` 预留给团队作用域，不是成员定义：成员仍然可以在别的文件里声明 `name: team`，但这个文件名本身会被定义扫描跳过。这正是避免同一个文件在每次 spawn 时都被报成坏定义的原因（ADR 0021）。

## 生命周期

**成员是一种分工，不是一件任务。** 退役回答的是“这个分工暂时不需要了”，而不是“这件活干完了”：刚做完一件事的成员，下一轮可能还要用，所以两轮之间闲置的成员不是退役对象。当这是需要判断的事、而不是已经定下的决定时，Lead 应当先问人再退役。

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

## 成员生存期

成员是一份分工，不是一件任务。因此 `spawn_member` 用一个字段问清楚它能活多久：`lifetime: "standing"`（默认）是你预期还会再用的角色，`lifetime: "one-shot"` 是为一件工作创建的成员。`ephemeral: true` 是 `one-shot` 较早的拼写，仍然有效；两者同时传且相互一致时接受，相互矛盾时拒绝。`list_members` 在每一行报告 `lifetime`。

**standing 成员永不自动退役。** 无论空闲多久它都不进入清扫的候选。`retire_member` 需不需要本人的原话，取决于这个成员还带着什么——这道门保护的是本人结束一个**角色**的决定，而不是每一次打扫：

- **它还带着东西**——记录在案的 `assignment`、本 Lead 工作板上的一条 `open` 任务、或被交派工作至少两次的证据——那么第一次调用什么都不退役，回答 `retired: false, reason: "needs-confirmation"`，用 `carries` 点出查到了什么，并给出要问本人的 `question`（有 `owns_tasks` 与 assignment 时也一并给出）。把这个问题问过本人，再调用一次，把 `confirmed` 设成本人回答的**原话引用**——是本人的句子，不是复述，也不是布尔值：本插件没有人类界面（ADR 0008），模型自己设的标志谁也问不到。引用的那句话会原样回显进结果，因此留在记录里。
- **它什么都没带**——没有 assignment、没有 `open` 行、从未被反复交派——那它就是赤裸的残留，打扫由你做主：传一个非空 `reason`，一次调用就退役它，不问任何人。结果会用文字说明它什么都没带、是按打扫移除的。没有 reason 的调用回答 `retired: false, reason: "needs-reason"`，什么都不改——reason 是墓碑留下的东西，后来的人能据此看出残留为什么被清掉。

一次性成员不需要确认，因为声明它为一次性本来就是本人的事先同意；替换启动的继任者也不需要，因为替换是在延续这个角色，而不是结束它。从未成为角色的记录同样豁免：`failed` 的从未启动，已 `retired` 的已经没有生命可以结束。这里没有新增任何配置开关或第三种生存期取值：收窄的依据是调用面前这个成员带着什么，因此规则关于成员本身，而不是关于某个 profile 的策略。

**一次性是扇出场景。** 插件收不到完成事件，因此退役这类成员的清扫只在 `list_members` 与 `spawn_member` 调用开始时运行，并且要求三件事同时成立：成员启动过、已不驻留、且不拥有本 Lead 工作板上任何 `open` 任务。从未启动过的不会被清扫，仍在运行的不会被清扫，仍持有工作的也不会——工作板是一道**否决**，而空工作板从不是触发器，因为缺失的一行与成员的 `inactive` 状态都无法把“已完成”与“没人写下来”区分开。被否决的成员仍然列出，读取会说明原因：`blocked` 统计数量，`blocking_tasks` 列出这些行的 id，`blocking_note` 点名清除每一行的那一次 `task_board { action: "update", … }` 调用。关闭这些工作才是让一次性成员可以离开的原因；它从来不是“该成员已完成”的证明。

被清扫的成员走普通退役流程，因此墓碑仍然列出，名额也照常返还。触发清扫的那次调用会报告 `swept` 与 `swept_targets`；既没退役也没否决任何东西时不加任何字段。

**消息只会重新打开一次性成员，而不是改写它的声明。** 再次给它派活会丢掉清扫所依赖的证据，因此在它再次跑过并停下之前不会被清扫，而它的生存期仍是 `one-shot`——结果会回答 `reopened: true`。被派活两次及以上的一次性成员会在该行被标上 `retasked: true`，并附一句说明它多半是个 standing 角色、点名声明它的那次调用。没有任何东西会自动转换它：生存期是本人的同意，插件只报告自己数出来的计数。

**定义不能声明生存期。** `lifetime` 不是可接受的 frontmatter 字段，`ephemeral` 在 v0.25.0 被移除；文件里带任何一个都会被按名字拒绝并给出理由。文件描述的是角色，因此由角色声明的一次性会被每一次替换的继任者继承——而一个在本轮结束就自行退役的继任者，恰好会把替换刚交给它的工作变成无主。改为在 `replace` 调用上声明它（ADR 0026）。

## 限制与刻意省略

五件本 bundle 不做的事，每一件都是决定，而不是遗漏。

- **每个 Lead 一条记录，没有跨进程锁。** 花名册与这个 Lead 的任务板放在同一个 `storageDomain` 域的同一份 JSON 文档里，以 Lead 会话 id 为键（ADR 0003）。该设施没有跨进程锁（ADR 0010），所以两个 Harness 进程共用一份存储时是“后写者赢”：如果两边同时写同一个 Lead，后一次写入会替换前一次，而它没读到的更新就此丢失。对单个正在运行的 Harness 来说这是正确的，子代理本身也这样工作；插件不再加第二把锁，也没有合并协议。
- **没有自己的浏览器半区。** 没有本插件自己的面板、没有 HTTP 桥、没有客户端 bundle。v0.3 的设置页面板从未在真实 profile 里渲染过，点击也无效，因此 v0.4 选择删除而不是修复（ADR 0008）。面板显示的内容是在宿主会话列表出口覆盖上去的（ADR 0023）：**成员**区列出本插件的活成员，已退役成员则离开面板而不是被标注。覆盖层只读：它既不能退役也不能替换任何东西，更不能写会话日志，所以官方折叠那套封闭相态（ADR 0001）约束不到它。所有操作仍然是面向模型的工具；将来若要做 UI，那是一个新决定，起点是 `actions.js` 里的操作。
- **官方的 `agent-team` 服务行保持挂载。** 收养、成员判定与投影过滤都要读它，所以补丁不能把它禁用——而这项服务自己也发布三件面向模型的工具：`list_agents`、`send_message`、`interrupt_agent`，它们因此仍留在 Lead 的工具列表里。补丁退役的是官方**工具**行（`tool-agent-team`）；移除那三件会连服务、连同本插件的收养一起带走（ADR 0017）。
- **被剪除的墓碑无法恢复。** 成功移入产物的那次退役会执行每个 Lead 的回收站上限，删掉超出的最旧条目。墓碑保留 `trashPath`，状态记为 `trashState: pruned`，但字节已经不在，因此 `restore_member` 以 `reason: "pruned"` 拒绝，且绝不调用工作区（ADR 0011）。长期存续的团队若需要超过 20 份可恢复会话，请提前调大上限。
- **任务板是交接通道，不是项目跟踪器。** 一条任务只有 id、标题、一段有上限的正文、`open`/`done` 和可选的 owner，刻意没有优先级、依赖、评论、子任务与截止日期（ADR 0017、ADR 0020）。依赖尤其如此：它需要一张图和一条排序规则，而交接还得决定“依赖仍未完成的任务怎么办”；这个先后顺序留给 Lead 判断。任务板只回答一个问题：继任者现在扛着什么。

## 成本与模型路由

**这一节要回答的怀疑，以及证实它的实测。** 接上中转供应商之后，所有者的账户仍在计费。清点 60 份会话日志发现，其中 18 份仍停在 `deepseek-official/deepseek-flash`，好几份还是活团队的成员，而当时活着的 Lead 会话都在中转上：成员的 provider 与 model 在它启动时就写进了自己会话的请求头，之后的任何切换都到不了它。下面写清楚本插件选择什么、Harness 替它选择什么，以及这份 profile 里唯一一个不看会话路由、自己钉死端点的组件。

### 谁来选成员的模型

**现在由插件说明路由，并把它记下来。** 没有 `spawn_options.agent_options` 时，`spawn_member` 从 `session.requestHeader().config` 解析 Lead 当前的 `provider` 与 `model`——这正是 seam 自己的继承来源——并作为请求的 `agentOptions` 转发，因此成员用启动它的那个会话的 API 启动，说出来的是插件（ADR 0024）。显式的 `spawn_options.agent_options` 仍然逐字段优先，而调用方没点名的那一项由同一次读取补全，于是 `started_with.route_source` 能说明路由来自调用（`caller`）、由插件解析（`plugin`），还是未解析而继承（`inherited`）。

- **`reasoning_effort` 从不转发。** seam 只在它解析出的路由与父路由不同时才丢掉父会话的 effort（`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:88-90`）；转发 Lead 自己的路由恰恰是“没变”的那种情形，所以 Lead 的 effort 无需发送也会在合并里保留。调用方自己点名 `reasoning_effort` 时照旧转发，那是调用方的字段。
- **每一次解析失败都是兜底，而不是一次失败的 spawn。** 会话路由读不出来（`no-session-route`）与 provider 没有声明 `agentOptions`（`capability-absent`，能力门在 `@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`）这两种情况都不转发任何东西，把路由记为 `route.source: "inherited"` 并带上原因，然后交给 Harness 按以前的方式继承。那种情况下的请求就是 `{ prompt, parent }`；绝不为了修路由而弄坏一次 spawn。
- **活的成员无法被改路由。** 它的路由就在自己已记录的请求头里。正因如此，`list_members` 会标出记录在案的 `route` 已不是 Lead 当前路由的成员（`route_stale: true` 与一句 `route_note`），也正因如此补救办法只有一次替换：`spawn_member { replace: "<target>" }` 在当前路由上启动继任者，并接手它的未完成工作（ADR 0009、ADR 0017）。

插件不像官方 subagent 工具那样用 `ctx.llm` 预检路由（`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`，Session 级白名单在 `:89-96`）：那条预检校验的是**调用方选定**的路由是否在 profile 白名单里，而这里转发的是该会话已经在发请求的路由——它是被证明过的，不是被提议的。

### 没有模型调用，压缩行走会话自己的路由

bundle 自己不发起任何模型调用：没有任何 Host 模块碰 `ctx.llm`，也没有任何代码路径调用 `prepareCall`。补丁启用的那一行 `compaction-basic`，摘要目标是 `configured ?? session.requestHeader().config ?? agent.options`（`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`），也就是会话自己的路由；因此在实测的 profile 里，启用它没有带来新的计费。

### 例外：网页搜索钉死了自己的端点

`web_search` 不属于本插件，而它是这里唯一不看会话路由的组件。基础 bundle 的补丁选中 `searchProvider: deepseek-official`（`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`），而 `dsh-web-search-deepseek` 把端点和模型钉成 `https://api.deepseek.com/anthropic/v1` 与 `deepseek-v4-flash`（`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`），无论聊天路由是什么都发往那里（`:319-320`）。在实测的 profile 里，它产生了 107 次官方请求，其中两次发生在某个会话已经切到中转之后。

**为什么不能简单地改指别处。** 那个插件要求检索在服务端完成：它读取 `web_search_tool_result` 块，一个都没有就抛 `WEB_PROVIDER_ERROR`（`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:61-62`）。一个提供 Anthropic 形状 Messages API 的中转端点照样可能把搜索退回给调用方：直接测中转的 `/v1/messages`，它返回 200，但在带上 `web_search` 工具时回答 `stop_reason: "tool_use"`——正是那个会被拒绝的形状；而它的 `/anthropic/v1/messages` 路径返回 404。

**两条诚实的出路。** 要么在 profile 里禁用那一行（或 `web` 行），不再有请求发往那个端点，搜索就此不可用；要么把它指向真正执行原生搜索的端点。区分两者的测试只有一次请求：带 `web_search` 工具发一条 Messages 请求，读它的回答。出现 `web_search_tool_result` 块，或者一个带回结果的正常结束，说明端点自己在跑搜索；以 `tool_use` 停下，说明它是在让调用方去跑，而本插件会拒绝这种回答。

边界就一句话：**会话的路由管住每一个聊天请求；自己钉死端点的组件是例外，本插件不属于这一类。**

## 运行要求与兼容性

**运行**本 bundle 需要已安装的 Harness 以及它读取的官方包，而不是 npm 依赖：bundle 以链接方式装进 profile，且不导入任何 `@deepseek-ai/*` 包（ADR 0002），所以真正运行的就是这棵工作树。它读取子代理 seam（`startActivation`、`drainChildren`、`sendMessage`、`interrupt`、`listDescendants`）、官方 `agent-team` 服务（收养与成员判定）、`sessionController`（投影过滤与面板覆盖层；宿主从不发布它时报告 `panel_filter: "absent"`，而不是悄悄丢掉这个钩子）、`agentTeams.listMembers`（本插件要过滤的官方 `list_agents` 读取）、token 计量（上下文压力）、存储域设施，以及智能体注册表与它的 `agent/status` 事件（等待）。`compact_member` 还需要已挂载的压缩后端，补丁里的 `compaction-basic` 条目会启用它。宿主侧效果都带能力探测，并且各自在所包装的服务存在时才安装：Harness 形状变了就跳过那项效果，并在 `list_members` 里说明，而不是让加载失败。没有挂载实验性团队 bundle 的 profile 里没有 `tool-agent-team` 行可供补丁禁用；Loader 会就这个缺失目标告警，并跳过该条目。

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
- `list_members` 的 `host_hooks` 里，`panel_filter`、`roster_filter` 与 `slot_credit` 在装好后读出 `"installed"`，该 Lead 退役过成员后 `stripped_ids` 不为零；某个钩子从未装上时读出 `"absent"`，其 `message` 会点出它在等哪个服务；
- 对有产物的会话，`retire_member` 返回 `trashed: true` 与 `trash_path`；
- `spawn_member` 带 `replace` 时返回 `predecessor_retired: true`，且继任者处于下一代次；当前任有未完成任务时，结果还会用 `transferred` 报告数量与 id，继任者的交接书里也会点名它们；
- `spawn_member` 带 `spawn_options` 时，返回的 `started_with` 与传入内容逐字段一致，并多一个 `route_source`；若 profile 的 provider 或 preset 注册表拒绝，则返回 `started: false` 与 `reason`；
- 在会话路由可读的 profile 里，不带选项的 `spawn_member` 返回 `started_with.route_source: "plugin"`，该成员自己会话的 `request/header` 记录着同一个 provider 与 model，`list_members` 的行也报出同一对值；在路由切换之前启动的成员，其行会被标上 `route_stale: true`，直到它被替换为止；
- 没有成员在跑时 `wait_members` 回答 `no_progress`；用 `message_member` 唤醒某个成员后，它会在超时之内返回该成员的 target 与 `status: "idle"`；
- Lead 的工具列表里有本插件的工具（含 `wait_members`），没有 `spawn_teammate`、官方的 `wait_agent` 或 `team_task_*` 工具，但仍有 `agent-team` 服务发布的三件：`list_agents`、`send_message`、`interrupt_agent`；
- 官方团队面板的**成员**区列出用 `spawn_member` 启动的成员，空闲成员显示“未运行”，点击可打开它的会话；`retire_member` 之后该行消失，而不是被改标注；**子智能体**选择器与官方 `list_agents` 工具也会同时丢掉这个已退役成员；
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
| `host-hooks.js` | 投影过滤（剔除已退役 id，并把本插件的活成员追加进团队面板）、官方花名册读取过滤、名额补偿，以及这三者的延迟安装 |
| `tests/`、`scripts/check.mjs` | 单元测试，以及 CI 会跑的仓库检查 |
| `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg`、`.github/` | bundle 本体、CI workflow 与模板 |
| `PLAN.md`、`PROGRESS.md`、`docs/` | 待办任务、只追加的变更日志，以及双语的设计文档与 ADR |

## 文档与参与

[docs/INDEX-zh.md](docs/INDEX-zh.md) 是文档地图；设计文档在 [docs/architecture-zh.md](docs/architecture-zh.md)；难以回退的决策在 [docs/adr/](docs/adr/)。AI 助手请先读 [AGENTS.md](AGENTS.md)；分支、提交与 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
