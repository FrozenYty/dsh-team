## 2026-11-11

- **The repository exists, and it inherits the documentation rules of its neighbour.** Created as
  `dsh-team-control` with the same shape as the other long-lived projects on this machine: `AGENTS.md`
  for assistants, `CONTRIBUTING.md` for branches and commits, `PLAN.md` as the only task source,
  `PROGRESS.md` append-only, bilingual documents in `docs/`, and one ADR per decision that is expensive
  to reverse. `scripts/check.mjs` is the local gate — it proves the manifest, the entry syntax, locale
  parity and the absence of machine-specific paths, and it deliberately cannot prove the plugin works.
- **v0.1 was delivered and verified before the repository existed; it is recorded here so the record
  starts complete.** The bundle now enables the shipped `compaction-basic` row (it shipped `inactive`,
  which is why no agent had ever condensed anything) and adds two Team-Lead-only tools,
  `member_context` and `compact_member`. Verified live: the row's status moved from `inactive` to
  `schema`, `member_context` reports `compactor: available` with real token numbers, and the profile's
  `command-compact` row was returned to its default after an experiment showed it cannot activate
  without the unmounted `commands` service.
- **The manual compaction idea was downgraded on measurement, not on taste.** A local child is unloaded
  when it goes idle, and `compactNow()` requires a resident idle Agent, so a “compact this finished
  member” button has almost no window to act in. The durable mechanism is automatic compaction at
  wake/step time, which is what enabling the backend provides. `compact_member` stays, documented as
  the narrow tool it is.
- **Decision recorded in ADR 0001: stop extending the shipped roster, own it.** The shipped roster is a
  fold over an append-only log with a closed phase set; a synthetic “retired” event does not fail
  safely, it poisons the projection for that Lead. Upstream is replacing that design with plain
  subagents and still defers deletion. The plugin will therefore own the roster on `ctx.subagents`,
  with generation-suffixed names and a real retired state.
- **Decision recorded in ADR 0002: the bundle entry imports nothing.** A profile bundle is linked from
  its workspace path, so a bare `@deepseek-ai/*` import fails with `ERR_MODULE_NOT_FOUND` — the installed
  first-party market plugin avoids dsh imports for the same reason. Tool definitions are built as
  canonical JSON Schema objects instead.
- **Two spikes are open and named in `PLAN.md`.** P2-01 needs the durable-storage API, P2-02 needs the
  exact subagent lifecycle semantics including whether a retired child can be hidden from the app. Both
  are being answered from the installed asar, not from memory.
- **P0-02 is ticked on evidence, not on intent.** The repository was pushed to
  `github.com/FrozenYty/dsh-team-control` (private for now), then cloned into a fresh temporary
  directory and checked there: `node --check index.js` and `node scripts/check.mjs` both pass from the
  clone. A repository that only passes in the directory that produced it has not been tested.
- **P0-03 is ticked because the check job actually ran, not because the workflow file exists.** Pull
  request 1 ran the `check` job on GitHub and finished green. The same PR also caught a real defect in
  the check script: the machine-path rule matched the letter-plus-colon inside an `https` URL, so it
  failed on the README line that links this repository. The rule now requires the drive letter to
  follow a non-word character, and a five-case self-test pins both directions.
- **P2-01 and P2-02 are ticked on two spike reports, and one of them corrected a wrong assumption.**
  The roster lives in `ctx.storageDomain` — a domain whose tables read synchronously and whose `put`
  resolves after the record is on disk — not in a new Session event type, which the Harness would refuse
  to reopen (ADR 0003). The larger correction: the installed subagent seam is `0.2.2-rc.1` and is **not**
  the generation in the public source tree. It has no `name` field and no `resolveName`; the public tree
  has both. So member names are ours to keep, in our own map, exactly as the shipped team does it with a
  generated `childId`. The state matrix in `docs/architecture-en.md` §4.3 was written against the
  installed API, including the two expensive cells: retirement during provisioning, and retirement
  during an active turn.
- **P2-03 and P2-04 are ticked after a live run, and the live run found a real defect.** The first
  `spawn_member` call started the child, the child answered, and the tool still failed: a freshly
  spawned member has no committed model request, so `contextPressure` returned an undefined window and
  the registry rejected the result as non-lossless JSON. Numeric fields are now attached only when
  finite. The interesting part is not the bug, it is that the registry caught it — a tool that returns
  `undefined` is a broken contract, not a cosmetic detail.
- **Removal and replacement were exercised end to end, twice.** `probe-a` was spawned, ran, answered,
  and was retired — `drained: true`, `archived: true`, record `retired`. Spawning the same base name
  then produced `probe-a-g2` at generation 2, which is the replacement the shipped roster cannot do.
  Retiring `probe-a-g2` while it was mid-turn exercised the second expensive matrix cell and also
  returned `drained: true`. Nothing was deleted: the child Sessions stay on disk and are archived.
