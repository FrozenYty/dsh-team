# 0016 — A member starts with the Lead's values unless the model names others

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** —

## Context

Until v0.11.0 `spawnMember` sent the installed subagent seam only `{ prompt, parent }`. The seam has
accepted three more request fields all along, so **every member inherited the Lead's working directory,
model and tool set** — and nothing in the tool surface said so. That is not one missing feature:

1. **Isolation.** Two members editing the same checkout is a conflict the Lead cannot see coming. The
   seam's `request.cwd` selects the child's working directory, and a relative path is resolved by the
   Harness against the parent's cwd.
2. **Cost.** A delegated subtask often does not need the Lead's model. `request.agentOptions`
   (`{ provider, model, reasoningEffort, maxTokens }`) selects the child's route, gated by
   `provider.capabilities.agentOptions` — true for the in-process spawn/fork providers, false for every
   external backend, whose capability advertisement is literally `NO_START_CAPABILITIES`.
3. **A read-only or restricted member.** There is **no per-call tool allow/deny**: `agentPreset` is the
   only route, and the seam rejects `toolFilter` outright. `request.agentPreset` selects a registered
   preset id; spawn providers advertise `agentPreset: true`.

Three facts are ones a reader will otherwise not believe, so they are stated here as facts about the
installed Harness rather than as plugin policy:

- **Tool restriction is available only through an agent preset.** A per-call `toolFilter` does not
  exist, and a preset id is the only handle. A helper that must not write files is started from a preset
  that mounts fewer tool plugins.
- **A preset id comes from the profile's bundle patches.** The registry neither scans directories nor
  accepts a path, so a plugin cannot conjure a read-only member by naming a folder.
- **There is no worktree field.** A worktree is `ctx.worktrees.create(...)` followed by passing its
  `path` as `cwd`; that service is optional and experimental, so the plugin does not create one. The
  caller may point `cwd` at a worktree it made itself.

## Decision

**One nested parameter, `spawn_options`, forwards `cwd`, `agentOptions` and `agentPreset`; omission of
the object or of any field means inherit, and the result reports what was applied.**

1. **The surface is nested, not six flat parameters.** `spawn_member` already carries `name`, `label`,
   `prompt`, `assignment`, `replace` and `ephemeral`. These three are not roster concepts — the plugin
   interprets none of their values — so they travel as one pass-through object rather than tripling the
   flat surface. The nesting makes "the caller supplied none of them" one structural test instead of six
   undefined checks, which is what keeps the request byte-identical for an existing profile. Inside the
   object the fields are the Harness concept names in the plugin's snake_case vocabulary:
   `cwd`, `agent_options` (`provider`, `model`, `reasoning_effort`, `max_tokens`), `agent_preset`. The
   mapping to the request's `cwd` / `agentOptions` / `agentPreset` happens in one function,
   `activationOptions`, so the parameter, the request and the reported result cannot drift apart.
2. **Omission is inheritance, and it is the default.** A spawn with no `spawn_options` composes exactly
   `{ prompt, parent }` — pinned by a test that asserts the exact request object — and its result gains
   no field. This is the compatibility rule: a profile that passes none of them behaves byte-identically.
3. **`cwd` is a path, and the plugin does not touch it.** It is validated as a non-empty string and
   forwarded verbatim. The Harness resolves a relative path against the parent's working directory and
   keeps the parent's permission roots, so a cwd outside the sandbox grant stays denied; a plugin that
   pre-resolved the path would disagree with the Host and could route around that check.
4. **A refusal is probed, not predicted.** The plugin does not pre-check a preset id or a provider's
   capability table; it starts the member and routes the seam's typed failure on `error.code`, the
   documented machine-routable class. The three codes in the brief and the two the probe found:

   | Host code | Plugin `reason` | What the sentence tells the model |
   |---|---|---|
   | `UNSUPPORTED_CAPABILITY` | `unsupported-capability` | the provider cannot apply the supplied option; start again without it to inherit |
   | `PRESET_UNAVAILABLE` | `preset-unavailable` | no `agentPresets` service is mounted, so no member can select a preset |
   | `agent-preset/not-found` | `preset-not-found` | that id is not declared; the declared ids are listed, and a directory is not scanned |
   | `agent-preset/invalid` | `preset-invalid` | the preset is declared but cannot activate, with the reason |
   | `UNAUTHORIZED` | `unauthorized` | the Lead Session is not the exact live Agent this process holds |

   `PRESET_UNAVAILABLE` is the *missing service*; an unknown id is `agent-preset/not-found`, carrying
   `details.available`. The brief named the first as the unknown-id case; the installed source says
   otherwise, and this ADR records the source rather than the brief. Anything else keeps the existing
   thrown error, and the sentence never carries a raw host stack.
