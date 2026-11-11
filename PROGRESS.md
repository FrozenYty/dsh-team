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

## 2026-11-11 — replacement hands over the record, and the successor starts first

- **P2-05 is delivered without a new tool name, and that was the first decision.** A `replace_member`
  tool would have duplicated `spawn_member`'s parameters and start path and given the model a third name
  for one operation. Instead `spawn_member` gained `replace` and `assignment`, and `message_member`
  gained `assignment` (the moment the Lead tells a member what to do is the moment that record changes).
  `PLAN.md`'s P2-05 line was reworded to match; P2-08 still carries the live end-to-end check because it
  needs real model calls and the bundle has not been reinstalled.
- **The ordering is spawn-then-retire, and the reason is which half is recoverable.** The obvious order —
  retire, then spawn — loses the predecessor into the trash when the start fails, with its work briefed
  to nobody. Starting the successor first means a failed start changes nothing (the predecessor is
  untouched and still live, and the failed reservation is recorded as the successor's `failed` record,
  named by the thrown error), and a failed retirement returns the successor with
  `predecessor_retired: false` and the reason, so one more `retire_member` call recovers it. Neither half
  reports success on its own. The order, the rejected alternatives and the assignment design are ADR
  0009.
- **The brief is composed from the record and points at the board.** The successor's prompt is five
  short lines: its own name, the predecessor's target and label, the recorded assignment, the fact that
  the predecessor is gone and cannot be messaged, and a pointer to the shared team task board under the
  predecessor's name — the board is not copied, and the plugin still does not own one. A successor
  inherits the predecessor's assignment unless the model records a different one, so repeated
  replacement does not thin the handoff out one generation at a time. An already-retired target is
  accepted and its tombstone supplies the brief, which is the `retired` row of the state matrix.
