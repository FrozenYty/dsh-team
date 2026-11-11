# dsh-team-control

[English](README.md)

一个 DeepSeek Harness 插件，给智能体团队补上出厂版本没有的生命周期：成员可以被退役、移除、替换，而不是只能一直增加。

**状态**：v0.1 已在作者本机安装并验证；v0.2（自建花名册、真正可删除）进行中。当前任务状态见 [PLAN.md](PLAN.md)，最近变更见 [PROGRESS.md](PROGRESS.md)。

**仓库**：[github.com/FrozenYty/dsh-team-control](https://github.com/FrozenYty/dsh-team-control)

## 为什么需要它

官方实验性 Agent Teams 包（`@deepseek-ai/dsh-experimental-agent-team` 及其工具包与界面包）的花名册，是 Lead 会话日志的折叠：

- 成员相态只有 `provisioning | active | failed`，投影会拒绝任何离开终态的转换——伪造一条“已退役”记录不会安全失败，而是让该 Lead 的投影永久失效；
- `maxMembers`（16）检查的是一个只增不减的列表，失败和已完成的成员会一直占着名额；
- 名字永不复用，整套契约里没有任何删除操作。

上游短期内也不会修：正在进行的重构把成员变成普通子代理，但依然写明“名字是永久的”，以及“服务层的上限或删除操作是以后的产品决策”。

另外，这个桌面 profile 出厂把压缩后端**关掉了**，所以没有任何东西在压缩：成员会一路涨向模型 100 万 token 的窗口。v0.1 修好了这一点并加了两个观测工具，v0.2 替换花名册。

## 你得到什么

| 能力 | 状态 |
|---|---|
| 启用官方 `compaction-basic` 压缩后端（profile 级） | v0.1 已交付 |
| `member_context`——每个成员的上下文压力、是否驻留/空闲 | v0.1 已交付 |
| `compact_member`——就地压缩指定成员 | v0.1 已交付 |
| 自建花名册：创建、退役、移除、替换 | v0.2 进行中 |
| 设置页团队面板 | 计划中 |

v0.1 的能力说明见 [docs/architecture-zh.md](docs/architecture-zh.md)，自建花名册的设计决策见 [docs/adr/0001](docs/adr/0001-own-roster-on-subagents.md)。

## 安装

这是一个 profile bundle：一行 Host 插件，加一段同时启用官方压缩后端的补丁。

```
plugin_manager  install_bundle  target: <本仓库的绝对路径>
```

bundle 是链接安装而不是复制，所以改了 `index.js` 之后要先 `remove_bundle` 再 `install_bundle`，才能加载新的模块代次。

安装后的验证：

- 插件行 `application: applied`，无告警；
- Team Lead 会话里可以调用 `member_context`；
- `include:compaction-basic` 的状态是 `schema` 而不是 `inactive`；
- `member_context` 报告 `compactor: available`。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `package.json`、`cordis.patch.yml`、`index.js` | 被安装的 bundle 本体 |
| `locale/`、`icon.svg` | 插件展示元数据 |
| `PLAN.md`、`PROGRESS.md` | 任务与只追加的变更日志 |
| `docs/` | 设计文档（双语）与 ADR |
| `scripts/check.mjs` | 本仓库的本地检查 |

## 参与

如果你是 AI 助手，先读 [AGENTS.md](AGENTS.md)；分支、提交与 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
