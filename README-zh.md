# dsh-team-roster

[English](README.md)

一个 DeepSeek Harness 插件，给智能体团队补上出厂版本没有的生命周期：成员可以退役、移除、替换——带可恢复的会话回收站、退役后仍存在的花名册，以及针对长跑成员的上下文工具。

**状态**：v0.4 只面向模型。v0.3 里交付的设置页面板与本地回环 HTTP 桥已移除——面板从未在真实 profile 中渲染，点击也不好用——同样的精力投入到模型侧接口，现在覆盖智能体启动的每一个子智能体（ADR 0008）。生命周期工具本身已在作者本机安装并验证。最近变更见 [PROGRESS.md](PROGRESS.md)。

**仓库**：[github.com/FrozenYty/dsh-team-roster](https://github.com/FrozenYty/dsh-team-roster)

## 为什么需要它

官方实验性 Agent Teams 的花名册是 Lead 会话只追加日志的折叠：

- 成员相态只有 `provisioning | active | failed`，投影会拒绝任何离开终态的转换——伪造一条“已退役”记录不会安全失败，而是让该 Lead 的投影永久失效；
- `maxMembers`（16）检查的是一个只增不减的列表，失败和已完成的成员会一直占着名额；
- 名字永不复用，整套契约里没有删除。

上游的重构把成员变成普通子代理，但仍写明“名字是永久的”，并把删除称为“以后的产品决策”。另外，这个桌面 profile 出厂把压缩后端**关掉了**，所以没有任何东西在压缩。

本插件补上缺的那一半，不 fork 官方花名册。

## 你得到什么

| 工具 | 行为 |
|---|---|
| `spawn_member` | 创建具名成员；继任者复用基名并递增代次（`reviewer` → `reviewer-g2`）。 |
| `list_members` | 花名册：target、子会话 id、相态、代次、实时状态，驻留时还给出上下文压力与 `compactable`。收养官方花名册创建的成员**以及**官方 `subagent`／`subagent_fork` 工具启动的子代理，因此模型控制的每个子代理都可列出、可退役。 |
| `message_member` | 给活着的成员投递消息；已卸载的成员会从自己的会话冷恢复。 |
| `stop_member` | 只取消当前轮；激活与收件箱保留。 |
| `retire_member` | 排空、把会话产物移入可恢复的回收站、给记录立碑。 |
| `restore_member` | 把已退役成员找回来：把回收站里的会话移回记录的原始路径，记录转回 active。 |
| `compact_member` | 对驻留且空闲的成员强制压缩一次。 |

另外，每次退役都会触发两个宿主侧效果：

- **投影过滤**——包装宿主的会话列表出口，让已退役成员从顶部“子智能体”选择器和内置团队面板中消失。不改宿主源码，也不重新构建 Web 应用。
- **名额补偿**——在 spawn 期间把旧花名册的有效 `maxMembers` 按该 Lead 的退役数临时抬高，于是退役一个就还回一个名额。

bundle 同时启用了出厂默认关闭的 `compaction-basic`。

## 只面向模型

本插件没有浏览器半区：没有设置页、没有 HTTP 路由、没有客户端 bundle。它提供的一切都是模型调用的工具，而 `list_members` 就是控制面——它会报告本插件启动的成员、官方团队花名册创建的成员，以及官方 `subagent`／`subagent_fork` 工具启动的每个子代理，每行都带子会话 id。`message_member`、`stop_member`、`retire_member` 可以寻址它返回的任意一行。一次性（one-shot）的 `subagent` 子代理无法冷恢复，所以要在它仍然驻留时发消息；停止和退役则随时可用。

设置页面板确实是一套浏览器半区，并在 v0.3 交付过；但它从未在真实 profile 中渲染，且所有者反馈点击不好用。v0.4 选择移除面板与桥，而不是修它，把精力移到上面的模型侧接口（ADR 0008）。

## 退役不是删除

| 步骤 | 行为 |
|---|---|
| 停止 | 排空子代理，释放激活与名额。 |
| 移动 | 持久化会话移到 `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`。是移动而不是删除：恢复就是把目录移回去。 |
| 立碑 | 记录转为 `retired`，名字在下一代次可用，投影不再下发该成员。 |
| 兜底 | 产物移不动时改用工作区归档隐藏会话，并在返回结果里说明。 |
| 恢复 | `restore_member` 把产物移回记录的原始路径并清除墓碑；已有活成员占用同名目标时拒绝。 |

## 安装

```
plugin_manager  install_bundle  target: <本仓库的绝对路径>
```

bundle 是链接安装而不是复制，所以改了模块之后要先 `remove_bundle` 再 `install_bundle`，才能加载新的模块代次。

安装后的验证：

- 插件行 `application: applied`，无告警；
- Lead 会话可以调用 `list_members`，驻留成员带压力数值；
- 对有产物的会话，`retire_member` 返回 `trashed: true` 和 `trash_path`；
- `include:compaction-basic` 状态是 `schema` 而不是 `inactive`。

## 配置

| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_TEAM_ROSTER_DATA_DIR` | `~/.dsh/team-roster` | 回收站根目录与花名册数据目录。 |

花名册本身存在一个 `storageDomain` 域里（ADR 0003），不在会话日志里。

## 开发

```sh
node --check index.js actions.js roster.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

`--test-isolation=none` 在 Windows 上很重要：默认 runner 会为每个文件起一个进程，而本机沙箱拒绝这种 spawn。CI 用同样的调用，保证两边一致。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `index.js` | Host 插件入口、工具定义、Lead 专属权限检查 |
| `actions.js` | 花名册操作，位于模型侧工具背后 |
| `roster.js` | 持久花名册、代次命名、收养、旧域迁移 |
| `trash.js` | 会话产物回收站 |
| `host-hooks.js` | 投影过滤与花名册名额补偿 |
| `tests/` | `node:test` 单元测试 |
| `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg` | bundle 本体 |
| `PLAN.md`、`PROGRESS.md` | 任务与只追加的变更日志 |
| `docs/` | 设计文档（双语）与 ADR |

## 参与

如果你是 AI 助手，先读 [AGENTS.md](AGENTS.md)；分支、提交与 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