- **The assignment is a durable, capped field, and the cap is enforced at both ends.** `checkAssignment`
  rejects anything over 1000 characters rather than truncating it, the model-facing parameters carry
  `maxLength: 1000`, and the domain's record validator refuses an over-long assignment on decode, so an
  old store cannot grow without limit. It rides on the member record, is reported on every
  `list_members` row, and stays on the tombstone after retirement. No migration: the field is optional
  and existing records simply do not have one.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` is 40 tests, 40 passing — the 31 that
  existed plus nine in `tests/handoff.test.mjs` covering the cap and record validation, the stored and
  replaced assignment, the brief's content and its short shape, the one-call replacement (successor at
  generation 2, predecessor tombstoned, assignment inherited, brief actually handed to
  `startActivation`), the generation rule with and without an explicit name, both half-failures, and
  replacement from a tombstone; `node scripts/check.mjs` passes.
- **What stays unverified, stated plainly.** The bundle was not reinstalled, so no live call has run:
  the widened tool schemas activating, a real successor reading its brief, and the partial-failure paths
  are covered only by fakes. One runtime fact is deliberately not assumed — whether a spawned teammate
  can see the shipped team task board tools — which is why the brief says to ask the Lead for the task
  ids if the board cannot be read. P2-08 is the live end-to-end check.

- **P2-08 passed live, on the first attempt, and it is the whole point of the replacement work.** With
  `0.5.0` installed, a member was spawned carrying the assignment "Compute 6 * 7 and reply with the single
  number, nothing else" and a prompt that told it to stand by. One `spawn_member {replace: "handoff-probe"}`
  call then returned `handoff-probe-g2`, `generation: 2`, `assignment` inherited, `replaced: "handoff-probe"`,
  `predecessor_retired: true`. The predecessor was drained without ever answering; the successor, which
  never saw it, read the handoff brief and replied `42`. A successor completing a predecessor's task is
  therefore verified against a real model, not a fake.
- **The replacement install was blocked for two attempts by a different plugin.** `remove_bundle` reported
  `application: failed` with `memory-notebook: JsonSchemaError: unsupported JSON schema … type arrays are
  not supported`, which is another project's working tree, not this one. The reload was retried once that
  tree changed and both operations then applied. Recorded here because the diagnostic named a foreign
  package while this repository's own install was the operation that failed.

## 2026-11-11 — correctness audit fixes, v0.6.0

- **The Lead authority check no longer disables the plugin behind a misleading message.** The shipped
  Team service answers `undefined` from `tryMembership` both for a subagent it does not own and when its
  own projection cannot be read, and this plugin treated both as "not the Lead". A Lead whose Team log is
  in the documented permanent-failure state therefore got no tools installed, and `requireLead` refused
  every call — including the retirement that exists to repair that team. `requireLead` and `maybeInstall`
  now fall back to the same root test the shipped roster itself uses for a Lead: a live agent whose
  Session names no parent. `ensureAdopted` also reads the shipped roster best-effort, the way it already
  read the subagent registry, so a broken projection degrades to "nothing new to adopt" instead of failing
  the roster tools.
- **Nested suppression of the shipped slot credit no longer loses the outer credit.** `live.current` is
  one process-wide field and the effective `maxMembers` is read later, inside `roster.spawn`'s transact;
  the inner `finally` reset it to `0`, so a spawn caught by another spawn (or interleaved with one) lost
  the outer Lead's credit and was refused at the old limit. It restores the previous value now.
- **Every roster mutation goes through the storage table's own serialized `update`, and the comment that
  claimed it does is no longer false.** `updateRoster` seeded an absent key with `put` and then applied the
  mutation to the record as it is when the write reaches the chain, instead of rewriting the snapshot
  taken before the caller's last `await`. `ensureAdopted` adopted candidates against the current record,
  the spawn's reservation and activation writes merge by member id, and a tombstone committed while a
  discovery read or a start was suspended survives. A `provisioning` reservation whose child never
  published is reconciled to `failed` on read; one that did publish becomes `active`; a retirement
  committed during a spawn keeps the tombstone and drains the child when it publishes.
- **Retirement writes the tombstone before it moves the artifact.** The record carries the intended trash
  path and `trashState: 'pending'`; the move follows; a confirming write records `trashState: 'done'` or
  drops the path and records `archived`. The code says what a crash at each of the three points leaves
  behind. A `pending` tombstone whose artifact never reached the trash is reactivated by `restore_member`
  (`reason: 'never-moved'`) instead of being refused forever. `archived` is true only when the
  workspace-archive fallback ran, so a tombstone never carries both a `trashPath` and `archived: true`;
  `restore_member` names the branch that actually ran and no longer calls `unarchiveSession` for a
  retirement that archived nothing.
- **The lifecycle lookups are the matrix the documents describe.** `retire_member` and `restore_member`
  look a target up in any phase: a repeat retire answers `{retired: true, drained: false, reason:
  'already-retired'}`, a repeat restore answers `{restored: true, reason: 'already-active'}`, a failed
  member is still retirable, and a genuinely unknown target still refuses. `message_member` and
  `stop_member` narrow to the addressable set (`provisioning | active`) and answer a typed refusal —
  `reason: 'retired' | 'failed' | 'missing'` — so a tombstone can no longer return the same text as a
  target that never existed. The `retire_member`/`restore_member`/`message_member`/`stop_member` result
  schemas carry `reason`; the unused `unknown` member of the `status` enum is gone.
- **A duplicate target is refused when the record loads**, because every lookup takes the first match.
  `usage_ratio` is attached only when it is finite, so a `NaN` ratio can no longer make an entire
  `list_members` call fail as non-lossless JSON after the work is done. `spawn_member` and
  `message_member` refuse a `label`, `prompt`, `name` or `message` that is empty after trimming, which
  the registry never checked because this bundle registers raw tool definitions (ADR 0002).
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` is 65 tests, 65 passing — the 40 that
  existed plus 25 covering each fix, including a `tests/entry.test.mjs` harness that calls the registered
  tool wrappers through `apply` (the layer the other suites never entered); `node scripts/check.mjs`
  passes. The two files this change does not own (`README.md`, `docs/**`) were left to the document lane;
  the behaviours changed are listed in the pull request for reconciliation.
- **What stays unverified.** The bundle was not installed, so no live call has run in this change: the
  `update`-serialized mutations, the tombstone-first ordering and the typed refusals are covered by fakes
  that model the storage facility's write chain, not by a real profile.

- **The 0.6.0 correctness fixes were verified live, not only by their tests.** Installed from `main` and
  driven through the tools: `retire_member` reported `retired/drained/trashed` with a `trash_path`; a
  second `retire_member` answered the typed no-op `{retired: true, drained: false, reason:
  "already-retired"}`; `message_member` on the tombstone answered `{sent: false, reason: "retired"}`;
  `restore_member` answered `reason: "moved-back"` with the path, and a second call `reason:
  "already-active"`; a tombstone with no trash path answered `reason: "unarchived"`, naming the branch it
  actually ran, with the Session present on disk and no residue in the trash — the false-success class
  that bit this plugin twice is not reproducible now. `spawn_member` with a blank label refused before
  creating anything.
