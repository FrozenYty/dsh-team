# 文档索引

[English](INDEX-en.md)

本仓库里有什么、哪份文档回答哪个问题、以及改动某样东西时还有哪些必须同步改。新增或移动文档前先读这里。

## 1. 阅读顺序

```
README.md  ->  PLAN.md  ->  PROGRESS.md  ->  docs/architecture-zh.md  ->  与你改动相关的 ADR
```

1. `README.md`——插件是什么、怎么安装。
2. `PLAN.md`——唯一的任务来源，未完成的工作都在这里。
3. `PROGRESS.md`——当前状态为什么是这样，只追加。
4. `docs/architecture-en.md`——各部分如何咬合，含花名册状态矩阵。
5. `docs/adr/`——那些难以回退的决策。

## 2. 文档地图

| 问题 | 文档 | 语言 |
|---|---|---|
| 这是什么，怎么装？ | `README.md` | 双语 |
| 还剩什么没做，“完成”指什么？ | `PLAN.md` | 英文 |
| 最近改了什么，为什么？ | `PROGRESS.md` | 英文 |
| 智能体与花名册怎么配合？ | `docs/architecture-en.md` | 双语 |
| 为什么花名册要自建而不是扩展官方？ | `docs/adr/0001-own-roster-on-subagents.md` | 英文 |
| 为什么 bundle 入口不导入任何东西？ | `docs/adr/0002-zero-import-bundle-entry.md` | 英文 |
| 花名册存在哪里？ | `docs/adr/0003-roster-storage.md` | 英文 |
| 为什么退役要移动文件、还要改宿主服务？ | `docs/adr/0004-retire-through-persistence.md` | 英文 |
| 分支、提交、合并怎么做？ | `CONTRIBUTING.md` | 英文 |
| 助手在本仓库的规则？ | `AGENTS.md` | 英文 |

## 3. 权威顺序

两份文档冲突时，以较新者为准，顺序如下：

1. 已接受的 ADR；
2. `docs/architecture-en.md`；
3. `PLAN.md`；
4. `README.md`；
5. `PROGRESS.md`（历史记录，描述的是当时的状态，永不回改）。

在 Harness 行为上，已安装的 Harness 高于以上全部。若本仓库与运行中的 Harness 冲突，错的是本仓库。

## 4. 改一样东西要连带改什么

| 若你改了 | 同时更新 |
|---|---|
| 工具名、参数或返回字段 | `docs/architecture-en.md` §2 或 §4.5、`README.md` + `README-zh.md`、`PLAN.md` 对应任务文字 |
| 花名册相态或转移 | `docs/architecture-en.md` §4.3 的状态矩阵；若模型变了，另写 ADR |
| bundle 配置键或补丁行 | `README.md` + `README-zh.md`、`docs/architecture-en.md` §1 |
| 持久记录结构 | `docs/architecture-en.md` §4.2、一份新 ADR、`PROGRESS.md` 里的迁移说明 |
| 新增、改名或删除文档 | 本文件与 `INDEX-zh.md` |
| 任何改变安装步骤的改动 | `README.md` + `README-zh.md` |

## 5. 不在本仓库里的东西

- Harness 本体。它的 API 从已安装的应用里读取，不在本仓库内附带。
- profile。安装本 bundle 会改动作者的 profile，而 profile 不被跟踪。
- 产出 ADR 0001 与 ADR 0002 的调研。它在仓库之外、当次会话的调研目录里；真正还有用的结论已经写进 ADR。
