# 0008 — The plugin is model-facing only

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** 0005, 0006

## Context

v0.3 shipped a Settings panel as a browser half (`client.js`) over a loopback HTTP bridge (`routes.js`),
delivered by two merged pull requests (#8: P3-01..P3-03, #9: P3-05). It was never installed in a real
profile: activation, client-bundle composition and the rendered page were all unverified, and P3-04
carried that check. The owner then reported the panel unusable in real use — the clicks did not work —
and made the call that opens this change:

> remove the web UI entirely, and invest the effort in the model-facing surface: the agent must be able
> to see and control the whole agent team AND every subagent, on its own.

That is a decision about what the plugin is for, not a bug report. The panel duplicated operations the
model already had, and the thing the owner actually wanted was a model that can control its own team.
A surface that has never been rendered and whose interactions fail in use is also not a known quantity
to repair; the repair itself would need the same unverified render path.

## Decision

**Delete the browser half and the HTTP bridge; keep and widen the model-facing tools.**

1. `client.js`, `routes.js` and `tests/routes.test.mjs` are removed. No panel-store modules exist in the
   repository. `index.js` no longer injects `webServer` and no longer registers a route.
   `package.json` loses `exports["./client"]`, the whole `dsh.client` block and the deleted files from
   `files`, and moves to `0.4.0`: a surface is being removed. `scripts/check.mjs` loses only the checks
   that needed a client half; the zero-`@deepseek-ai`-import and published-module checks stay.
2. The adoption that already covered members of the shipped team roster is widened to **every descendant
   of the calling agent**, read through `ctx.subagents.listDescendants(rootSessionId, signal)`. A child
   spawned with the shipped `subagent` / `subagent_fork` tool is now listed, stopped, messaged and
   retired like any other member. Every `list_members` row carries `child_id` as well as the target.
3. The decisions that were already right survive: the operation bodies stay in `actions.js` (one place,
   no re-inlining), the roster stays in the per-Lead-session `storageDomain` model (ADR 0003), and
   `host-hooks.js` keeps the projection filter and the slot credit — they are backend behaviour that
   keeps retired members out of the shipped pickers and credits the budget, not UI code.

**Superseded:** 0005 (share the operations behind an HTTP bridge) and 0006 (scope the panel to one Lead
Session). Their bodies stay as written. The per-Lead-session *bridge* design is deleted with the bridge;
the per-Lead-session *roster* storage model survives. The change brief also named an ADR 0007; the
repository contains no such ADR at the time of writing, so there is nothing to mark.

## Two small decisions

- **An adopted one-shot subagent keeps its tombstone and its trash move.** The tombstone is the only
  thing preventing the next read from re-adopting the child — draining does not remove its row from the
  parent's durable catalog — and moving the artifact to the trash does not add accumulation, it
  relocates an artifact that would otherwise stay in the live sessions store.
- **`message_member` does not accept a raw `childId`.** The target is already unique among addressable
  members, and a second selector would have to be honoured by every tool that takes one or the surface
  would be inconsistent; the row's `child_id` reports the identity the host's own listings show, for
  correlation.

## Alternatives rejected

- **Keep the bridge for a future UI.** It is a second, unauthenticated-from-the-browser mutation surface
  whose only consumer was the panel being removed; keeping it preserves the security surface and the
  maintenance cost for a page nobody is building. A future UI should start by re-deciding the bridge.
- **Keep a read-only panel.** A page that only lists the roster does not fix the reported problem, keeps
  the client half, the `dsh.client` wiring and the same unverified composition and render path, in
  exchange for one read the model already gets from `list_members`.
- **Repair the clicks.** The owner explicitly chose not to, and the failure was never reproduced in a
  composed profile — fixing an unrendered interaction means guessing at a render path that was never
  observed working.

## Consequences

- The bundle is Host-only. The Plugin Manager row installs exactly as before; nothing is composed,
  served or rendered for a browser, and the owner sees the team through the model (`list_members`) and
  the host's own subagent pickers. Retirement still removes a member from those pickers through the
  projection filter.
- The model can now reach every subagent it spawns, which is the capability the change was for. The
  installed seam's return shape is recorded in `docs/architecture-en.md` §4.5.1, because it is a
  different generation from the public source tree and must be re-read after a Harness upgrade.
- `webServer` is no longer a required injection, so a profile without a web server can install this
  bundle. The tools are the whole plugin.
- P3 is cancelled in `PLAN.md`; the two merged UI PRs are recorded as removed in `PROGRESS.md`.

## Revisit when

The owner wants an in-app roster view again. That is a new decision with a new ADR, and it should start
from the operations in `actions.js` rather than from the deleted bridge.