- **The replacement flow was re-verified after the refactor, because a 363-line rewrite of `actions.js`
  is exactly where a working feature goes quiet.** A fresh member took the assignment "Reply with the
  digit 7 and nothing else" and was told to stand by; one `spawn_member {replace: …}` call started its
  successor, which inherited the assignment, and replied `7`. That is P2-08 repeated on the refactored
  code, not on the code that first passed it.
- **ADR 0003's decision never matched the code, and that is now closed by ADR 0010 rather than by editing
  history.** 0003 read "one record per member, plus a per-Lead index"; the shipped code keeps one record
  per Lead with members inline. ADR 0010 supersedes the layout paragraph, records why the per-member
  layout was not adopted (a retirement must be one consistent document, and the migration is the risk),
  and writes down the fact nobody had written: nothing is ever deleted. Retention of the trash directory
  and of tombstones is now a stated deferral with an owner (P4-03) instead of an accident.
- **The label gained a write-time cap** (`LABEL_MAX`, 200, matching the shipped roster's description
  cap) because the record is a single document rewritten in full on every mutation. Load-time validation
  deliberately does not enforce it: refusing to load a roster over a display field would brick the plugin.
  Unit-tested; not exercised by a live tool call, because the cap only fires above 200 characters.

## 2026-11-11 — the trash is capped, and a pruned member says so (v0.7.0)

- **P4-03 is delivered as a fixed per-Lead cap, not a setting.** `TRASH_LIMIT = 20` in `trash.js` is a
  constant with the reason written beside it: the shipped Agent Teams roster bounds its members with the
  `maxMembers` constant rather than a config key, so this safety cap mirrors that and changing it means
  editing one line. There is deliberately no `DSH_TEAM_ROSTER_TRASH_LIMIT` and no `0 = unlimited`
  sentinel: the owner asked for a cap, not a knob. The unit is one Lead's trash directory, which is both
  the thing an operator reasons about and the only directory the code can enumerate without crossing a
  boundary.
- **The platform will not delete these bytes for us, and that is the decision the design answers.**
  Read from the installed Harness rather than assumed: `dsh-session-persistence` names only `create`,
  `open`, `flush`, `stat` and `list`, its JSONL backend implements exactly those
  (`lib/index.js`), and its README states *"Nothing deletes session files — logs accumulate under `root`
  until removed externally; the seam has no deletion API."* `sessionController` has no delete either,
  and the only official "take it out of the way" mechanism is the reversible
  `workspaceRegistry.archiveSession`. A cap that does not delete its own trash copies would therefore
  bound nothing — which is why ADR 0011 records "delete nothing, mirror the official archive" as a
  rejected alternative rather than the design.
- **Enforcement is one place, and only when the trash actually grew.** A retirement that moved an
  artifact in prunes in the same call, after the confirming write; a retirement that moved nothing prunes
  nothing, and there is no timer and no read-time sweep. Oldest first, by the millisecond stamp in the
  `<memberId>-<ms>` directory name. A candidate must be a direct child of that one Lead's trash directory,
  carry a plausible member id and a numeric stamp, and be named by a roster record's `trashPath`; a
  foreign name, a plain file, an entry with no tombstone and a `pending` move are all left alone — the
  pending entry still counts against the cap so the total stays bounded, but its bytes are never touched
  because `pending` means the move may or may not have landed.
