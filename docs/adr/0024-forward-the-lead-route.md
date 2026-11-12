# 0024 — A member is started on the Lead's current route, and a straggler is reported

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —
- **Adjusts [0016](0016-spawn-capabilities.md) point 6 and point 2** — `started_with` no longer carries
  only the fields the caller supplied, and a spawn that passes no `spawn_options` no longer composes
  exactly `{ prompt, parent }`. Both changes are stated in full below; every other decision in 0016
  stands, including the nested parameter, the probing of refusals and the current-holder field.

## Context

**The defect is measured, not suspected.** An inventory of the owner's 60 session logs found 18 sessions
whose own `request/header` still names `deepseek-official/deepseek-flash` after the Lead's profile was
switched to a relay, several of them members of a live team — one member `ba97c05a` made 4 of 4 requests
on the official API — while the sessions that are live run on the relay. The owner's account was still
billed, and this plugin's members were the reason.

**Nothing about the plugin's own code was wrong, which is why the defect was invisible.** `spawn_member`
sent `{ prompt, parent }` and the seam resolved the child's provider and model from
`parent.session.requestHeader()?.config` — the Lead's *current* route — falling back to the parent Agent's
creation options only while no request had been logged
(`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:49-62`). A member spawned now therefore inherits the
relay correctly, and a member spawned *before* the switch has no way to move: its route was resolved once,
written into its own `request/header` at that moment, and never revised. A message, a resume and a cold
wake all reuse the route the Session already recorded. So the fleet accumulates members it cannot
re-route, and the ordinary `list_members` row said nothing about it — the route is not one of the fields
the row shows, and no read compares the two.

**The prompt asked for a member to use the API of the Session that started it.** The seam already does
that at spawn time; the failure is that nothing states it and nothing reports when it stops being true.

## Decision

**`spawn_member` resolves the calling Lead's current route and forwards it as the activation request's
`agentOptions`, records the route it started the member on, and reports on every `list_members` row when a
member's recorded route is no longer the Lead's.**

1. **The resolution source is the Lead's own Session, and only that.** `provider` and `model` are read from
   `caller.session.requestHeader()?.config` — the same accessor and the same field the seam resolves
   inheritance from, so the forwarded route is the route the Harness itself would have chosen. The parent
   Agent's creation options are deliberately **not** a second source: they are a snapshot from before the
   Lead switched, and forwarding them would state a stale route as the current one. The accessor is
   capability-probed behind a type check and a `try`, never assumed: a Session without it, an accessor that
   throws, an absent config, or a config that does not name both a non-empty `provider` and a non-empty
   `model` all resolve nothing.
2. **`reasoningEffort` is never forwarded.** The seam drops the parent's effort only when the route it
   resolves differs from the parent's (`child-agent.js:88-90`), and forwarding the parent's own route is
   precisely the case where it does not differ — so the Lead's effort survives the merge without being
   sent. Sending one anyway would mean naming an effort for a model this function never asked about, and
   the shipped tool's route preflight is not on this path
   (`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`), so a wrong effort would fail the child's first
   request *after* the member is already recorded as started. A caller who names `reasoning_effort` still
   gets it forwarded, unchanged: that is the caller's own field (ADR 0016).
3. **The caller's explicit route wins, and the result says where the route came from.** When the call — or
   the member definition it named — supplies `provider` or `model`, that value is what reaches the request,
   and the half it did not supply is completed from the Lead's current route so the *recorded* route is the
   whole route the child runs on. `started_with.route_source` is `caller` when the route is the call's,
   `plugin` when the plugin resolved and forwarded it, and `inherited` when nothing was forwarded. This is
   the one field ADR 0016 point 6's "only what the caller supplied" rule gains, and the reason is that a
   plugin-resolved route is now a thing the caller did not write and must still be able to read back.
