# 0005 — Share the roster operations behind a loopback HTTP bridge

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

P3 delivers a Settings panel, so a human can retire and restore members without typing a tool call. The
panel runs in the browser; the roster and the lifecycle operations live in the Host half. Two questions
had to be settled together:

1. **How does the browser reach the operations?** The bundle may import nothing from the Harness
   (ADR 0002), cannot use `ctx.remote` registries that shipped packages own, and has no build step. The
   installed web server does expose `ctx.webServer.register`, which the shipped `client-connection`
   plugin uses for its own `/api` and `/connect` routes: a named route whose `handler` receives the raw
   node request and response, with prefix matching and a disposer.
2. **Where do the operations live?** They were bodies inside `install()` in `index.js`, reachable only
   from a tool's `execute`. A route cannot call a closure whose only entrance is a tool registration.

The risk to avoid is the one the skill's user-actions rule names: an operation implemented twice drifts,
and the UI and the model start disagreeing about what "retire" means.

## Decision

**Extract every operation into `actions.js` as a dependency-taking function, and let both callers call
it.**

- `listMembers`, `spawnMember`, `messageMember`, `stopMember`, `retireMember`, `restoreMember` take
  `{ ctx, table, leadSessionId, leadAgent, ... }` and return the exact result object their tool returns.
  `index.js` keeps argument validation, the `requireLead` authority check and the tool result schemas.
- The Lead `Agent` is explicit because a route has no model caller. `ctx.agents.get(leadSessionId)`
  supplies it when that Session is live; retire refuses with a sentence when it is not, and the tool-only
  operations throw that sentence rather than a `TypeError`.
- `routes.js` registers one prefix route, `/api/team-roster`, in `apply()` through
  `ctx.inject(['webServer'], ...)`. Endpoints: `GET /state`, `POST /retire`, `POST /restore`.
- The route is outside the Connection fence, so `routes.js` is the fence itself: loopback
  `remoteAddress`, same-authority `Origin`/`Sec-Fetch-Site`, a 64 KiB JSON body cap, and JSON errors with
  statuses.
- `client.js` registers a `settings.section` page through the module table and polls the state endpoint.
  No build step and no bundler: React comes from the module table, colours come from `--dsw-alias-*`
  theme tokens.

## Alternatives rejected

- **Keep the operations in `index.js` and expose them with a client-side RPC.** The Host Connection
  service does provide an RPC registry, but it is scoped to the plotting package that owns it and is
  consumed through `ctx.remote` channels declared by shipped packages. A third-party bundle registering a
  channel would depend on a surface that is neither documented for external plugins nor stable, and the
  browser half would still need a client-side remote declaration it cannot build.
- **Duplicate the retire/restore logic in the route.** Smallest first patch, worst long-term shape: two
  copies of a destructive lifecycle operation, with two sets of failure reasons that will disagree after
  the first fix.
- **A mutation endpoint built from a `resource`.** `resource()` answers GET/HEAD only, so a POST receives
  405 before the handler runs. A route is the supported shape for a mutating request.
- **Push changes to the panel with Server-Sent Events or the shipped projection stream.** A stream is
  more surface for one panel: the roster changes are rare and cheap to read, so a three-second poll while
  the page is open is enough and needs no new channel, authentication, or reconnect logic.
- **A separate Settings web app or a second page root.** The shell already owns Settings and its slot
  list; a bundle that replaces the app root would fight the host (and the UI skill forbids it).
- **Persist UI state in the Host.** The panel derives everything from the roster store; the only durable
  state is the roster itself. No new storage domain, no new record shape.

## Consequences

- **One implementation, two shapes of caller.** A fix to retirement reaches the model and the panel at
  the same time. A new operation only needs a tool and a route entry around the same function.
- **The bridge is a second security surface.** It is fenced, capped, and loopback-only, but it is
  reachable by anything running on this machine. That is the same trust boundary as the existing `/api`
  transport; the operations themselves remain Lead-scoped because the roster key is the Lead Session id
  the caller names.
- **`index.js` is no longer the place to read the lifecycle.** The tool bodies are now one call each, and
  the behaviour lives in `actions.js`. This is a readability cost paid once.
- **A panel action needs a live Lead.** That is honest: draining, interrupting and starting work all
  require the Agent that owns the child. Restore is the exception and works from the panel for an old
  team.
- **Unverified until the bundle is reinstalled.** Activation, client-bundle composition and the rendered
  page are not covered by `node scripts/check.mjs`; the tests use fakes and never open a socket. P3-04
  carries that check.
- No new dependency was added, and the Host half still imports no Harness package.

## Revisit when

The Harness publishes a supported client-facing operation API for third-party plugins (a documented RPC
registration, or a public per-plugin data route), or the Settings slot contract changes shape. Either
would let this bridge be replaced without touching `actions.js`.