- **The tombstone stays truthful instead of being deleted with the artifact.** ADR 0011's rejected
  alternative is the interesting one: dropping the tombstone would re-adopt the member as a live ghost,
  because draining a child does not remove its row from the parent's durable `subagentCatalog`. So a
  pruned tombstone keeps `trashPath`, `trashKind` and `originalPath` and its `trashState` becomes
  `pruned`; `TRASH_STATE` now enumerates `pending | done | none | pruned` and the record validator refuses
  an unknown value on load. `restore_member` checks `pruned` before the trash-path branch and answers
  `restored: false, reason: 'pruned'` without ever calling `workspace.unarchiveSession` — the false
  success this operation has already been repaired for twice. The retirement result carries `pruned` (0
  when nothing was removed) and, above 0, a message naming the count and the cap.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` is 75 tests, 75 passing — the 66 that
  existed plus nine in `tests/retention.test.mjs` covering the name parser, the fixed cap leaving a
  smaller trash alone, oldest-first removal down to the cap, a `pending` entry surviving as the oldest
  entry, foreign names and unaccounted entries surviving, idempotence, a real retirement pruning the
  oldest tombstone while keeping its path, the `pruned` restore refusal with the workspace call counted
  at zero, and the new enum being accepted while an unknown value is refused. `node scripts/check.mjs`
  passes.
- **What stays unverified.** The bundle was not installed, so the cap has not fired against real Session
  artifacts: the suite builds its trash entries by hand, and the live check — point an install at a low
  cap and retire past it — remains the owner's decision. Also unverified live: the `pruned` tool-result
  field reaching a model, since the unit tests call `actions.js` directly and the registry's schema
  validation only runs on a real call.
- **A pre-existing duplicate task ID, reported rather than renamed.** `PLAN.md` carries two `P4-03`
  entries: the retention task this change ticked (in the P2 section) and "File the missing lifecycle
  upstream with the evidence gathered here" (in P4). The retention task is the one the brief named, and
  renumbering the other is a plan edit nobody asked for, so it is left as it is.

- **The retention cap was verified live, and the first run of it did nothing.** Installed `0.7.0`, retired
  a member with the cap set low, and got `pruned: 0` where three deletions were expected. Cause: the
  candidacy rule required `trashState` to be `done` or `pending`, but `trashState` is a field this very
  release introduced — every tombstone written before it has a `trashPath` and no state, so the whole
  pre-existing trash was permanently exempt and the cap only ever governed records created after it. Fixed
  by reading a missing state as `done` (a record with a path completed its move), with a regression test
  that seeds state-less tombstones. The live re-run then reported `pruned: 3` with an explicit message,
  the directory held exactly the cap, `restore_member` on a pruned tombstone answered
  `{restored: false, reason: "pruned"}` and kept the record retired instead of calling the workspace, and
  restoring an unpruned one still answered `reason: "moved-back"` with the path. The constant was put back
  to 20 before merging; the temporary 7 was only the live probe.
- **The cap is a fixed constant, not a config key, because that is how the platform bounds things.**
  The owner asked to mirror the official mechanism, and the shipped Agent Teams roster bounds members with
  a fixed `maxMembers`. ADR 0011 also records what the investigation found: the Harness exposes no
  Session-deletion API at all — `sessionPersistence` offers `create/open/flush/stat/list`, and
  `sessionController`, `sessionQuery` and `sessions` have no delete — so the only official way to take a
  Session out of the way is the reversible `archiveSession` flag. The cap therefore deletes this plugin's
  own trash copies, and says so.

## 2026-11-11 — the trash cap is a config field, not a constant (v0.8.0)

- **The owner overruled the fixed-constant decision, and the platform is on their side.** ADR 0011 chose a
  constant by mirroring what it believed the official mechanism was. The live Host Config provider shows
  the opposite: the official Agent Teams row (`include:agent-team`,
  `@deepseek-ai/dsh-experimental-agent-team`) declares `maxMembers {default 16, minimum 1}`,
  `maxTasks {default 256}`, `maxMessageBytes {default 65536}` and `disposalTimeoutMs {default 5000}` as
  Config fields with a default and a minimum, while this bundle's own row (`include:team-roster`,
  `patchId: team-roster`) reports `status: "absent"`. ADR 0012 supersedes point 1 of ADR 0011; 0011 keeps
  its body and gains a header line and a note above that point.
- **The cap is now `trashLimit`, read by `apply(ctx, config)` before anything else.** `resolveTrashLimit`
  (`trash.js`) returns the documented `DEFAULT_TRASH_LIMIT` (20) for an absent field, accepts an integer of
  at least 1, and refuses anything else — `0`, `-1`, `1.5`, `'20'`, `NaN` and an explicitly-null value —
  with a message naming the field, the value it saw and the minimum. The resolution happens before any
  registration, so a bad patch value fails the load rather than the first retirement. The resolved number
  is passed to `install`, `retireMember` and `spawnMember`, so `pruneLeadTrash` runs at the effective cap
  and the retirement message prints it; `TRASH_LIMIT` is renamed `DEFAULT_TRASH_LIMIT` because it is no
  longer the authority.
- **Verified answer: a zero-import bundle cannot declare a Config *schema*, and the reason is two
  consumers, not one.** `@deepseek-ai/cordis/lib/index.js:1703` stores the export (`Config: plugin.Config`)
  and lines 244–250 validate with `runtime.Config["~standard"].validate(config)`, so a plain object with
  `type`/`properties`/`default` throws `TypeError: Cannot read properties of undefined (reading
  'validate')` at activation — a loud failure, and still a failure. A hand-written Standard Schema would
  satisfy Cordis, but the Config inspect provider reports `status: "schema"` only for a native Schemastery
  graph: `@deepseek-ai/dsh-tool-cordis/lib/types/config.js:12-17` plus
  `@deepseek-ai/dsh-app-boot/lib/index.js:3197-3201`, which requires `Symbol.for("schemastery") === true`,
  a string `type` and an object `meta`. The profile schema generator is stricter still:
  `dsh-app-boot/lib/index.js:4152-4155` records an error diagnostic, *"Config is not a native Schemastery
  schema"*, for any Config that is present and not native, and line 3963 marks such a document
  `complete: false`. So no `Config` is declared, the entry keeps reporting `absent` on purpose, and the
  validation lives in `apply`. The raw patch config still reaches `apply` unchanged: the loader passes it
  to the plugin callback (`@deepseek-ai/cordis-plugin-loader/lib/index.js:588-591`), and cordis returns it
  untouched when `runtime.Config` is absent.
- **The edit surface is the profile's `cordis.patch.yml`, by patch id.** `- id: team-roster` with
  `config: { trashLimit: 7 }`; `@deepseek-ai/dsh-app-boot/lib/index.js:505-553` matches a non-insert patch
  by `id` and replaces the supplied fields wholesale, so `config` is replaced rather than merged. The
  README pair documents exactly that snippet, with the default, the minimum and the load-time refusal.
- **How this was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js` exits
  clean; `node --test --test-isolation=none tests/*.test.mjs` is 79 tests, 79 passing — the 76 that existed
  plus the default and per-value refusal cases for `resolveTrashLimit`, a retirement that runs at
  `trashLimit: 2` and prints "at most 2", and an entry-harness case that drives `apply` with each rejected
  value and asserts that nothing was registered; `node scripts/check.mjs` passes.
