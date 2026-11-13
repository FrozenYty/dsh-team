# 文档索引

> Owner: @FrozenYty · Revisit when: 新增、改名或删除文档时

[English](INDEX-en.md)

本仓库里有什么、哪份文档回答哪个问题、以及改动某样东西时还有哪些必须同步改。新增或移动文档前先读这里。

## 1. 阅读顺序

```
README.md  ->  PLAN.md  ->  PROGRESS.md  ->  docs/architecture-zh.md  ->  与你改动相关的 ADR
```

1. `README.md`——插件是什么、怎么安装。
2. `PLAN.md`——唯一的任务来源，未完成的工作都在这里。
3. `PROGRESS.md`——当前状态为什么是这样，只追加。
4. `docs/architecture-zh.md`——分层、Harness 底座、已发布的接口与风险边界。
5. `docs/adr/`——那些难以回退的决策。

设计主题各自独立成文，不再作为 `architecture-` 的一节：成员的一生见 `docs/member-lifecycle-zh.md`，工作板见 `docs/task-board-zh.md`，交接书及其模板见 `docs/handoff-zh.md`，存储记录与其保留策略见 `docs/roster-storage-zh.md`。§2 是地图。

## 2. 文档地图

| 问题 | 文档 | 语言 |
|---|---|---|
| 这是什么，怎么装？ | `README.md` | 双语 |
| 还剩什么没做，“完成”指什么？ | `PLAN.md` | 英文 |
| 最近改了什么，为什么？ | `PROGRESS.md` | 英文 |
| 每个版本发布了什么？ | `CHANGELOG.md` | 英文 |
| 有哪些层、建立在什么 Harness 底座上、发布了什么接口、风险边界在哪？ | `docs/architecture-zh.md` | 双语 |
| 成员如何在相态之间移动，退役与替换各自做什么？ | `docs/member-lifecycle-zh.md` | 双语 |
| 工作板做什么，替换时未完成的工作去哪里？ | `docs/task-board-zh.md` | 双语 |
| 继任者如何被交接，哪个模板生效？ | `docs/handoff-zh.md` | 双语 |
| 存了什么，回收站如何被约束？ | `docs/roster-storage-zh.md` | 双语 |
| 什么能证明 Host 仍按本插件的预期行事，以及一轮怎么跑？ | `docs/live-acceptance-zh.md` | 双语 |
| 当一条归档记录位于上限之外时，如何按身份找到它？ | `docs/adr/0036-archive-lookup-by-identity.md` | 英文 |
| 成员花费的 token 数据从哪里来，以及为什么它被省略而不是记为零？ | `docs/adr/0037-member-spend.md` | 英文 |
| 哪三个来源回答成员的花费，以及这个数字在墓碑上意味着什么？ | `docs/adr/0038-spend-three-sources.md` | 英文 |
| 成员跑在哪个模型上，什么在计费？ | `docs/routes-zh.md` | 双语 |
| 从旧版本升级要改什么？ | `docs/upgrading-zh.md` | 双语 |
| 为什么花名册要自建而不是扩展官方？ | `docs/adr/0001-own-roster-on-subagents.md` | 英文 |
| 为什么 bundle 入口不导入任何东西？ | `docs/adr/0002-zero-import-bundle-entry.md` | 英文 |
| 花名册存在哪里？ | `docs/adr/0003-roster-storage.md` | 英文 |
| 为什么退役要移动文件、还要改宿主服务？ | `docs/adr/0004-retire-through-persistence.md` | 英文 |
| 设置页面板如何触达 Host，为什么要有 HTTP 路由？ | `docs/adr/0005-share-operations-behind-an-http-bridge.md`——已被 0008 取代 | 英文 |
| 为什么面板只显示一个会话的花名册，又是怎么知道是哪个会话？ | `docs/adr/0006-session-scoped-roster-panel.md`——已被 0008 取代 | 英文 |
| 为什么插件只面向模型？ | `docs/adr/0008-model-only-surface.md` | 英文 |
| 为什么替换要交接记录，以及按什么顺序进行？ | `docs/adr/0009-replacement-handoff.md` | 英文 |
| 为什么每个 Lead 只有一条记录，以及为什么任何东西都不会被自动删除？ | `docs/adr/0010-roster-layout-and-retention.md`——第 3 点已被 0011 取代 | 英文 |
| 为什么回收站有上限，被剪除的成员会怎样？ | `docs/adr/0011-trash-retention.md`——第 1 点已被 0012 取代 | 英文 |
| 为什么回收站上限是一个配置字段，以及为什么入口不声明 Config schema？ | `docs/adr/0012-configurable-retention.md` | 英文 |
| 为什么一次性成员会自行离开，以及清扫为什么需要证据？ | `docs/adr/0013-ephemeral-members.md` | 英文 |
| 为什么插件叫 `dsh-team`，以及哪些标识符没有随之改名？ | `docs/adr/0014-plugin-name.md` | 英文 |
| 为什么交接书是一个可存模板，以及为什么只有一个工具？ | `docs/adr/0015-handoff-template.md` | 英文 |
| 成员如何用自己的 cwd、模型或 preset 启动，陈旧的名字现在指向谁？ | `docs/adr/0016-spawn-capabilities.md` | 英文 |
| 为什么工作板由插件自己拥有，替换成员时到底移动了什么？ | `docs/adr/0017-own-task-board.md`——第 1、4、5、6、11 点已被 0020 调整 | 英文 |
| 为什么成员是磁盘上的文件，以及接受哪一套 frontmatter 子集？ | `docs/adr/0018-member-definitions.md`——第 4 点已被 0019 调整 | 英文 |
| 继任者拿到哪一个 assignment，以及定义在 replace 时意味着什么？ | `docs/adr/0019-definition-precedence-on-replace.md` | 英文 |
| 为什么一条任务带有正文，以及为什么工作板上的写入不能把交接抹掉？ | `docs/adr/0020-task-body-and-write-integrity.md` | 英文 |
| 为什么交接书是一个团队文件，以及为什么文件存在时写入存储会被拒绝？ | `docs/adr/0021-team-file-handoff-template.md` | 英文 |
| 为什么成员能读到自己名下的工作，以及为什么工作板只有一个写入者？ | `docs/adr/0022-member-reads-its-work.md` | 英文 |
| 为什么官方团队面板会列出本插件的成员，以及为什么已退役成员是离场而不是被标注？ | `docs/adr/0023-panel-overlay.md` | 英文 |
| 为什么插件要转发 Lead 的模型路由，为什么从不转发它的 effort，以及为什么掉队的成员会被标出来？ | `docs/adr/0024-forward-the-lead-route.md` | 英文 |
| 为什么宿主钩子要在服务存在时才安装，以及为什么 `list_members` 会报告装没装上？ | `docs/adr/0025-host-hook-install.md` | 英文 |
| 为什么生存期在调用上声明、为什么一条未完成任务能否决清扫，以及为什么退役 standing 成员必须凭本人的原话？ | `docs/adr/0026-declared-member-lifetime.md` | 英文 |
| 为什么花名册住在工作区里的一个文件，以及存储域现在还用来做什么？ | `docs/adr/0027-roster-file-under-the-workspace.md` | 英文 |
| 为什么墓碑记录的是目录名，以及保留上限如何与它匹配？ | `docs/adr/0028-trash-directory-name-not-path.md` | 英文 |
| 为什么成员定义从一条链上读取，以及为什么随包模板会输给工作区里的文件？ | `docs/adr/0029-definition-chain.md` | 英文 |
| 为什么墓碑会离开花名册，以及是什么让它的成员不再出现在官方面板里？ | `docs/adr/0030-tombstone-window-and-archive.md` | 英文 |
| 为什么插件的状态只有文件，以及为什么存储域不再回答读取？ | `docs/adr/0031-files-only-state.md` | 英文 |
| 为什么一次替换会写两条记录，以及为什么链接写成员 id 而不是名字？ | `docs/adr/0032-bilateral-succession.md` | 英文 |
| 为什么宿主存储域被移除，以及为什么路径的祖先是文件时算作没有文件？ | `docs/adr/0033-domain-removed.md` | 英文 |
| 为什么产物的来源按会话根相对存储，以及被带走的花名册按什么解析它？ | `docs/adr/0034-relative-artifact-origin.md` | 英文 |
| 为什么归档可以按请求读取，以及读取者承担了哪些写入者承担不了的规则？ | `docs/adr/0035-archive-readable-on-request.md` | 英文 |
| 上游缺的是哪段成员生命周期？可直接贴成 issue 的版本 | `docs/upstream-lifecycle-gap-zh.md` | 双语 |
| 分支、提交、合并怎么做？ | `CONTRIBUTING.md` | 英文 |
| 助手在本仓库的规则？ | `AGENTS.md` | 英文 |

