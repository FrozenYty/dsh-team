# 0013 — An ephemeral member is retired by a lazy, evidence-backed sweep

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

P4-01 asks for ephemeral members: the parallel fan-out use case, where several members are spawned for
one-shot work, their answers are collected, and they leave the roster without one `retire_member` call
per member. Today the roster only grows, so a fan-out either costs one tool call per member or leaves
finished members listed.

Two facts constrained the design, and both were established before the code:

1. **There is no completion event.** `docs/architecture-en.md` §4.3 already recorded the cell: `active` ×
   "the child finishes its turn" is *"no durable change — no completion notice is observed"*. So no event
   hook was invented; the signal had to be discovered.
2. **The installed seam is not the public source tree.** The plugin is built against
   `@deepseek-ai/dsh-subagent` `0.2.2-rc.1` inside the installed asar, and its behaviour is read there.

## What was verified, and where

Read out of the installed `@deepseek-ai/dsh-subagent` `lib/index.js`, not from the public tree:

- `listChildren(parentSessionId, signal)` (lines 3162–3164) and `listDescendants(rootSessionId, signal)`
  (lines 3181–3183, implementation 2380–2446) build each child row with exactly one expression for
  `activity`:

  ```js
  // @deepseek-ai/dsh-subagent/lib/index.js:2435
  activity: sessions.get(entry.id) === void 0 ? "inactive" : "running",
  ```

  So the field has exactly two values. `"running"` means the child is resident in the live session
  store; `"inactive"` means it is not. **`inactive` is not a completion signal**: a child that has just
  been reserved and has not run a turn is also absent from that store, so the same value describes
  "finished" and "never started". `running` is trustworthy positive evidence that the member is alive,
  but it is not evidence that it stopped.
- The row schema the traversal feeds is `{ id, mode, label?, kind: 'child', parentId, depth, activity,
  hasChildren }` (catalog rows at lines 709–791; the child row assembled at 2429–2437).

The plugin therefore needed evidence it records itself.

## Decision

**An ephemeral member is a member with a flag, and a lazy sweep retires it once there is positive
evidence it ran and then stopped. Nothing about retirement is reimplemented.**

1. **`ephemeral` is a property of a member, set at spawn.** `spawn_member.ephemeral: true` stores
   `ephemeral: true` on the record; the default is false and a profile that never sets it is unchanged.
   `list_members` rows report it. **No phase is added**, so no `dormant`: the member stays `active` until
   a sweep retires it, and every existing matrix cell keeps its meaning.
2. **The evidence pair.** A sweep candidate must be `active`, `ephemeral`, carry `startedAt` — written
   when the activation resolved, which is the plugin's own record that the child started, so a
   reservation that never published has none — **and** be reported not resident by the local live
   registry (`liveStateOf` → `ctx.agents.get(childId)`). A member that never started is never swept; a
   member still running is never swept. `activity: 'running'` from the subagent registry is the same
   "resident" fact read from the other service; the field cannot supply the "stopped" half, which is why
   the local registry and the recorded start are what the decision rests on. The installed value was used
   where it is trustworthy and rejected where it is not.
3. **The sweep is lazy.** It runs at the start of exactly two roster operations: `list_members` (the read
   where the model collects results) and `spawn_member` (the fan-out where freed slots matter). Both
   already re-read the roster. There is no timer, no background task, no plugin clock and no model call;
   the sweep returns before doing anything when no member is ephemeral.
4. **Retirement is the existing protocol.** A swept member goes through `retireMember` — drain,
   tombstone-first, artifact move, retention cap, host effects — and its tombstone records
   `retireReason: 'ephemeral member: its turn ended'`.
5. **`message_member` clears the flag.** Messaging an ephemeral member again is a declaration that it is
   not one-shot; without this rule a message that arrives just before a sweep would be eaten by it. It is
   the one case where a sweep could otherwise retire work the model intended to keep.
6. **A sweep that acted says so.** The triggering operation's result carries `swept` and
   `swept_targets`; when the sweep retired nothing the result is byte-for-byte what it was before this
   feature.

## Alternatives rejected

- **A Harness event or hook for completion.** None exists (`docs/architecture-en.md` §4.3), and the
  plugin may not depend on one. The alternatives were to invent a poll or to read a real registry, and the
  registry is real.
- **Use `activity: 'inactive'` as the completion signal.** Rejected on the mechanism at
  `lib/index.js:2435`: `inactive` is also the state of a child that has never run, so a freshly reserved
  member would look finished. That is precisely the "never retire something that has not run" failure.
- **A `dormant` phase (or any stored "finished" state).** Rejected: it needs a writer, and the only
  possible writer is the same lazy observation the sweep already makes. Adding it would change every cell
  of the state matrix for no new information, and the project has already recorded that live state is
  read at call time and never stored.
- **A timer or interval sweep.** Rejected: it adds a second clock and works on a schedule when there is
  nothing to do, while the roster is only ever touched by the model's own calls. The lazy trigger points
  are the two calls at which a finished member is actually in the way.
- **Sweep at the start of every tool.** Rejected: `message_member` must clear the flag before any sweep
  could act (point 5), and the other target-scoped operations (`stop_member`, `retire_member`,
  `restore_member`, `compact_member`) act on one named member, so a sweep there would be an unrelated
  retirement on a result that does not report it.
- **A tool the model calls to declare a member finished.** Rejected: that is the per-member cost P4-01
  exists to remove.
- **Record `startedAt` on every member.** Rejected: the field has exactly one consumer, the sweep, so
  writing it only on ephemeral members keeps every non-ephemeral record byte-identical to a pre-v0.9 one.
- **Retire the member in the spawn path when `delivery: 'caller'` settles.** Rejected: the plugin uses
  `delivery: 'parent'`, the child's settlement is not a durable notice the plugin observes, and it would
  couple the roster to one delivery mode.

## Consequences

- A fan-out now cleans itself up: the members leave the roster through the normal retirement path and
  their slots come back through the existing slot credit, with no per-member call.
- The tombstones accumulate exactly as they do for manual retirements — the roster still only grows, and
  the retention cap still governs the trash, not the record list.
- **A false negative is possible and is the safe direction.** A member whose start was never recorded
  (the crash window between the reservation and the recorded start) is never swept and must be retired by
  the model; a member that stays resident and idle is left for a later sweep. Neither disappears by
  accident.
- An adopted child is never ephemeral: adoption cannot know it was one-shot, and `ephemeral` is set only
  by `spawn_member`.
- Loading a record now validates the two new fields; both are optional, so no stored roster is refused by
  it.

## Revisit when

The Harness ships a durable completion notice for a child, or the descendant row's `activity` grows a
value that means "finished" rather than "not currently resident". Either would remove the `startedAt`
requirement and let the sweep act on a published fact instead of the plugin's own evidence.