4. **Never break a spawn to do it.** Every failure is a fallback, not a failure:
   - the route cannot be resolved (`select_reason: 'no-session-route'`), or
   - the spawn provider does not advertise `agentOptions` (`select_reason: 'capability-absent'`), because
     forwarding one makes the seam reject the start with `UNSUPPORTED_CAPABILITY`
     (`@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`);
   then nothing is forwarded, the request is exactly the `{ prompt, parent }` it was before this release,
   the member's route is recorded as `source: 'inherited'` with the reason (`no-session-route` or
   `capability-absent`), and the spawn proceeds on the Harness's own inheritance. A spawn that supplies no
   `agent_options` and *can* be resolved records `source: 'plugin'` and forwards the route. The reason is
   recorded so a reader can tell which fallback ran, and it is absent on the two paths that forwarded
   something because there is nothing to explain about them.
5. **The member record carries the route.** `route` is `{ source, provider?, model?,
   select_reason? }` — written once, in the same mutation as the reservation, and never rewritten: it is a
   fact about the start, not live state, exactly as `started_with` is a receipt for the request rather than
   a statement about the child's resolved options. A record written before this release has no `route`, is
   not retro-filled, and is reported without one.
6. **The `list_members` row reports the route and flags a straggler.** The row gains `route` (the member's),
   and — when the Lead's own route can be read and differs from the member's — `route_stale: true` and a
   `route_note` sentence that names both routes, says that the member is still billed on the one it started
   on, and names the one call that clears it. The comparison is made at read time and stored nowhere, so a
   Lead that switches back clears every flag without a write. A member whose route cannot be compared (no
   recorded route, or a Lead whose own route cannot be read) is **not** flagged: absence of evidence is not
   a straggler.
7. **The remedy is the replacement the plugin already has, and no new tool is added.** A stale member is
   replaced: `spawn_member { replace: "<target>" }` starts a successor that resolves the current route and
   hands over the predecessor's open work in the same call (ADR 0009, ADR 0017). Nothing re-routes a live
   member — the route is in the Session's own recorded header — so a replacement is the only honest fix,
   and the README says so where a Lead will look.

## Rationale

- **Forwarding rather than relying on the seam's own resolution.** The seam resolves the same two fields
  from the same place; making the plugin state them turns an implicit behaviour into one the plugin
  controls, records and can report on. It is also the only way the recorded route on the member and the
  route in the child's own header are guaranteed to be the same value: both are taken from one read of one
  accessor.
- **`reasoningEffort` is the one field forwarding would make worse.** The seam's merge already keeps the
  Lead's effort when the route is unchanged and drops it when it changed; sending an effort would remove
  that decision from the code that has the model's capability table.
- **The fallbacks are recorded rather than silent.** A cost defect is exactly the class of bug that hides
  when a fallback is quiet, and "the plugin resolved the route" versus "the Harness inherited it" is the
  single fact that says whether this release is doing anything in a given profile.
- **The stale flag exists because the owner asked which members are still billing the old API.** The
  provider and model are on the record and could be read with a second call, but a Lead does not make that
  call: the answer has to be on the row it is already reading, and the sentence has to name the remedy,
  or the reader concludes the route is stuck.
- **The route is recorded, not the receipt.** The record is what a later read compares; a receipt on one
  tool result would be gone by the time the comparison mattered.

## Alternatives rejected

- **Read the parent's `AgentOptions` instead of the Session header.** It is the seam's *fallback*, not its
  source, and it is stale by construction after a route switch — the exact defect this ADR closes.
- **Make the route resolution mandatory and refuse a spawn that cannot resolve one.** It would break
  profiles that work today (a Session with no request logged yet, a provider without the capability) for a
  step the caller never asked for. Fallback plus a recorded reason is the information without the failure.
- **Preflight the route through `ctx.llm` the way the shipped tool does.** That preflight exists to validate
  a *caller-chosen* route against the profile's allowlist
  (`@deepseek-ai/dsh-tool-subagent/lib/index.js:439-450`); the route forwarded here is the one the Session is
  already issuing requests on, so it is proven rather than proposed. Adding it would introduce a new
  failure mode and a new dependency (the `llm` service) for no new information.
- **Forward the Lead's `reasoningEffort` too.** Rejected in point 2: the merge already handles it, and the
  plugin cannot know which models the effort is valid for.
- **Record `route` on a spawn that inherited it, without a provider or model.** It would say nothing true
  and would make the straggler comparison ambiguous. `source` and the reason are recorded instead.
- **Re-resolve and rewrite the route on every `message_member`/resume.** A member's route lives in its own
  recorded `request/header`; the plugin has no supported way to rewrite it, and a second writer for a
  Session field this plugin does not own is the kind of duplication ADR 0016 already rejected for `cwd`.
- **A `reroute_member` tool.** The remedy already exists as a replacement that also carries the work over
  (ADR 0009). A second operation would need its own answer for what happens to the work, the name
  generation and the inbox.
- **Flag a member whose route *might* differ.** Without both routes there is nothing to compare, and a
  guessed `route_stale` would teach the reader to ignore the field.
- **Store `route_stale` on the record.** It is a fact about the pair (member, Lead) at read time, not about
  the member, and storing it would need a write per model switch.

## Consequences

- `actions.js` gains `currentRouteOf`, `spawnProviderAppliesAgentOptions`, `resolveSpawnRoute` and
  `staleRouteNote`; `memberRow` takes the Lead's route and adds the three row fields; `spawnMember` records
  the route with the reservation and merges the forwarded pair into the request; `listMembers` resolves the
  Lead's route once per read.
- `roster.js` gains `ROUTE_SOURCE`, `ROUTE_SELECT_REASON`, `withRoute` and `staleRouteOf`, and validates the
  optional `route` field's structure when a record loads — the shape only, so a record that merely holds an
  odd provider string still loads and still serves its roster (the `handoffTemplate`/`tasks` precedent).
- `index.js` gains `ROUTE`, `MEMBER_ROW.route`, `MEMBER_ROW.route_stale`, `MEMBER_ROW.route_note` and
  `started_with.route_source`, and the `spawn_member` and `list_members` descriptions state the resolution,
  the fallbacks and the flag. Every added field is declared, which is what keeps the host from rejecting a
  result after the side effect.
- `tests/route.test.mjs` covers the twelve cells: forwarding, the caller's route winning, a partial caller
  route, each unresolvable-route fallback, the capability fallback, `reasoningEffort` never added, the flag
  set and unset, the flag clearing when the routes match again, an unreadable Lead route flagging nobody, a
  pre-v0.22.0 record, and an adopted member that was never spawned here. `tests/entry.test.mjs` gains a
  wrapper-level test and validates the new fields against the declared schema.
- A spawn that passes no `spawn_options` no longer composes exactly `{ prompt, parent }` in a profile whose
  Session route is readable: it now sends the two route fields. Both requests are the same route for the
  child; the difference is who states it. `tests/spawn-capabilities.test.mjs`'s exact-request assertion now
  covers the unresolvable case, which is the one where the request is unchanged.
- The README pair, `docs/architecture-en.md` §2.5 and `docs/roster-storage-en.md` §1, and `docs/architecture-zh.md` state the
  behaviour, and the README's member section names the replacement as the way to clear a stale member.
- The version moves to `0.22.0`.
- The live check stays the owner's: a member spawned in a real profile and the route on **its own**
  `request/header`, which is the only evidence that the forwarded pair is what the child actually used.

## Revisit when

The Harness adds a supported way to change a live Session's route (then a stale member could be re-routed
in place and the replacement stops being the only remedy); a supported read of a child's *resolved*
`AgentOptions` (then the record could hold the resolved route rather than the forwarded pair, and ADR 0016's
revisit condition is met as well); or the seam stops resolving inheritance from the parent's Session header,
at which point the source named in point 1 has to be re-read from the installed package rather than assumed.