- **The repository is public and `main` is protected, as `CONTRIBUTING.md` always claimed.** Visibility
  was flipped through the repository API, then proven by reading the repository with no credentials
  (`private: false`). Description and topics were set in the same pass. Protection was enabled with the
  `check` context required, strict up-to-date enforced, and force pushes and branch deletion refused;
  an earlier entry in this file says “private for now”, which was true when it was written and is the
  reason this entry exists rather than an edit to it.
- **The members that could not be removed are now removable, and nothing was torn down to get there.**
  Instead of disabling the shipped team tool row (which would have taken the shared task board with it),
  the roster **adopts** what the shipped roster created — identity is the child Session id, the name is
  kept, phase starts `active`. Seven of this session's shipped members were adopted on the first read,
  and `verify-compaction` was then retired for real: `drained: true, archived: true, phase: retired`.
  That is the population the user could not touch before.
- **Messaging and turn-level stop were added and both exercised against a real child.** `message_member`
  delivered to an unloaded member and cold-resumed it (the member replied), then took a second message
  that started a long command; `stop_member` cancelled that turn through
  `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent })` and the Harness reported the child
  “was stopped before it finished”. Stopping keeps the activation and inbox; only retirement drains.
- **`member_context` was removed, not deprecated.** Its rows duplicated `list_members` and it read the
  shipped roster rather than ours, so it would have been wrong for every member this plugin owns.
  Pressure and `compactable` now ride on the `list_members` row, and `compact_member` resolves through
  the owned roster.
- **The plugin is `dsh-team-roster` from v0.3, and the rename does not orphan an existing roster.** The
  storage domain moved from `team_control` to `team_roster`; `openRosterStore` copies the legacy domain
  once, on first open, and leaves the source in place. A rename that silently emptied the roster would
  have been worse than the old name.
- **Retirement now moves the session artifact instead of only hiding it, and two host-side effects make it
  visible.** The session directory goes to `~/.dsh/team-roster/trash/<lead>/<member>-<ms>/`; the host's
  session-list exits are wrapped so retired ids never reach a client; and the legacy roster's budget is
  credited back for one spawn. The first two mechanisms were learned from the peer plugin
  `dsh-team-admin`, which solves the same problem from a human admin panel; ADR 0004 records what was
  adopted and what was deliberately not (its HTTP surface and its separate tombstone file).
- **The plugin now has unit tests, and the runner choice is itself a finding.** Twenty-two `node:test`
  cases cover name generations, adoption, the projection strip, both host hooks (including that they
  restore on dispose) and the session trash. `node --test tests/` cannot run here: the default runner
  spawns a process per file and this machine's sandbox refuses that spawn with `EPERM`. Every place that
  runs the tests uses `--test-isolation=none`, locally and in CI, so a local pass means what a green run
  means.
- **Retirement now has an inverse, and it is a move rather than a guess.** The tombstone records the
  artifact kind and the path it came from, so `restore_member` puts the session back exactly where the
  host expects it. It refuses to overwrite an existing destination, refuses a target a live member already
  owns, and leaves the record retired when the move fails — recovery is never allowed to half-succeed.
  The shipped roster tools stay enabled: they own the shared task board, and adoption already makes their
  members retirable, so nothing had to be torn down to get here.
- **The first restore attempt reported success without moving anything, and the tombstone was the reason.**
  That member had been retired by the pre-restore code, so its record carried a `trashPath` but no
  `originalPath`; `restore_member` fell through to the workspace-unhide branch and returned `restored: true`
  while the session was still in the trash. Two fixes: a record with a `trashPath` never takes the unhide
  branch, and a missing `originalPath` is derived from a sibling Session still on disk
  (`sessionRootFromSibling`) instead of guessed. The one record already damaged by the bug was repaired by
  moving its directory back by hand. The round trip was then re-tested on a fresh member: retire →
  `trashed: true, trash_path` → restore → `restored: true, path ~/.dsh/sessions/<key>/<member>`, with the
  trash directory emptied and removed.
- **The route API for the Settings bridge was verified in the installed Harness, not assumed.**
  `ctx.webServer.register` takes `{ kind: 'exact' | 'prefix', path, handler | resource }`; a `handler`
  receives the raw node request and response and owns the response to completion (dispatch in
  `@deepseek-ai/dsh-host-webserver/lib/index.js` lines 459–471), while a `resource` is answered only for
  GET/HEAD and every other method receives 405 — so a mutating endpoint has to be a handler. The shipped
  `@deepseek-ai/dsh-client-connection` registers its `/api` prefix and `/connect` exact routes exactly that
  way (its `lib/index.js`, the `/api` registration at lines 1044–1058). The peer `dsh-team-admin` uses the
  same shape. The bridge is one `prefix` route at `/api/team-roster`; the plugin waits for `webServer`
  through `ctx.inject` so a profile without a web server keeps the tools and loses only the panel.
