# dsh-team-roster

[English](README.md)

一个 DeepSeek Harness 插件，给智能体团队补上出厂版本没有的生命周期：成员可以退役、移除、替换——带可恢复的会话回收站、退役后仍存在的花名册，以及针对长跑成员的上下文工具。

**状态**：v0.5 让替换带交接：一次 `spawn_member` 调用加 `replace`，先让继任者带着简短交接书启动，再退役前任（ADR 0009）。v0.4 只面向模型——v0.3 里交付的设置页面板与本地回环 HTTP 桥已移除，因为面板从未在真实 profile 中渲染、点击也不好用——同样的精力投入到模型侧接口，现在覆盖智能体启动的每一个子智能体（ADR 0008）。生命周期工具已安装在作者本机 profile，并在该环境以 v0.5.0 实测：退役、恢复、发消息、停止，以及一次替换——继任者读了交接书并完成了前任的任务（P2-08）。v0.7.0 给每个 Lead 的会话回收站加上上限，它不再无限增长（ADR 0011）。v0.8.0 把这个上限改成 bundle 补丁行上的配置字段——`trashLimit`，默认 20，最小 1，超出范围时在加载阶段就被拒绝——而不再是代码里的常量（ADR 0012）。那次安装之后工作区又有改动，因此最新的变更只有单元测试覆盖；是否重新安装由所有者决定。最近变更见 [PROGRESS.md](PROGRESS.md)。

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
| `spawn_member` | 创建具名成员，或替换成员：带 `replace` 时继任者从交接书启动，并在同一次调用里退役前任。除非模型另起名字，继任者复用基名并递增代次（`reviewer` → `reviewer-g2`）。 |
| `list_members` | 花名册：target、子会话 id、相态、代次、记录在案的职责、实时状态，驻留时还给出上下文压力与 `compactable`。收养官方花名册创建的成员**以及**官方 `subagent`／`subagent_fork` 工具启动的子代理，因此模型控制的每个子代理都可列出、可退役。 |
| `message_member` | 给活着的成员投递消息，并可顺带替换记录在案的职责；已卸载的成员会从自己的会话冷恢复。 |
| `stop_member` | 只取消当前轮；激活与收件箱保留。 |
| `retire_member` | 排空、立碑、把会话产物移入可恢复的回收站，并记录是否改由工作区归档隐藏。每个 Lead 的回收站保留的产物数量可配置——profile 没设置时是 20——因此成功移入产物的退役会删掉超出该上限的最旧条目并报告 `pruned`。对已退役成员重复退役是无操作，并会说明这一点。 |
| `restore_member` | 把已退役成员找回来：把回收站里的会话移回记录的原始路径，记录转回 active。结果会说明走了哪条分支；没有可逆内容时是无操作而不是报错。若产物已被保留上限剪除，则返回 `reason: "pruned"` 并保持退役。 |
| `compact_member` | 对驻留且空闲的成员强制压缩一次。 |

另外，每次退役都会触发两个宿主侧效果：

- **投影过滤**——包装宿主的会话列表出口，让已退役成员从顶部“子智能体”选择器和内置团队面板中消失。不改宿主源码，也不重新构建 Web 应用。
- **名额补偿**——在 spawn 期间把旧花名册的有效 `maxMembers` 按该 Lead 的退役数临时抬高，于是退役一个就还回一个名额。

bundle 同时启用了出厂默认关闭的 `compaction-basic`。

## 只面向模型

本插件没有浏览器半区：没有设置页、没有 HTTP 路由、没有客户端 bundle。它提供的一切都是模型调用的工具，而 `list_members` 就是控制面——它会报告本插件启动的成员、官方团队花名册创建的成员，以及官方 `subagent`／`subagent_fork` 工具启动的每个子代理，每行都带子会话 id。`message_member`、`stop_member`、`retire_member` 可以寻址它返回的任意一行。一次性（one-shot）的 `subagent` 子代理无法冷恢复，所以要在它仍然驻留时发消息；停止和退役则随时可用。

设置页面板确实是一套浏览器半区，并在 v0.3 交付过；但它从未在真实 profile 中渲染，且所有者反馈点击不好用。v0.4 选择移除面板与桥，而不是修它，把精力移到上面的模型侧接口（ADR 0008）。

## 退役是移动而不是删除——回收站有上限

| 步骤 | 行为 |
|---|---|
| 停止 | 排空子代理，释放激活与名额。 |
| 移动 | 持久化会话移到 `~/.dsh/team-roster/trash/<leadSessionId>/<memberId>-<ms>/`。是移动而不是删除：恢复就是把目录移回去。 |
| 立碑 | 记录转为 `retired`，名字在下一代次可用，投影不再下发该成员。再次退役它是无操作，并会说明这一点。 |
| 兜底 | 产物移不动时改用工作区归档隐藏会话，并在返回结果里说明。 |
| 保留上限 | 每个 Lead 的回收站最多保留**生效上限**份产物——默认 20，或 profile 里设置的 `trashLimit`。一次成功移入产物的退役会在同一次调用里删掉超出上限的最旧条目，并在 `pruned` 里报告数量；不会按定时器清理，也不会在读取时清理。 |
| 已剪除 | 被剪除的墓碑保留 `trashPath`（仍记录产物去了哪里），`trashState` 变为 `pruned`。字节已经不在，因此 `restore_member` 以 `reason: 'pruned'` 拒绝。 |
| 恢复 | `restore_member` 把产物移回记录的原始路径并清除墓碑；已有活成员占用同名目标时拒绝。 |