5. **A refused start is a typed result, not a throw.** The refusal is `{ ..., started: false, reason,
   message }` built from the record the failed reservation already wrote. The reservation is recorded
   as `failed` before the start is attempted (a crash must leave a visible member), so the result names
   that visible record and **nothing is left `provisioning`** — no half-registered member and no child.
   With `replace`, the refusal also answers `predecessor_retired: false` and says the predecessor is
   still live, which is the replacement ordering ADR 0009 already fixed.
6. **The result reports what was applied under `started_with`.** Only the fields the caller supplied are
   echoed, in the same vocabulary the parameter uses. A spawn that supplied none adds nothing. The
   plugin reports what it forwarded rather than reading the child's resolved `AgentOptions`: the seam
   exposes no supported read of them, and its session metadata copies the parent's cwd, so a read-back
   would report the Lead's directory as the child's.
7. **A refusal for a stale target names the member that now holds the name.** A target is namespaced by
   generation (`reviewer`, `reviewer-g2`, …), so a caller holding the predecessor's target after a
   replacement is refused the *name*, not the member. `retire_member`, `restore_member`,
   `message_member` and `stop_member` keep the refusal they already gave and add
   `current_holder: { target, generation }` plus a sentence pointing at it, whenever another generation
   of that base name is live. The holder is read from the stale record's `name` (never by stripping a
   `-g<N>` suffix — a base name may legally end in `-g2`), and the highest live generation wins. Which
   refusals happen does not change: a tombstone is still `retired`, a never-existent target is still
   `missing`, and a name whose other generation has also retired reports no holder.

## Rationale

- The three fields are one concept — "what the child starts with" — and travel together. A caller that
  wants a preset usually also wants the route, and a nested object makes the whole group's omission
  the inherit path.
- Probing is the only honest option: the plugin cannot know a profile's preset ids without asking the
  registry, and asking it would duplicate a decision the seam makes one line later. Routing on `code`
  is also the seam's own guidance (`HarnessError.code` is documented as the route target, never the
  message).
- Reporting only what was supplied makes the new surface invisible to a caller that does not use it,
  while a caller that *does* choose a model sees it echoed in the result it is already reading.

## Alternatives rejected

- **Six flat parameters on `spawn_member`.** It doubles the tool's surface with fields that are not its
  concepts, and each needs its own "omit to inherit" sentence. It would also make the "nothing was
  forwarded" check six conditions, which is exactly the kind of rule that rots.
- **Reporting host names (`agentOptions`, `reasoningEffort`) in the tool surface.** The plugin's
  model-facing vocabulary is snake_case everywhere; the host spelling lives in the request mapping and
  in this ADR.
- **Pre-validating the preset id against `ctx.get('agentPresets').list()`.** It duplicates the seam's
  check, can disagree with it across a reload, and a plugin that gates on a service the seam also
  requires would report the same failure twice.
- **Resolving `cwd` before forwarding.** The Harness owns that rule and the permission roots; a
  pre-resolved path would be a second implementation with a different base.
- **Creating a worktree inside the plugin.** `ctx.worktrees` is optional and experimental; the plugin
  forwards the path instead of inventing lifecycle it cannot guarantee.
- **Throwing on a capability refusal.** The model can fix the call by omitting one field; a thrown
  message is where the plugin's other refusals deliberately do not put that instruction.

## Consequences

- `spawn_member` gains one parameter and one result field; `MEMBER_ROW` gains `started`, `reason` and
  `started_with`; the four other tool schemas gain `current_holder`. A spawn that passes no options
  produces the same request and the same result shape as before.
- A failed capability start leaves one `failed` record per attempt, like every other start failure; a
  retry reserves the next generation, so a typo in a preset id is visible in `list_members` as a failed
  member rather than vanishing.
- A Lead that wants a read-only member must arrange a preset in the profile's bundle patch. The plugin
  can select one but cannot create one, and this is a Harness fact, not a missing feature.
- The current-holder field is an addition to four existing refusals; the refusal reasons and the
  matrix are unchanged.
- The version moves to `0.12.0`.

## Revisit when

The Harness ships a per-call tool allow/deny (then `agentPreset` stops being the only route), a
supported read of a child's resolved `AgentOptions` and cwd (then `started_with` can report the
resolved values instead of the forwarded ones), or a worktree primitive that makes `ctx.worktrees`
non-experimental (then `cwd` could name a worktree the plugin owns).
