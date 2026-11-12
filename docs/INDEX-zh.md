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
4. `docs/architecture-zh.md`——各部分如何咬合，含花名册状态矩阵。
5. `docs/adr/`——那些难以回退的决策。

## 2. 文档地图

| 问题 | 文档 | 语言 |
|---|---|---|
| 这是什么，怎么装？ | `README.md` | 双语 |
| 还剩什么没做，“完成”指什么？ | `PLAN.md` | 英文 |
| 最近改了什么，为什么？ | `PROGRESS.md` | 英文 |
| 智能体与花名册怎么配合？ | `docs/architecture-zh.md` | 双语 |
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
| 为什么工作板由插件自己拥有，替换成员时到底移动了什么？ | `docs/adr/0017-own-task-board.md` | 英文 |
| 上游缺的是哪段成员生命周期？可直接贴成 issue 的版本 | `docs/upstream-lifecycle-gap.md` | 英文 |
| 分支、提交、合并怎么做？ | `CONTRIBUTING.md` | 英文 |
| 助手在本仓库的规则？ | `AGENTS.md` | 英文 |

## 3. 权威顺序

两份文档冲突时，以较新者为准，顺序如下：

1. 已接受的 ADR；
2. `docs/architecture-zh.md`；
3. `PLAN.md`；
4. `README.md`；
5. `PROGRESS.md`（历史记录，描述的是当时的状态，永不回改）。

在 Harness 行为上，已安装的 Harness 高于以上全部。若本仓库与运行中的 Harness 冲突，错的是本仓库。

## 4. 改一样东西要连带改什么

| 若你改了 | 同时更新 |
|---|---|
| 工具名、参数或返回字段 | `docs/architecture-zh.md` §2 或 §4.5、`actions.js`、`README.md` + `README-zh.md`、`PLAN.md` 对应任务文字 |
| 某个操作的行为或失败原因 | `actions.js`、`index.js` 里的工具 schema、`docs/architecture-zh.md` §4 |
| 收养覆盖什么，或它消费的发现行形状 | `actions.js`、`roster.js`、`docs/architecture-zh.md` §4.5.1、`README.md` + `README-zh.md` |
| 花名册相态或转移 | `docs/architecture-zh.md` §4.3 的状态矩阵；若模型变了，另写 ADR |
| 交接规则——替换、退役或恢复时成员的未完成任务怎么处理 | `docs/architecture-zh.md` §4.3.2 的交接矩阵、`actions.js`、`README.md` + `README-zh.md`、ADR 0017 |
| bundle 配置键或补丁行 | `README.md` + `README-zh.md`、`docs/architecture-zh.md` §1 |
| 持久记录结构 | `docs/architecture-zh.md` §4.2、一份新 ADR、`PROGRESS.md` 里的迁移说明 |
| 新增、改名或删除文档 | 本文件与 `INDEX-zh.md` |
| 插件名称或显示标题，或补丁行的 `name` | `package.json`、`cordis.patch.yml`、`AGENTS.md`、`README.md` + `README-zh.md`、`docs/architecture-en.md` + `docs/architecture-zh.md`、一份新 ADR |
| 任何改变安装步骤的改动 | `README.md` + `README-zh.md` |

## 5. 不在本仓库里的东西

- Harness 本体。它的 API 从已安装的应用里读取，不在本仓库内附带。
- profile。安装本 bundle 会改动作者的 profile，而 profile 不被跟踪。
- 产出 ADR 0001 与 ADR 0002 的调研。它在仓库之外、当次会话的调研目录里；真正还有用的结论已经写进 ADR。