上限之所以存在，是因为平台没有会话删除 API：`sessionPersistence` 是只追加的（`create`、`open`、`flush`、`stat`、`list`），唯一官方的“挪开”机制是可逆的 `workspaceRegistry` 归档。所以插件只删它自己移进回收站的那份副本，并在返回结果里说明（ADR 0011）。

## 替换成员会交接工作

`spawn_member` 加 `replace: <target>` 就是完整的一次替换。继任者从一份简短交接书启动：其中点名前任、复述记录在案的职责、说明前任已退役且已离场，并按前任的名字指向共享团队任务板——任务板本身不复制。除非模型重新记录，继任者继承该职责。

- **先启动继任者，再退役前任**，都在同一次调用里。启动失败则前任原封不动，并在结果里说明；退役失败则返回继任者并带 `predecessor_retired: false`，再调一次 `retire_member` 即可收尾（ADR 0009）。
- **职责是持久字段，且有长度上限。** `spawn_member.assignment` 在启动时写入，最多 1000 个字符；工作变化时用 `message_member.assignment` 替换。`list_members` 会报告它，退役后它仍留在墓碑上。
- 目标已经退役时同样接受，由墓碑提供交接书。

## 安装

```
plugin_manager  install_bundle  target: <本仓库的绝对路径>
```

bundle 是链接安装而不是复制，所以改了模块之后要先 `remove_bundle` 再 `install_bundle`，才能加载新的模块代次。

安装后的验证：

- 插件行 `application: applied`，无告警；
- Lead 会话可以调用 `list_members`，驻留成员带压力数值；
- 对有产物的会话，`retire_member` 返回 `trashed: true` 和 `trash_path`；
- `spawn_member` 带 `replace` 时返回 `predecessor_retired: true`，且继任者是下一代次；
- `include:compaction-basic` 状态是 `schema` 而不是 `inactive`。

## 配置

| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_TEAM_ROSTER_DATA_DIR` | `~/.dsh/team-roster` | 回收站根目录与花名册数据目录。 |

花名册本身存在一个 `storageDomain` 域里（ADR 0003），不在会话日志里。

### 回收站保留上限

除非 profile 另行设置，每个 Lead 的回收站最多保留 **20** 份产物。这个上限是 bundle 自己补丁行上的配置字段，所以改它是改 profile，而不是改本仓库：

```yaml
# profile 里的 cordis.patch.yml
- id: team-roster
  config:
    trashLimit: 7
```

该字段必须是**最小为 1** 的整数。`0`、负数、小数、数字字符串、`NaN` 以及显式写的 `null` 都会被拒绝，而不是被截断取整；拒绝发生在**profile 加载时**——在任何工具注册之前，更在第一次退役之前。报错信息会点名字段、它看到的值和最小值：

```
dsh-team-roster: config field "trashLimit" must be an integer >= 1 (minimum 1); received 0
```

成功移入产物的那次退役会按生效上限执行，结果里会说明用的到底是哪个数字，所以操作者读到的是真正生效的值。省略 `trashLimit` 就保持文档化的默认值 20，因此什么都不配置的 profile 行为与 v0.7.0 完全一致（ADR 0012）。

本入口仍然不声明 `Config` **schema**，所以 Host 的 Config 提供方把 `include:team-roster` 报为 `absent`。这描述的是 schema 投影，而不是“不可配置”：该字段在加载时被读取并校验，并在退役时执行。原因记在 ADR 0012——Config 提供方与 profile schema 生成器都只接受原生 Schemastery schema，而零导入的 bundle（ADR 0002）无法导入它。

## 开发

```sh
node --check index.js actions.js roster.js trash.js host-hooks.js
node --test --test-isolation=none tests/*.test.mjs
node scripts/check.mjs
```

`--test-isolation=none` 在 Windows 上很重要：默认 runner 会为每个文件起一个进程，而本机沙箱拒绝这种 spawn。该 flag 还固定了 Node 大版本：它在 Node 22 中不存在，所以 CI 固定 Node 24，本机 runner 也是同一大版本。两边跑同一条命令，因此本机通过的含义与 CI 通过相同。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `index.js` | Host 插件入口、工具定义、Lead 专属权限检查 |
| `actions.js` | 花名册操作，位于模型侧工具背后 |
| `roster.js` | 持久花名册、代次命名、收养、旧域迁移 |
| `trash.js` | 会话产物回收站与每个 Lead 的保留上限 |
| `host-hooks.js` | 投影过滤与花名册名额补偿 |
| `tests/` | `node:test` 单元测试 |
| `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg` | bundle 本体 |
| `PLAN.md`、`PROGRESS.md` | 任务与只追加的变更日志 |
| `docs/` | 设计文档（双语）与 ADR |

## 参与

如果你是 AI 助手，先读 [AGENTS.md](AGENTS.md)；分支、提交与 CI 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