- **The six lifecycle operations moved out of the tool closures, which is what lets two callers share
  them.** `actions.js` now owns the bodies of `list_members`, `spawn_member`, `message_member`,
  `stop_member`, `retire_member` and `restore_member`, taking their dependencies explicitly; `index.js`
  keeps argument validation, the Lead-only check and the result schemas. A route has no model caller, so
  the live Lead `Agent` is passed in: retirement without it returns `{ retired: false, message }` naming
  the condition instead of throwing from a missing `session`, and restore deliberately needs no live Lead
  because it only moves files and rewrites a record. ADR 0005 records the decision and the rejected
  alternatives (an RPC channel, a duplicated body, a `resource` route, a push stream).
- **The panel is a real browser half, but it has never been served.** `client.js` registers a
  `settings.section` page (`id: 'team-roster'`, order 25), groups members by Lead Session, polls
  `GET /api/team-roster/state` every three seconds, and puts retire behind an inline confirmation; it
  uses React from the module table, theme tokens for every colour, and the Client locale service (one
  namespace with complete English and Chinese dictionaries) rather than a hand-rolled language switch.
  The `dsh.client` block (`platform`, `immediately`, package injection edges) and the `./client` export
  are checked by `scripts/check.mjs`, which now also proves no Host module imports an `@deepseek-ai`
  package and that the loader id equals the package name. Fourteen new tests cover the fence, the route
  table, the state builder and the no-live-Lead failure; the suite is 36 tests, all passing.
- **What is unverified, stated plainly.** The bundle was not reinstalled, so: the new modules activating,
  the client bundle being composed and served, the panel actually rendering, the locale namespace
  registering in a real page, the loopback/origin fence over a real socket, and a retire→restore round
  trip through the panel are all untested. `node --test` uses fakes and opens no socket;
  `scripts/check.mjs` never loads the Harness. P3-04 was added to carry that check, and the P3 gate stays
  open.
- **The flattened panel was the defect, not the store, so the store did not move.** The owner reported that
  every session's roster was lumped into one list and hard to find; the durable record was already keyed per
  Lead Session, so the fix is scoping the view rather than re-keying the data. `GET
  /api/team-roster/state?leadSessionId=` now answers exactly one roster with its member rows and `GET
  /api/team-roster/sessions` answers a counts-only picker index (`buildSessionState` /
  `buildSessionsIndex`). An unknown session is a normal answer with `exists: false`, which is what lets the
  page say *No team roster for this session yet.* instead of rendering an empty one; a missing id is a 400.
  Six new tests pin both read shapes, those two answers, the index ordering, and the selection rule.
- **The current session was resolved by reading the installed asar, not from memory — and the first place
  that looked right was not it.** `@deepseek-ai/dsh-client-ui-workspace/lib/index.js` is only the plugin's
  node half; the browser halves are `lib/client.js` in both packages, and only the file-read tool can open
  them. The chain that was verified: `@deepseek-ai/dsh-client-ui-session/lib/client.js` lines 1120–1123
  provide the root hook `useSessions` over `ctx.sessions.list`; the catalog rows carry `displayTitle`/`title`
  and `retainedBy` (`@deepseek-ai/dsh-api-session-controller/lib/client.js` lines 4162–4182, `projectList`);
  and "the session the user is in" is the row whose `retainedBy.mainView > 0`, copied verbatim from the
  shipped root-scoped session browser (`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` line 3697, whose
  `useSessions((state) => state)` is on line 3669). Because that hook already holds the titles, the Host
  bridge reads no Sessions at all: the browser joins its own catalog against the index, and the picker shows
  real titles with a short-id fallback.
- **The one question the Host does answer is which stored session to open, and it is answered in one place.**
  `buildSessionsIndex` returns `selectedLeadSessionId`: a named `currentSessionId` always wins, even when
  that session has no roster (the panel must be able to say so rather than silently showing another team),
  and otherwise the documented order applies — live Leads first, then the newest write, then the id. That
  ordering is also the fallback when the browser's session catalog is unavailable, and the code comment and
  ADR 0006 say so instead of implying the hook always exists.
