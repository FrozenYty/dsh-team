# 0025 — A host hook installs when its service exists, and the plugin reports whether it did

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —

## Context

Three host-side effects make a retirement visible and keep this plugin's members listed: the projection
filter that strips and merges at the `sessionController` exits (ADR 0023), the shipped roster read that
`list_agents` answers from, and the shipped member-budget credit. Each one wraps a service this plugin
does not own.

A profile composes its rows by service availability, not by order: this bundle's patch row can activate
before the Web layer publishes `sessionController`, which needs the workspace registry, uploads and the
gateway. `apply` used to call every installer once and each installer skipped silently when
`ctx.get(name)` answered nothing. The filter was then never installed for the life of the process, while
the tools kept promising it: the shipped panel showed no member this plugin owns and kept every retired
one, the shipped `list_agents` kept them too, and nothing in any answer said why. The owner reported a
panel that did not change; no code was wrong, the install simply never happened.

The silent skip was the defect. The missing service at one instant is normal.

## Decision

**A hook is gated on the service it wraps, not on the plugin's load, and the plugin can always say
whether it installed.**

1. **`ctx.inject([service], callback)` is the gate.** The plugin's own `inject` array stays the hard
   dependencies the tools need; a hook's service is added to none of them, so the tools install whether or
   not a hook can. `ctx.inject` is Cordis's own mechanism for "run when these services are available": it
   runs the callback when the service is published, unloads and re-runs it when that service is replaced,
   and registers the child fiber against this plugin's fiber, so the callback's returned disposer unwinds
   the wrap on plugin unload. No polling loop, no listener of our own, no retry budget to tune.
2. **The projection filter is gated on `sessionController`; the shipped roster read and the slot credit
   share one gate on `agentTeams`.** The two `agentTeams` effects need different shapes (`listMembers` and
   `roster.maxMembers`) and keep separate installers, marks and disposers, but they arrive together
   because they are two reads of one service.
3. **The tombstone set is one object, and one invalidation serves every hook.** `createRetiredCache` holds
   the set the hooks strip; `retire_member` and `restore_member` invalidate it in the same call that
   writes the record. A read that throws does **not** clear the set: the last good set stays in force and
   the failure is reported. An empty set on failure was the second silent no-op — both lists came back
   full and nothing said so.
4. **The shipped roster read is filtered synchronously.** `list_agents` calls
   `agentTeams.listMembers(agent)` and maps the returned array without awaiting it
   (`@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:321-327`), so an async wrapper would turn
   the array into a promise and break the tool. The wrapper therefore reads the same set synchronously
   from the in-memory roster table, the way the panel overlay already reads live rows (ADR 0023): it
   cannot go stale, so it needs no invalidation of its own. It drops retired ids only; the return type and
   every other row stay as the host built them.
5. **The outcome is part of the tool surface.** `list_members` always answers `host_hooks`, declared in
   its output schema: `panel_filter`, `roster_filter` and `slot_credit` as `installed` or `absent`;
   `stripped_ids` and `tombstone_read_failed` while a filter is installed; and a `message` naming the
   absent hook, the service it needed, and what that means for the two lists. A hook that can never
   install is therefore a typed answer rather than an empty panel with no explanation.
6. **Never twice, still.** Each installer keeps the mark it already had across reloads, and the deferred
   path goes through the same installer, so a second load reuses the installed wrapper instead of wrapping
   it again. A re-run after the gate unloads finds the mark gone (the disposer removes it) and installs
   the new wrapper, which is one wrapper, not two.
7. **No hook is fatal.** A missing service, a service without the method being wrapped, or a callback that
   throws leaves the hook `absent`; registration, the roster, the trash, the board and every other tool
   are untouched. `ctx.inject` a service that never appears leaves the callback dormant, which is the
   intended end state for a headless profile.

This ADR does not change ADR 0023's overlay: the same four exits, the same four fields, the same absence
for a retirement. It changes *when* the overlay installs, and adds the shipped roster read as a second
consumer of the same tombstone set.

## Rationale

- **The service was missing, not the code.** Reading the service again later is the whole fix; the only
  wrong part of the old design was treating one instant as the final answer, and hiding it.
- **The framework already owns dependency timing.** `ctx.inject` is exactly the primitive this defect
  needs, and it is the same mechanism the plugin's own `inject` uses. A timer or a `ctx.on('internal/service')`
  listener would be a second, worse implementation of it.
- **One set, one invalidation.** Two caches would let the panel and `list_agents` disagree about which
  member was retired, which is the kind of drift that is hard to see and impossible to explain.
- **Visibility is cheaper than a retry.** The information the owner needed ("did it install?") is a
  three-field answer the model and the person can both read; it costs one storage read on a tool call that
  already reads the roster.
- **Synchronous read for a synchronous caller.** The alternative — making `listMembers` async — would have
  changed the shipped tool's contract and broken `.map`. Reading the live table is the only shape that
  keeps the method synchronous and honest.

## Alternatives rejected

- **Add `sessionController` to the plugin's `inject` array.** Then the whole plugin waits for the Web layer:
  no tools, no roster, no retirement in a headless profile, and one missing service disables everything.
  A hook is an effect, not a prerequisite for the tools.
- **Retry on `internal/service` or a timer.** A listener duplicates what `ctx.inject` already guarantees,
  needs its own teardown, and can still miss a service that appears before the listener is attached.
- **Make `listMembers` async so it can await the cache.** The shipped caller does
  `Promise.resolve(ctx.agentTeams.listMembers(...).map(modelMember))`; a promise has no `.map`, so the
  tool would throw. Changing the host's return type is not available to a plugin.
- **Filter `list_agents` by wrapping the tool instead of the service.** The tool row is disabled by this
  bundle's patch, so its wrapper is not this plugin's to own; the service method is the seam that exists.
- **Fail the load when a hook cannot install.** It would turn a degraded feature into a dead plugin, which
  is the opposite of what the owner needs when a Harness upgrade changes a shape.
- **Report the hook state once at load.** Load-time state is exactly the thing that was wrong; the answer
  has to be read when it is asked for.

## Consequences

- A normal Web profile installs all three hooks shortly after the plugin activates, when the services it
  names are published; a headless profile installs the two `agentTeams` hooks and reports the panel filter
  absent.
- `list_members` carries a small block and a schema-declared field. A model that sees an empty panel or a
  retired row in `list_agents` can read whether the hook installed and why, instead of guessing at the
  roster.
- A failed tombstone read no longer un-hides every retired member; the last good set stays in force and
  `tombstone_read_failed` says the set is stale.
- The shipped `list_agents` tool and the built-in picker/panel now agree: a member this plugin retired is
  absent from both, and a member it owns is present in both. A caller that wants the shipped journal's own
  view (including retired members) has no supported surface for it; nothing in the Harness consumed those
  rows except the two tools, and the retired rows were never useful to either.
- `tests/hook-install.test.mjs` drives a fake of the Cordis gate: a service absent at load and published
  later installs exactly once, a service that never appears reports `absent`, a reload does not wrap twice,
  and dispose restores every method. The unit tests pin the 37-row/5-tombstone strip, the 36-entry catalog
  frame, the failed read and the two invalidations. The live install — the actual panel and `list_agents`
  on a real profile — remains the owner's install check.

## Revisit when

The Harness exposes a public projection-contribution seam or a roster read a plugin may register into
(neither would need a service patch), or Cordis changes what `ctx.inject` guarantees about re-running after
a service is replaced. Either would let the deferred wrappers become registrations.