- **What stays unverified.** The bundle was not installed, so no live call has run in this change: the
  entry's activation with a real patch row, the refusal surfacing in the Host log, and the effective cap
  reaching a real retirement are covered by fakes and by the loader/cordis source, not by a running
  profile. The Config provider will keep reporting `absent` for this entry — that is the recorded decision
  (ADR 0012), not a regression.

- **The configurable cap was verified live, in both directions, without touching the owner's profile.** The
  probe used this bundle's own patch row, which is the same mechanism a profile override reaches:
  - `config: { trashLimit: 5 }` installed and applied, then a retirement reported `pruned: 2` and the
    message read "it keeps at most **5**" — the configured number in force, not the default 20, and the
    trash directory then held exactly 5 entries on disk.
  - `config: { trashLimit: 0 }` refused at load with `application: failed` and
    `config field "trashLimit" must be an integer >= 1 (minimum 1); received 0`, naming the field, the rule
    and the value. That is the official schema's `minimum: 1` behaviour — refused, never silently clamped.
  - The patch row was put back to `config: {}` before this was recorded, so a config-less profile keeps the
    documented default; the temporary 5 and 0 were only the probe.
- **A zero-import bundle cannot declare a Config, and that is a finding rather than an omission.** Cordis
  validates a plugin's `Config` through `runtime.Config["~standard"].validate` (installed
  `@deepseek-ai/cordis/lib/index.js:244-250`, stored at `:1703`), so a plain JSON-Schema-shaped object
  throws at activation. A hand-written Standard Schema would satisfy Cordis, but the Config provider reports
  `"schema"` only for a native Schemastery graph (`dsh-tool-cordis/lib/types/config.js:12-17`,
  `dsh-app-boot/lib/index.js:3197-3201`) and records an error diagnostic for anything else
  (`:4152-4155`). The entry therefore stays `absent` on purpose and the value is validated in `apply`,
  with the raw patch config reaching it unchanged (loader `lib/index.js:588-591`). ADR 0012 records this,
  so the next person does not read `absent` as "unfinished".
