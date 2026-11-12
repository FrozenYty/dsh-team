# 路由与模型成本

> Owner: @FrozenYty · Revisit when: Harness 改变子代理路由的解析方式，或本 profile 中某个组件不再跟随会话路由

成员跑在哪个模型上、这个选择记在哪里，以及本 profile 里**不**跟随会话路由的是哪一部分。本文是为回答一次实测出来的计费困惑而写的，并保留了造成那次困惑的测量结果。

**本文要回答的怀疑，以及证实它的实测。** 接上中转供应商之后，所有者的账户仍在计费。清点 60 份会话日志发现，其中 18 份仍停在 `deepseek-official/deepseek-flash`，好几份还是活团队的成员，而当时活着的 Lead 会话都在中转上：成员的 provider 与 model 在它启动时就写进了自己会话的请求头，之后的任何切换都到不了它。下面写清楚本插件选择什么、Harness 替它选择什么，以及这份 profile 里唯一一个不看会话路由、自己钉死端点的组件。

## 1. 谁来选成员的模型

**现在由插件说明路由，并把它记下来。** 没有 `spawn_options.agent_options` 时，`spawn_member` 从 `session.requestHeader().config` 解析 Lead 当前的 `provider` 与 `model`——这正是 seam 自己的继承来源——并作为请求的 `agentOptions` 转发，因此成员用启动它的那个会话的 API 启动，说出来的是插件（ADR 0024）。显式的 `spawn_options.agent_options` 仍然逐字段优先，而调用方没点名的那一项由同一次读取补全，于是 `started_with.route_source` 能说明路由来自调用（`caller`）、由插件解析（`plugin`），还是未解析而继承（`inherited`）。

- **`reasoning_effort` 从不转发。** seam 只在它解析出的路由与父路由不同时才丢掉父会话的 effort（`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:88-90`）；转发 Lead 自己的路由恰恰是“没变”的那种情形，所以 Lead 的 effort 无需发送也会在合并里保留。调用方自己点名 `reasoning_effort` 时照旧转发，那是调用方的字段。
- **每一次解析失败都是兜底，而不是一次失败的 spawn。** 会话路由读不出来（`no-session-route`）与 provider 没有声明 `agentOptions`（`capability-absent`，能力门在 `@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`）这两种情况都不转发任何东西，把路由记为 `route.source: "inherited"` 并带上原因，然后交给 Harness 按以前的方式继承。那种情况下的请求就是 `{ prompt, parent }`；绝不为了修路由而弄坏一次 spawn。
- **活的成员无法被改路由。** 它的路由就在自己已记录的请求头里。正因如此，`list_members` 会标出记录在案的 `route` 已不是 Lead 当前路由的成员（`route_stale: true` 与一句 `route_note`），也正因如此补救办法只有一次替换：`spawn_member { replace: "<target>" }` 在当前路由上启动继任者，并接手它的未完成工作（ADR 0009、ADR 0017）。

插件不像官方 subagent 工具那样用 `ctx.llm` 预检路由（`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`，Session 级白名单在 `:89-96`）：那条预检校验的是**调用方选定**的路由是否在 profile 白名单里，而这里转发的是该会话已经在发请求的路由——它是被证明过的，不是被提议的。

## 2. 没有模型调用，压缩行走会话自己的路由

bundle 自己不发起任何模型调用：没有任何 Host 模块碰 `ctx.llm`，也没有任何代码路径调用 `prepareCall`。补丁启用的那一行 `compaction-basic`，摘要目标是 `configured ?? session.requestHeader().config ?? agent.options`（`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`），也就是会话自己的路由；因此在实测的 profile 里，启用它没有带来新的计费。

## 3. 例外：网页搜索钉死了自己的端点

`web_search` 不属于本插件，而它是这里唯一不看会话路由的组件。基础 bundle 的补丁选中 `searchProvider: deepseek-official`（`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`），而 `dsh-web-search-deepseek` 把端点和模型钉成 `https://api.deepseek.com/anthropic/v1` 与 `deepseek-v4-flash`（`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`），无论聊天路由是什么都发往那里（`:319-320`）。在实测的 profile 里，它产生了 107 次官方请求，其中两次发生在某个会话已经切到中转之后。

**为什么不能简单地改指别处。** 那个插件要求检索在服务端完成：它读取 `web_search_tool_result` 块，一个都没有就抛 `WEB_PROVIDER_ERROR`（`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:61-62`）。一个提供 Anthropic 形状 Messages API 的中转端点照样可能把搜索退回给调用方：直接测中转的 `/v1/messages`，它返回 200，但在带上 `web_search` 工具时回答 `stop_reason: "tool_use"`——正是那个会被拒绝的形状；而它的 `/anthropic/v1/messages` 路径返回 404。

**两条诚实的出路。** 要么在 profile 里禁用那一行（或 `web` 行），不再有请求发往那个端点，搜索就此不可用；要么把它指向真正执行原生搜索的端点。区分两者的测试只有一次请求：带 `web_search` 工具发一条 Messages 请求，读它的回答。出现 `web_search_tool_result` 块，或者一个带回结果的正常结束，说明端点自己在跑搜索；以 `tool_use` 停下，说明它是在让调用方去跑，而本插件会拒绝这种回答。

边界就一句话：**会话的路由管住每一个聊天请求；自己钉死端点的组件是例外，本插件不属于这一类。**