## 3. 权威顺序

两份文档冲突时，以较新者为准，顺序如下：

1. 已接受的 ADR；
2. 设计文档（`docs/architecture-zh.md` 与 `docs/member-lifecycle-zh.md`、
   `docs/task-board-zh.md`、`docs/handoff-zh.md`、`docs/roster-storage-zh.md`）；
3. `PLAN.md`；
4. `README.md`；
5. `PROGRESS.md`（历史记录，描述的是当时的状态，永不回改）。

在 Harness 行为上，已安装的 Harness 高于以上全部。若本仓库与运行中的 Harness 冲突，错的是本仓库。

## 4. 改一样东西要连带改什么

| 若你改了 | 同时更新 |
|---|---|
| 工具名、参数或返回字段 | `docs/architecture-zh.md` §2 或 §5、`actions.js`、`README.md` + `README-zh.md`、`PLAN.md` 对应任务文字 |
| 哪件工具注册到哪个作用域，或成员能读什么 | `index.js`、`actions.js`、`docs/architecture-zh.md` §5 与 §5.2、`README.md` + `README-zh.md`、ADR 0022 |
| 某个操作的行为或失败原因 | `actions.js`、`index.js` 里的工具 schema、`docs/architecture-zh.md` §5 |
| 收养覆盖什么，或它消费的发现行形状 | `actions.js`、`roster.js`、`docs/architecture-zh.md` §5.1、`README.md` + `README-zh.md` |
| 花名册相态或转移 | `docs/member-lifecycle-zh.md` §1 的状态矩阵；若模型变了，另写 ADR |
| 成员的生存期、什么可以否决清扫，或一次退役必须带回什么 | `docs/member-lifecycle-zh.md` §2、`roster.js`、`actions.js`、`index.js` 里的工具 schema、`README.md` + `README-zh.md`、ADR 0026 |
| 交接规则——替换、退役或恢复时成员的未完成任务怎么处理 | `docs/task-board-zh.md` §2 的交接矩阵、`actions.js`、`README.md` + `README-zh.md`、ADR 0017 |
| 任务行的 `body`，或工作板写入如何基于已存记录构建 | `roster.js`、`actions.js`、`index.js` 里的工具 schema、`docs/task-board-zh.md` §1 与 §3、`README.md` + `README-zh.md`、ADR 0020 |
| 成员定义的格式、接受的 frontmatter 子集或定义的查找链 | `definitions.js`、`docs/architecture-zh.md` §6、`README.md` + `README-zh.md`、ADR 0018、ADR 0029 |
| 团队文件的格式、保留名 `team.md`、模板的三个来源或写入拒绝 | `definitions.js`、`actions.js`、`index.js`、`docs/handoff-zh.md` §1 与 §2、`README.md` + `README-zh.md`、ADR 0021 |
| 定义字段在 replace 时由哪个来源胜出，或文件可以就成员的生存期声明什么 | `docs/architecture-zh.md` §6.1 的定义矩阵、`actions.js`、`index.js`、ADR 0019、ADR 0026 |
| bundle 配置键或补丁行 | `README.md` + `README-zh.md`、`docs/architecture-zh.md` §1 |
| 持久记录结构 | `docs/roster-storage-zh.md` §1、一份新 ADR、`PROGRESS.md` 里的迁移说明 |
| 投影出口、官方团队面板或官方 `list_agents` 读取显示什么，或宿主钩子装没装上 | `host-hooks.js`、`index.js`、`docs/architecture-zh.md` §2.4、`README.md` + `README-zh.md`、ADR 0023、ADR 0025 |
| 成员启动时用哪条路由、哪个来源优先，或掉队成员是否被标出 | `actions.js`、`roster.js`、`index.js` 里的工具 schema、`docs/architecture-zh.md` §2.5 与 §4、`docs/roster-storage-zh.md` §1、`docs/routes-zh.md` 与 `docs/architecture-zh.md` §5、`README.md` + `README-zh.md`、ADR 0024 |
| 某个已发布版本移除或改名了工具、配置键或已存标识符 | `docs/upgrading-zh.md`、`README.md` + `README-zh.md`、`CHANGELOG.md`；若该标识符已冻结，另写一份新 ADR |
| 保留上限，或被剪除的墓碑保留什么 | `docs/roster-storage-zh.md` §3、`trash.js`、`roster.js`、ADR 0011、ADR 0012 |
| 新增、改名或删除文档 | 本文件与 `INDEX-zh.md` |
| 插件名称或显示标题，或补丁行的 `name` | `package.json`、`cordis.patch.yml`、`AGENTS.md`、`README.md` + `README-zh.md`、`docs/architecture-en.md` + `docs/architecture-zh.md`、一份新 ADR |
| 任何改变安装步骤的改动 | `README.md` + `README-zh.md` |

## 5. 不在本仓库里的东西

- Harness 本体。它的 API 从已安装的应用里读取，不在本仓库内附带。
- profile。安装本 bundle 会改动作者的 profile，而 profile 不被跟踪。
- 产出 ADR 0001 与 ADR 0002 的调研。它在仓库之外、当次会话的调研目录里；真正还有用的结论已经写进 ADR。
