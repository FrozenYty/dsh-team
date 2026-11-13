# 0037 — A member's spend

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes:** — nothing.
- **Related:** [0024](0024-forward-the-lead-route.md) (the route a spend is billed on),
  [0035](0035-archive-readable-on-request.md) / [0036](0036-archive-lookup-by-identity.md) (the other
  per-row fields added recently).

## Context

`list_members` says what a member is doing and how full its context is (`pressure_tokens`, `usage_ratio`,
live from `tokenMeter.measure()`). It could not say what the member **has used**, and "which member is
expensive" is a question a Lead asks.

**The obvious path is wrong, and this is the part worth recording.** `tokenMeter` owns the usage
projection and **discards its handle**: `dsh-token-meter/lib/index.js:806` never keeps the registry it
computed from, and its `measure()` answers *pressure* — how full a context is — not spend. Reading pressure
and reporting it as a cost would be a different number with the same units.

**The reachable path is the registry itself.** `ctx.get('sessionProjections')?.snapshot(session,
['tokenUsage'])` is provably present wherever `tokenMeter` is active, because `TokenMeter` itself injects
`sessionProjections` (`:795`). Naming that file and line matters: the next person to check this decision is
asking exactly "why can we see a service the meter hides".

## Decision

1. **A row carries `spend_tokens`: the four token counters of that member's durable log, summed.**
2. **It is read with `ctx.get`, never declared in the plugin's `inject` list.** Declaring
   `sessionProjections` as an injection would make a profile **without that registry fail to load** — an
   optional capability would become a hard requirement, and the plugin would stop working on a host that
   simply does not mount the meter. This is the same optional-access pattern `host-hooks.js` already uses
   for the other services it can live without, and it is stated as a **rule** because the next person adding
   a service will reach for `inject` and be right nine times out of ten.
3. **Omitted, never zero.** Six cases answer `undefined` and the row omits the field: **no live Agent** (a
   non-resident member), **an Agent with no session**, **no registry** or **no `snapshot` function**, **a
   `snapshot` that throws** (a Session the registry has already forgotten, or a unit it cannot compute),
   **no `tokenUsage` unit** in the answer, and **any counter that is not a finite number** (or a total that
   is not). The reason is the claim: *"nothing measured" and "nothing spent" are different claims*, and a
   partial sum would be a plausible-looking lie — the worst kind of wrong number, because it looks like a
   small one.
4. **The sum is unweighted, and this plugin has no price table.** A cache read and an output token differ by
   orders of magnitude in cost, so the number is honest only to a reader who knows that. A price table would
   be a measurement of somebody's tariff, wrong the week it ships; the unweighted sum is a *measurement of
   what the log recorded*, which is what this plugin can actually own. That is a limit of the field, not a
   defect of the implementation.
5. **It is cumulative and not monotone.** A retry adds an attempt while a streaming sample replaced by its
   final one subtracts, so a row can show a **smaller** number than it did a moment ago. That sentence is
   asserted by a test rather than merely written, because a number that can fall is the number someone
   files a bug about — and deleting the sentence should break something.

## Rationale

The alternative — asking `tokenMeter` — is impossible for the reason above, and the alternative to a
per-row number is no number: a Lead can already see each member's pressure and not its use. Reading the
projection directly is one cheap read per row because the unit subset is named (`['tokenUsage']`), so
`snapshot` computes only that unit and skips the host-only ones.

## Rejected alternatives

- **`inject: ['sessionProjections']`.** Load-time failure on profiles without the registry; the plugin
  would trade a field for its ability to start.
- **Report `0` when unreadable.** A zero is indistinguishable from a member that has spent nothing, which is
  the one thing the field must never say by accident.
- **A price table.** It would make the number look like money and be wrong within a release; see above.
- **Compute spend from `PROGRESS.md` / the durable log on every read.** The log is the deliberate follow-up
  for non-resident members, not the hot path for mounted ones.

## Consequences

- **The "which member is expensive" question is answerable for mounted members only.** The handle is
  `ctx.agents.get(childId)`, and an **unloaded child has no Agent**, so a non-resident member shows no spend
  at all. Computing it from the durable log — which would answer for retired and unmounted members too — is
  the **deliberate follow-up**, not a bug to discover.
- **The Lead's own spend is not read.** This field describes members; a Lead that wants its own total asks
  the host, not this tool.
- **Upgrade risk, from the research behind this change:** a `stateVersion` bump re-registers the unit and can
  change the view's shape; losing `wire` makes a projection host-only and therefore invisible to `snapshot`;
  and `stateOf(session, key)` is deprecated — `snapshot` is the supported read. A future Harness may do any
  of the three, and the live checklist is where that shows up first.

## Migration

None. The field is computed at read time from a projection; no record stores it.

## Revisit when

Spend has to be answered for unmounted members, which would mean reading the durable log; or a real price
question arrives, which would want weights from the configuration rather than a table in the bundle.