- **What is verified and what is not, for this change.** `node --check index.js actions.js routes.js
  client.js roster.js trash.js host-hooks.js` exits clean; `node --test --test-isolation=none
  tests/*.test.mjs` is 41 tests, 41 passing; `node scripts/check.mjs` passes. Not verified, because the
  bundle still has not been reinstalled: activation, the composed client bundle, the rendered page, and one
  runtime fact the code depends on — whether `retainedBy.mainView` is still non-zero while the Settings
  panel is open. The shipped browser suppresses its own "current" highlight when a sidebar panel is active
  (`dsh-client-ui-workspace/lib/client.js` line 3615), so the retained count may or may not survive; if it
  does not, the panel falls back to the Host's order. P3-04 carries the live check and the P3 gate stays
  open.

## 2026-11-11 — the UI is removed; every subagent becomes controllable

- **Two previously merged UI pull requests were removed, and the removal is the owner's call, not a
  repair.** Pull request 8 (the Settings panel over a loopback bridge) and pull request 9 (scoping it to
  one Lead Session) are gone from `main`: `client.js`, `routes.js` and `tests/routes.test.mjs` are
  deleted, `webServer` is no longer injected, and `package.json` loses `exports["./client"]`, the
  `dsh.client` block and the published client files at version `0.4.0`. The panel had never been
  rendered in a real profile, and the owner reported that its clicks did not work in real use. The
  decision recorded in ADR 0008 is to stop building UI and put the effort into the model-facing
  surface; ADRs 0005 and 0006 are marked superseded, with their bodies untouched.
- **What survives is what was backend.** `actions.js` keeps the operation bodies — they are not
  re-inlined, and the removed route was only a second caller. `host-hooks.js` keeps the projection
  filter and the slot credit, because they exist to make a retirement visible in the shipped pickers and
  to buy back a budget slot, not to serve a page. The per-Lead-session roster storage model (ADR 0003)
  is unchanged; only the per-Lead-session *bridge* design died with the bridge.
- **Adoption now covers every descendant of the calling agent, and the API was re-read from the
  installed asar first.** The relevant package is `@deepseek-ai/dsh-subagent` `0.2.2-rc.1`. Its service
  exposes `listChildren(parentSessionId, signal)` (`lib/index.js` lines 3162–3164) and
  `listDescendants(rootSessionId, signal)` (lines 3181–3183, implementation lines 2380–2446); adoption
  uses the latter. Child rows are `{ id, mode, label?, kind: 'child', parentId, depth, activity,
  hasChildren }` (constructed at lines 2429–2437 from the catalog rows defined at 709–770 and 780–791);
  `kind: 'diagnostic'` rows are skipped. A child with a label is named from it through the same
  normalization a shipped name goes through, an unlabeled child becomes `subagent-<id>`, and the child
  Session id stays the identity. Adoption is deduplicated in one pass, because the shipped roster and the
  catalog report the same child when the shipped team created it; it is idempotent across reads, because
  the retired record stays in the roster. Every `list_members` row now carries `child_id`.
- **Two small decisions were made rather than inherited.** An adopted one-shot subagent keeps both its
  tombstone and its trash move: the tombstone is the only thing preventing the next read from
  re-adopting a child whose row survives in the parent's durable catalog, and moving the artifact to the
  trash relocates an artifact that would otherwise stay in the live sessions store. `message_member` does
  not accept a raw `childId`: the target is already unique among addressable members, and a second
  selector would have to be honoured by every tool that takes one. The row's `child_id` reports the
  identity the host's own listings show.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` passes, with new fakes covering an
  unknown descendant adopted once and only once, a shipped-roster member still adopted, a child reported
  by both sources adopted once, a tombstone blocking re-adoption, a diagnostic row ignored, and the
  child id on every row; `node scripts/check.mjs` passes. A search over the repository finds no live
  reference to the deleted modules, the client slot, or `webServer` outside archived ADR bodies and this
  file. Not verified: activation of the Host-only bundle and the live behaviour of the widened adoption,
  because the bundle was not reinstalled — that remains the owner's decision.
- **A discrepancy in the change brief, stated rather than patched over.** The brief named an ADR 0007
  and two panel-store modules (`panel-store.js`, `client.panel-store.js`) that do not exist in this
  repository at `dc385bd`. There is nothing to supersede or delete beyond 0005 and 0006; ADR 0008 says so.
- **Three tools were dead on arrival, and the unit tests could not see it.** `retire_member`,
  `restore_member` and `stop_member` declared `execute(args)` while their bodies read `exec.agent`, so each
  threw `exec is not defined` the first time a model called it. Found by calling `retire_member` live on an
  adopted subagent; `list_members` worked, which is why the gap was not obvious. The cause is the shape of
  the earlier refactor: extracting the operation bodies into `actions.js` gave the tests a layer to call
  directly, so the tool wrappers stopped being covered even as coverage numbers rose. Fixed all three, and
  `scripts/check.mjs` now fails any `execute(` signature that does not declare `exec` — verified by
  breaking a signature on purpose (exit 1, named the offending `(args)`) and restoring it (exit 0).
