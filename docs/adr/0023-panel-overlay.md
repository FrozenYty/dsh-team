# 0023 — The shipped team panel is overlaid at the projection exit

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —

## Context

The shipped Web app draws the **成员** (members) and **共享任务** (tasks) sections as one panel, and that
panel renders `projectionsBySession[lead].values.agentTeam`
(`@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js:239`, members at `:357-372`, tasks at
`:373-385`). The value is the wire view of `teamProjectionDefinition`, a fold over the Lead Session's
`team/member` and `team/task` events (`@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.js`).
It reaches the client on the four `sessionController` exits this plugin already wraps — `list`,
`projections`, `control` and `follow` — and each publish point validates it with
`wire.viewSchema.parse`, so what the wrapper receives is a parsed copy
(`@deepseek-ai/dsh-session-projection/lib/types/index.js:420,482,632,661`).

Two facts follow from that, and they point in opposite directions:

- **The log is not writable by this plugin.** A member phase is closed at
  `provisioning | active | failed`; a transition out of a terminal phase throws, and
  `applyProjectionEvent` stores the throw as a permanent `failure` (`projection.js:157-174,198-205`).
  After that, every Team read and mutation for the Lead throws
  (`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:132-136`) and the panel renders
  `团队持久记录无效` (`client.js:352-356`). This is ADR 0001, and the installed code still says it.
- **The exit is writable.** A member started through `ctx.subagents` never appends a `team/member` event,
  so the fold cannot know it. The shipped panel therefore listed only the members the shipped roster
  created, plus every adopted child this plugin reported through tools — never the members this plugin
  spawned. Meanwhile the same exits already strip a retired id from `subagentCatalog` and
  `agentTeam` (ADR 0004), which is why a retired member already disappears from the **子智能体** picker.

The change is to extend that working seam from *strip* to *strip and merge*: on the same four exits, add
this Lead's own live members to the outgoing copy.

## Decision

**The projection filter appends the members this plugin owns to the same `agentTeam` value it already
filters, and writes nothing else.**

1. **The row is exactly the four fields the wire requires and the panel reads.** The member projection
   schema is strict and requires `{ id, name, role, phase }`, with `role` in `lead | teammate` and `phase`
   in `provisioning | active | failed` (`projection.js:249-255`). This plugin synthesises
   `{ id: childId, name: target, role: 'teammate', phase: 'active' }`:
   - `id` is the child Session id the roster recorded when the start published (`actions.js:1079`;
     adoption keeps the discovered id at `roster.js:682`). The panel uses it for its row key, for the
     model lookup, for the running-state lookup, and for the click that opens the member's chat
     (`client.js:88-111`).
   - `name` is the model-facing target (`targetOf`, `reviewer` or `reviewer-g2`) — the same handle every
     tool takes, and the same one a click resolves.
   - `role: 'teammate'` and `phase: 'active'` are the only values that are true of a member this overlay
     adds; the panel reads `phase` to decide among 运行中, 未运行, 准备中 and 失败 (`client.js:92`), and
     an active child that is not running renders 未运行, which is correct.
2. **Only a live member with a recorded child id is added.** "Live" is the roster phase `active`; a
   `provisioning` record is a reservation whose child may not exist, a `failed` one has no chat to open,
   and a `retired` one is deliberately not there. Only the two fields the overlay needs cross the module
   boundary (`livePanelMembers`, `index.js`), so the wire shape stays in `host-hooks.js` and the phase
   rule stays next to the roster.
3. **Retirement is absence.** There is no `retired` phase in the wire enum, and inventing a `failed` row
   would render 失败 — a lie about a member that left on purpose. The row is simply not added, and the
   panel draws one row fewer; absence is also how the shipped view decides membership, since a row is
   drawn because the value carries it, never because a phase marks it present. The shipped log itself has
   no retirement transition, so there is no shipped row shape to imitate (ADR 0001, ADR 0004).
4. **Never duplicate and never re-role.** An id already present in the value is left exactly as it is; the
   overlay only appends ids the value does not carry. That keeps the shipped roster's own row for a child
   both sides know about, and keeps a repeated overlay pass idempotent.
