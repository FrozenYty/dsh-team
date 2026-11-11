# 0006 — Scope the roster panel to one Lead Session per view

> **Superseded by [0008](0008-model-only-surface.md).** The Settings panel was removed; the per-Lead-session *roster* storage model this decision relied on survives.

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

The durable record was already one roster per Lead Session (`roster.js`: `table.get(leadSessionId)` → a
record keyed by that session). The panel nonetheless flattened every roster into a single page. The owner
reported the result as unusable in the words that opened this change: each session should have its own
roster, and lumping them together makes a roster hard to find.

Two questions had to be answered together, because each constrains the other:

1. **What is the unit of the bridge?** One session per read, or the whole store in one payload filtered by
   the browser?
2. **Who resolves "the session the user is in"?** `settings.section` is root-scoped, so the panel has no
   session handed to it; and `leadSessionId` values are not human-readable, so a picker without titles is
   no better than the flat list.

## Decision

**One Lead Session per view.**

- **The bridge is per session.** `GET /api/team-roster/state?leadSessionId=` answers exactly one roster with
  its member rows. `GET /api/team-roster/sessions` answers a counts-only index
  (`{ leadSessionId, memberCount, liveCount, updatedAt, leadLive }`) for the picker. Only the per-session
  payload is large, so only the per-session payload carries member rows; the index is cheap enough to poll
  and works while a roster's Lead Session is closed.
- **The browser resolves the current session and joins titles.** The root-scoped slot receives the shell's
  standard hooks; `useSessions` is the root hook over the client session catalog
  (`@deepseek-ai/dsh-client-ui-session/lib/client.js` lines 1120–1123, `ctx.slots.provideRoot({ hooks: {
  sessions: ctx.sessions.list } })`). Catalog rows carry `displayTitle`/`title` and `retainedBy`
  (`@deepseek-ai/dsh-api-session-controller/lib/client.js` lines 4162–4182), and the session the user is in
  is the row with `retainedBy.mainView > 0` — the test the shipped root-scoped session browser uses
  (`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` line 3697, reading `useSessions((state) => state)`
  on line 3669). No session data crosses the bridge.
- **The default-selection rule lives in one place, on the Host.** `buildSessionsIndex` returns
  `selectedLeadSessionId`: a named `currentSessionId` always wins (even when it has no roster, so the panel
  can say so); otherwise the documented order — live Leads first, then the newest write, then the id. The
  browser uses the pick as soon as it exists and this rule before that.

## Alternatives rejected

- **Keep one flattened `/state` and filter in the browser.** The smallest diff, and still wrong: the payload
  grows with every session and every member row, the page keeps the model the owner rejected, and a client
  that filters cannot tell "this session has no roster" apart from "loading".
- **Resolve titles on the Host by listing Sessions.** It would make the bridge depend on services a panel
  should not need, it cannot answer for a Lead Session that is closed (the interesting case), and it
  duplicates the catalog the page already subscribes to. A loopback route does not need a session listing.
- **Persist the selected session in a new storage domain.** Selection is view state, not a lifecycle fact;
  a persisted selection is stale as soon as that session is gone, and it contradicts ADR 0005's rejection of
  durable UI state.
- **Derive the current session on the Host from `leadLive`.** Different question: several Leads can be live
  in one process while one human has one tab open. `leadLive` survives as the fallback ordering, not as the
  mechanism.

## Consequences

- The panel opens on the session the user is in, names it with its title and short id, and offers the picker
  for the rest. A session without a roster says so instead of rendering an empty page.
- Degradation is explicit rather than silent: without the `useSessions` seat the panel falls back to the
  Host's order and keeps the picker prominent.
- One runtime fact remains unverified and is recorded as such: whether `retainedBy.mainView` stays non-zero
  while the Settings panel is open — the shipped browser suppresses its own "current" highlight when a
  sidebar panel is active (`dsh-client-ui-workspace/lib/client.js` line 3615). P3-04 carries the live check.
- No new dependency, no new storage domain, and the client half is still a file the host composes
  (`dsh.client.immediately` stays `true`).

## Revisit when

The shell exposes a first-class "current session" service or selector to root-scoped slots, or
`settings.section` gains session-scoped children. Either would replace the `retainedBy.mainView` heuristic
with a supported one without touching `actions.js` or the bridge's shape.
