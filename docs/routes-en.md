# Routes and model costs

> Owner: @FrozenYty · Revisit when: the Harness changes how a child's route is resolved, or a component
> in this profile stops following the session's route

Which model a member runs on, where that choice is recorded, and what in this profile does *not* follow
the session's route. It was written to answer one measured billing confusion, and it keeps the
measurement that caused it.

**The suspicion this document answers, and the measurement that confirmed it.** After a relay provider
was connected, the owner's account was still billed. An inventory of 60 session logs found 18 sessions
still on `deepseek-official/deepseek-flash`, several of them members of a live team, while the live Lead
sessions ran on the relay: a member's provider and model were written into its own Session's request
header when it started, so nothing about a later switch reaches it. Below is what this plugin chooses,
what the Harness chooses for it, and the one component in this profile that follows an endpoint of its
own instead of the session's route.

## 1. What chooses a member's model

**The plugin states the route now, and records it.** With no `spawn_options.agent_options`, `spawn_member`
resolves the Lead's current `provider` and `model` from `session.requestHeader().config` — the seam's own
inheritance source — and forwards them as the request's `agentOptions`, so the member is started on the API
of the Session that started it and the plugin is what names it (ADR 0024). An explicit
`spawn_options.agent_options` still wins field by field, and the field the caller did not name is completed
from the same read, so `started_with.route_source` can say the route came from the call (`caller`), was
resolved by the plugin (`plugin`), or was inherited unresolved (`inherited`).

- **`reasoning_effort` is never forwarded.** The seam drops the parent's effort when the route it resolved
  differs from the parent's (`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:88-90`); forwarding the
  Lead's own route is exactly the case where it does not differ, so the Lead's effort survives the merge
  without being sent. A caller who names `reasoning_effort` still gets it forwarded — that is the caller's
  own field.
- **Every failure to resolve is a fallback, not a failed spawn.** A Session whose route cannot be read
  (`no-session-route`) and a provider that does not advertise `agentOptions` (`capability-absent`, the gate
  at `@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`) both forward nothing, record
  `route.source: "inherited"` with that reason, and let the Harness inherit as it did before. The request
  in that case is exactly `{ prompt, parent }`; a spawn is never broken to fix a route.
- **A live member cannot be re-routed.** Its route lives in its own recorded request header. That is why
  `list_members` flags a member whose recorded `route` is not the Lead's current one
  (`route_stale: true`, with a `route_note`), and why the remedy is one replacement:
  `spawn_member { replace: "<target>" }` starts a successor on the current route and hands its open work
  over (ADR 0009, ADR 0017).

The plugin does not preflight the route through `ctx.llm` the way the shipped subagent tool does
(`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`, and the Session route allowlist at `:89-96`): that
preflight validates a *caller-chosen* route against the profile's allowlist, while what is forwarded here is
the route the Session is already issuing requests on — proven rather than proposed.

## 2. No LLM call, and the compaction row follows the session

The bundle makes no model call of its own: no Host module reaches `ctx.llm`, and no code path calls
`prepareCall`. The row the patch enables, `compaction-basic`, resolves its summarization target as
`configured ?? session.requestHeader().config ?? agent.options`
(`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`) — the session's own route — so enabling it started
no new billing in the measured profile.

## 3. The exception: web search pins its own endpoint

`web_search` is not this plugin's, and it is the one component here that does not follow the session route.
The base bundle's patch selects `searchProvider: deepseek-official`
(`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`), and `dsh-web-search-deepseek` pins
`https://api.deepseek.com/anthropic/v1` with `deepseek-v4-flash`
(`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`) and sends there whatever the chat route is
(`:319-320`). In the measured profile it produced 107 official requests, two of them after a session had
already switched to the relay.

**Why it cannot simply be pointed elsewhere.** That plugin requires retrieval to happen server-side: it reads
`web_search_tool_result` blocks and throws `WEB_PROVIDER_ERROR` when there are none
(`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:61-62`). A relay endpoint that speaks an Anthropic-shaped
Messages API can still hand the search back: a direct test of the relay's `/v1/messages` answered 200 and,
given the `web_search` tool, answered `stop_reason: "tool_use"` — the same rejected shape — while its
`/anthropic/v1/messages` path answered 404.

**The two honest options.** Disable that row (or the `web` row) in the profile, and no request leaves for
that endpoint — search is simply not available; or point it at an endpoint that executes native search. One
request tells them apart: send a Messages request carrying the `web_search` tool and read the answer. A
`web_search_tool_result` block, or a finished turn with results, means the endpoint runs the search; a
`tool_use` stop means it is asking the caller to run it, and this plugin rejects that answer.

The boundary in one sentence: **the session's route governs every chat request; a component that pins its own
endpoint is the exception, and this plugin is not one.**