5. **Never write the log.** The value is a copy: every publish path runs `wire.viewSchema.parse` before a
   client sees it, and that parse builds new objects and arrays. The wrapper mutates only that copy, so
   `cell.state` and the Session log are unreachable from here. If a future Harness handed the wrapper a
   live state object, this decision would be wrong and the merge would have to be dropped, not adapted.
6. **The strip stays, the seam keeps its exact old contract.** Retired ids are still removed from both
   `subagentCatalog` and `agentTeam` on every exit, the value is still rewritten in place so a caller's
   reference stays valid, both halves run through the same capability probe, a host without
   `sessionController` is still skipped, and the disposer still restores the host's own functions.

**Tasks are deliberately not merged in this change.** The task view needs about ten fields this plugin's
board does not have — `id`, `revision`, `subject`, `description`, `status`, `blockedBy`, `writeScopes`,
`ownerName`, `ready` and `writeScopeWarnings` (`projection.js:256-267`) — while a member row needs four.
The board has no revisions, no dependency graph and no write scopes, so a synthetic task row would be a
half-truth in a schema that will reject it. If the panel should show this board, that is the next step and
a new decision.

## Rationale

- The seam already exists, is already proven against this Harness generation, and already carries the
  disposer and the capability probe. Adding one append operation costs less than any alternative and
  cannot regress retirement.
- The value is the only place a non-log writer can reach the shipped panel: the panel reads the fold's
  wire view, and the fold is append-only and poisonable. The exit is the boundary the plugin already
  owns.
- Four fields is the minimum the strict schema accepts, and each of the four is used: `id` by every
  click and lookup, `name` by the label, `phase` by the status sentence, `role` by the schema. Nothing
  else is added because nothing else is read.
- Absence is the truthful version of a retirement in a view whose vocabulary has no retirement. A
  tombstone phase would either poison the log (ADR 0001) or display as a failure, and both are worse
  than a shorter list.

## Alternatives rejected

- **Append a `team/member` event with a synthetic phase.** It throws on the way out of a terminal phase
  and the throw becomes the permanent failure that disables the Team service for that Lead. ADR 0001
  already rejected this; the installed projection still implements it.
- **A plugin-owned panel.** v0.3's panel was never rendered in a real profile and its clicks did not
  work; ADR 0008 removed it. Overlaying the shipped panel serves the owner's read without a second UI,
  a second data path or a second render path to verify.
- **Mark a retired member with a `failed` row.** The panel would show 失败 for a deliberate retirement,
  and the row's error field would be empty; that is a worse lie than the member being gone.
- **Copy the wire row from the member's own session projection.** That projection carries no team
  membership, and a dead child has no live projection to read.
- **Merge the task board now.** It needs ten fields and a revision/dependency model this board does not
  have; a synthetic row would either fail the strict schema or silently drop most of what the panel
  shows.

## Consequences

- The shipped **成员** panel now lists this plugin's live members, including adopted children, beside the
  shipped roster's own. A click opens the member's real conversation; an idle active member renders
  未运行 rather than disappearing. A retired member leaves the panel instead of being marked.
- The overlay is a **view**, not a new source of truth: it can add and hide rows, but it cannot retire,
  replace, message or compact anything. Those remain the model-facing tools.
- Freshness is bounded by the next `list`/`projections`/`follow` read or `control` frame. This plugin
  writes no Session event, so spawning a member publishes no `agentTeam` change frame of its own; the new
  row appears when the client next reads the panel's source, and a member started just after a frame will
  not be in that frame.
- The shipped task section still shows the shipped board only. Work on this plugin's board remains visible
  through `task_board` and `list_my_tasks`, not through the panel.
- Unit tests cover every exit shape, the duplicate case, the retired case, the missing child id, the
  no-op case, the disabled-host case and the disposer. The rendered panel is not covered: the suite never
  loads the Harness, so the real page is the owner's install check.

## Revisit when

The Harness ships a public projection-contribution seam (a way to add a value to another package's
projection without wrapping `sessionController`), adds a member phase the panel can render truthfully for
a retirement, or grows a task view that maps onto this plugin's board without invented fields. Any of the
three would let this overlay become a registration, or retire it.
