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

## 2026-11-11 — ephemeral members retire themselves on a lazy sweep (v0.9.0)

- **P4-01 is delivered as a property plus a lazy sweep, not a new phase and not a hook.** A member
  spawned with `ephemeral: true` carries the flag on its record and a `startedAt` when its child starts;
  every `list_members` row reports the flag, and a sweep at the start of `list_members` and
  `spawn_member` retires it once it has run and stopped. No timer, no background task, no model call, and
  no `dormant` phase: a member stays `active` until the sweep retires it through the existing
  `retireMember` protocol (drain, tombstone-first, move, retention cap, host effects). ADR 0013 records
  the design.
- **The completion signal was read out of the installed asar, and the obvious value does not work.** In
  `dsh-subagent` `0.2.2-rc.1`, `lib/index.js:2435` builds every descendant row's `activity` as
  `sessions.get(entry.id) === void 0 ? "inactive" : "running"` — exactly two values. `inactive` means
  "not resident", which is also the state of a freshly reserved child that has never run, so it cannot
  prove completion; only `running` is trustworthy positive evidence. The sweep therefore requires the
  plugin's own `startedAt` — written when the activation resolved, so a reservation that never published
  has none — plus the local live registry (`liveStateOf` → `ctx.agents.get`) reporting the member not
  resident. A member that never ran and one still running are never swept. The row schema and the
  traversal are at lines 709–791 and 2380–2446 of the same file.
- **`message_member` clears the flag, and the sweep reports itself.** Messaging an ephemeral member again
  is a declaration that it is not one-shot, so the accepted message deletes `ephemeral` in the same
  record write and the result answers `ephemeral: false`; this is the one case where a later sweep would
  otherwise eat work the model meant to keep. A triggering operation whose sweep retired anything adds
  `swept` and `swept_targets`; when it retired nothing, the result is exactly what it was before this
  release, which is why the 79 earlier tests did not change.
- **The record gains two optional fields and nothing else.** `ephemeral` and `startedAt` are written only
  on ephemeral members and both are validated on load, so every record a previous release wrote loads and
  behaves as before. `list_members` rows carry `ephemeral: true` for those members, and the tool
  descriptions say which calls sweep, that `spawn_member` is the other trigger, and that a message clears
  the flag.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` is 86 tests, 86 passing — the 79 that
  existed plus seven in `tests/ephemeral.test.mjs` covering a swept member going through the normal
  retirement path (drained, tombstoned, `retireReason`), a member that never ran (a provisioning
  reservation and an active record with no `startedAt`) never being swept, a running member never being
  swept, the message-clears-the-flag rule, a profile with no ephemeral member returning the old shape,
  idempotence with `spawn_member` as the second trigger and the count in its result, and load-time
  validation of the two new fields; `node scripts/check.mjs` passes.
- **What stays unverified.** The bundle was not installed, so no live call has run: the tools' new
  parameter activating, the sweep seeing a real child go from resident to unloaded, and the reporting
  fields reaching a model are covered by fakes and by the asar source, not by a running profile. The
  live end-to-end check — spawn two ephemeral members, let them finish, call `list_members` and see them
  leave and the slots come back — remains the owner's install decision.

## 2026-11-11 — the plugin is renamed dsh-team (v0.10.0)

- **The package, the patch row's `name` and the display title are `dsh-team`, `Team` and
  `团队`.** The old name described the state — a roster — while what the plugin delivers is the move:
  retire, replace, take back. The version is `0.10.0`, not a patch bump, because a rename is a new
  identity for a package that a profile links: the lockfile and a reader both need to see it. The locale
  descriptions did not change (`Retire it, replace it, take it back.` /
  `该退就退，该换就换，还能找回来。`), because the behaviour did not.
- **Decision recorded in ADR 0014: the identity moves, four names do not.** The storage domain
  `team_roster` (`roster.js`, `ROSTER_SPEC`), the patch row id `team-roster` (`cordis.patch.yml`), the
  data directory `~/.dsh/team-roster` and the environment variable `DSH_TEAM_ROSTER_DATA_DIR` keep their
  pre-rename spelling. The two contracts the task froze are the domain and the row id, and the other two
  follow the same rule for the same reason: a new domain name is an empty domain, so a running profile
  would see no members and `restore_member` would lose every tombstone it depends on; a renamed row id
  stops matching a profile's `- id: team-roster` override, so the cap would silently fall back to the
  default; and every tombstone records an absolute `trashPath` under `~/.dsh/team-roster` while
  `pruneLeadTrash` lists that same root, so renaming it would leave the recorded paths outside the scanned
  root. `DSH_TEAM_DATA_DIR` is now the documented override and wins when both variables are set;
  `DSH_TEAM_ROSTER_DATA_DIR` still works. Each of the four carries the note where it is declared, and the
  ADR carries the table so a later reader does not finish the rename by accident.
- **The entry's error prefix followed the package name, and the include string with it.**
  `resolveTrashLimit` now refuses with `dsh-team: config field "trashLimit" must be an integer >= 1
  (minimum 1); received 0`, and the provider should report `include:dsh-team` with
  `patchId: team-roster` — the row id does not change, the entry name does. ADR 0012 keeps quoting the old
  prefix in its body; ADR 0014 §4 lists that and the other places where `dsh-team-roster` is now a
  historical record rather than a current name.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` is 87 tests, 87 passing — the 86 that
  existed plus one that pins both data-directory variables and the precedence between them;
  `node scripts/check.mjs` passes, which includes the pin between `package.json`'s name and the inserted
  patch row; and a repository-wide sweep for `dsh-team-roster` returns only the justified leftovers
  (append-only `PROGRESS.md` entries, accepted ADR bodies, the v0.3 domain-migration note, the frozen
  directory and variable names, and the historical repository URL).
- **What stays unverified.** The bundle was not installed and no `plugin_manager` call was made, so the
  activation with the new `name`, the provider reporting `include:dsh-team`, and a profile's
  existing `- id: team-roster` override still matching are argued from the loader and the patch shape, not
  observed in a running profile. The live check is the owner's install decision.

## 2026-11-11 — the handoff brief's shape is a stored template per Lead (v0.11.0)

- **P4-02 is one Lead-scoped tool, `handoff_template`, and one optional record field.** Omitting
  `template` reads the stored template back, a template string validates and stores it, and an empty
  string clears it and returns that Lead to the built-in brief. The value lives on the Lead's roster
  record as `handoffTemplate`, so it is per-Lead by construction: two Leads cannot share one, and
  `list_members` rows are unchanged because the template is a Lead preference, not a member fact. The
  name is noun-only instead of the usual `verb_noun`: the call reads, writes or clears depending on its
  argument, so `set_` and `get_` would each name one third of it. ADR 0015 records the surface.
- **The built-in brief is the default template, not a second code path.** `handoffPrompt` renders
  `{successor}`, `{predecessor}`, `{label}`, `{assignment}` and `{task_board}` from the predecessor's
  record, and the built-in shape is written in the same vocabulary, so one renderer serves both. A test
  pins the exact five-line string for a recorded assignment and for the "not recorded" fallback, which is
  what makes "a profile that stores no template is byte-identical" checkable rather than asserted.
  Clearing the field returns to it; the successor's own task is appended after the rendered template and
  is never a placeholder, so no template can drop the task it was started for.
- **Both refusals happen before a child exists.** An unknown placeholder is refused at set time with the
  token named (`{asignment}` never reaches a prompt as literal text), and a template that does not
  reference `{assignment}` is refused with the reason: a brief without it tells a successor its
  predecessor's role and where the work is, but not what the work was. The template is capped at 1000
  characters and the rendered brief at 2000 — refused, never truncated — and the rendered cap is measured
  only when a template is stored. `spawnMember` composes the brief before it writes the reservation, so a
  rendered-cap refusal leaves the predecessor active and writes no failed record.
- **The record is validated differently on purpose.** `parseRoster` checks only that a stored
  `handoffTemplate` is a string. The storage facility validates every record of every Lead when it opens
  a domain, so refusing the whole domain over one Lead's brief preference would hide every roster; the
  content rules are enforced on write and re-reported by the read (`valid`, `problem`), and a stored
  value that no longer passes is kept and reported while the composition falls back to the built-in
  brief. ADR 0015 records that exception and its reason.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` is 97 tests, 97 passing — the 87 that
  existed plus ten in `tests/handoff.test.mjs` covering the byte-identical built-in brief, read-back of a
  stored template, interpolation with the real values, the two set-time refusals, the template cap and the
  rendered cap (the latter before any child starts), two Leads not sharing a template, clearing returning
  to the built-in, and load-time type validation of the field; `node scripts/check.mjs` passes.
- **What stays unverified.** The bundle was not installed, so no live call has run: the tool's activation,
  the read/set/clear argument handling through `index.js`, and the rendered brief reaching a real child
  are covered by fakes and the unit tests, not by a running profile. The live check — store a template,
  replace a member, read the child's first prompt — remains the owner's install decision.
- **The README pair is the remaining documentation work in this release.** `README.md` and `README-zh.md`
  still list seven tools and do not describe how to fix the brief shape; they belong to another lane in
  this change, so the tool row and the short "how to fix the brief shape" note are recorded here instead
  of being silently assumed.

## 2026-11-12 — spawn capabilities, typed start refusals, and a refusal that names the current holder (v0.12.0)

- **The three fields the installed seam already accepted are now reachable from `spawn_member`.** The
  installed `dsh-subagent` 0.2.2-rc.1 activation request already took `cwd`, `agentOptions` and
  `agentPreset`; the plugin sent only `{ prompt, parent }`, so every member silently inherited the Lead's
  working directory, model route and tool set. One nested `spawn_options` parameter now forwards them,
  and omission of the object or of any field means inherit: a spawn that passes none composes exactly
  the request it composed before, pinned by a test that asserts the exact object. ADR 0016 records the
  surface decision.
- **Nested rather than six flat parameters.** `spawn_member` already carries six roster parameters, and
  these three are not roster concepts — the plugin interprets none of their values. One pass-through
  object makes "the caller supplied none" one structural test instead of six undefined checks, and keeps
  a spawn that does not use the feature invisible in both the request and the result. Inside it the
  fields are `cwd`, `agent_options` (`provider`, `model`, `reasoning_effort`, `max_tokens`) and
  `agent_preset`; `activationOptions` is the single place they map to the request's
  `cwd`/`agentOptions`/`agentPreset`.
- **`cwd` is forwarded as a path, not interpreted.** It is validated as a non-empty string and passed
  verbatim: the seam resolves a relative path against the Lead's cwd and keeps the Lead's permission
  roots, so a plugin that pre-resolved it would disagree with the Host.
- **The refusals are probed, not predicted.** The plugin starts the member and routes the seam's typed
  failure on `error.code`: `UNSUPPORTED_CAPABILITY` → `unsupported-capability`,
  `PRESET_UNAVAILABLE` → `preset-unavailable`, `agent-preset/not-found` → `preset-not-found` (the
  registry's `details.available` names the ids a profile does declare), `agent-preset/invalid` →
  `preset-invalid`, and `UNAUTHORIZED` → `unauthorized`. The probe corrected the brief: an unknown preset
  id is `agent-preset/not-found`; `PRESET_UNAVAILABLE` is the missing `agentPresets` service. Each
  refusal is a result (`started: false`, a `reason` and a sentence naming the way out), never a raw host
  error, and the reservation is already a visible `failed` record, so no member is left `provisioning`.
  On a `replace`, the refusal also answers `predecessor_retired: false` and says the predecessor is live.
- **The result reports what was applied.** `started_with` echoes only the supplied fields in the
  parameter's vocabulary; a plain spawn adds nothing, and a refused start adds nothing. It reports what
  the plugin forwarded rather than a read-back of the child's resolved options, because the seam exposes
  no supported read of them and its Session metadata copies the parent's cwd.
- **A refusal for a stale target now names the live holder of the name.** `retire_member`,
  `restore_member`, `message_member` and `stop_member` keep the refusal they already gave and add
  `current_holder: { target, generation }` plus a sentence pointing at it, whenever another generation of
  that base name is live. The holder is read from the stale record's `name` (not by stripping a `-g<N>`
  suffix, because a base name may legally end in `-g2`), and the highest live generation wins. Which
  refusals happen does not change, and a name with no live other generation keeps the old answer.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node --test --test-isolation=none tests/*.test.mjs` is 107 tests, 107 passing — the 97
  that existed plus ten: nine in `tests/spawn-capabilities.test.mjs` (the exact no-argument request, each
  field forwarded and reported, an option supplied alone, the typed refusals with no member left
  provisioning, a non-typed start failure still throwing, a refused successor leaving its predecessor
  live, the stale-target holder on message/stop/retire, holder absence while no other generation is live,
  and the restore refusals) and one in `tests/entry.test.mjs` pinning the wrapper's `spawn_options`
  validation and forwarding; `node scripts/check.mjs` passes. The README pair was measured before and
  after: 14 `##` headings on each side before and after, and the pair's distinct backtick identifiers
  stay equal to each other.
- **What stays unverified.** The bundle was not installed and no `plugin_manager` call was made, so a
  live activation with a forwarded `cwd`, `agentOptions` or `agentPreset`, the seam's actual refusal
  payloads in a real profile, and the typed result reaching a real model are covered by fakes and the
  unit tests, not by a running profile. The Lead's live check is one `spawn_member` with a preset and a
  model, then a second with neither.
## 2026-11-12 - v0.12.0 did not activate, and a check now refuses that keyword

- **The bundle installed and did not activate.** `plugin_manager install_bundle` for v0.12.0 answered
  `application: failed` with a host diagnostic: `JsonSchemaError: unsupported JSON schema:
  ...started_with.properties.agent_options.properties.max_tokens.minimum is not a supported keyword
  (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`. The
  cause was one word: `AGENT_OPTIONS_SCHEMA` is the same object in a parameter schema and in the
  `spawn_member` result schema, and the result side is validated against that narrow subset. A rejected
  keyword there does not break one tool; it stops the whole plugin from registering, so every roster
  tool was missing while the unit tests were green.
- **Why nothing local caught it, and what does now.** The unit tests call `actions.js` and never load the
  host, `node --check` is a parse, and `scripts/check.mjs` had no rule about schema keywords. It has one
  now: any of `minimum`, `maximum`, `minLength`, `pattern`, `format`, `minItems`, `default`, `allOf`,
  `$ref` and their neighbours in `index.js` fails the check and names the line. The rule was written
  first and proved against the broken tree - it failed with `index.js:143: "minimum" is not in the
  schema subset the host validates` - and only then was the keyword removed, so the check is known to
  catch the fault rather than to have been written around it. `maxLength` stays allowed: its three uses
  are parameter properties, which the host tolerates, and they carry a documented range to the model.
- **The constant now says why.** `AGENT_OPTIONS_SCHEMA` carries the subset in its JSDoc, with the
  instruction to express a range in the description instead, because the next person to add `minimum`
  would otherwise have no reason to suspect it.
- **Version.** The fix stays inside `0.12.0`: no profile ever activated that release, so there is no
  installed state to distinguish. `node scripts/check.mjs` passes, `node --check index.js` exits clean,
  and the suite is 107 tests, 107 passing.

## 2026-11-12 - v0.13.0: the plugin owns the work, not only the member (P2-09)

- **The gap was handover-shaped.** A member's work was one `assignment` string, so a retirement could hand
  over a *description* of the work and nothing else: a successor started with a sentence, and unfinished
  items existed only in prose. The shipped Agent Teams board could not be the source of truth, because it is
  the shipped roster's board and P2-07 exists to disable that tool row. P2-09 therefore built the board this
  plugin owns: a `tasks` array on the Lead's roster record, beside `handoffTemplate` (ADR 0017).
- **The shape is small on purpose:** `{ id, title, status, owner?, created_at, updated_at? }`, owner being a
  member **target**. No priorities, no dependencies, no comments, no sub-tasks, no due dates - each one is a
  field, a rule, a result shape and a test for a question the transfer does not ask. `PLAN.md`'s four tools
  became one (`task_board` with an `action` enum), read is `action: list`, and compare-and-set is the
  transition itself: `changed: false` with the current row when a write would change nothing. All three
  reductions are in the ADR's rejected alternatives with their reasoning.
- **The transfer is the feature, and its matrix was written before the code** (`docs/architecture-en.md`
  §4.3.2 and its Chinese pair): replace-and-retire moves the open tasks to the successor; replace on an
  already-retired predecessor moves them and adopts every other unowned row; a failed start moves nothing;
  a failed retirement behind a started successor finds the work already moved; retire with no successor
  un-owns the rows and reports their ids; a restore assigns nothing and reports what is still unowned; the
  ephemeral sweep un-owns through the same path and reports it; and a reused owner name inherits nothing,
  because the owner is a target and generation 2 is a different target. `done` work never moves, in any cell.
- **The handover is the replacement's first write after the start, before the tombstone.** A tombstone whose
  open work still names a member that is gone is the one state a reader must never see; the reverse order
  would produce it whenever the handover write failed. The cost is a partial lifecycle on a failed tombstone
  write - a live predecessor whose work already belongs to its successor - and one more `retire_member`
  finishes it, which is the recoverable half.
- **The brief carries the board, bounded.** The successor's prompt gains one line naming the predecessor's
  open tasks by id *and* title, capped at 5 rows and 600 characters; past either bound the line is dropped
  and the `{task_board}` pointer sentence remains, which is exactly the pre-P2-09 brief. A member with no
  tasks therefore gets a byte-identical brief, pinned by the existing test plus a new one.
- **Caps and load-time rules.** `TASK_TITLE_MAX` (200, matching `LABEL_MAX`) and `TASK_LIMIT` (200 per Lead,
  `done` included) are refusals, never truncation. `parseRoster` validates only the structure of `tasks` -
  array, object rows, non-empty id, known status, non-empty owner, no duplicate id - because the storage
  facility validates every record when the domain opens; a title that is merely too long, or a list past the
  cap, loads and is served by `list` with `problem` on the row. That is the `handoffTemplate` precedent
  (ADR 0015) applied where a whole roster would otherwise be hidden.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node scripts/check.mjs` passes; `node --test --test-isolation=none tests/*.test.mjs` is 129
  tests, 129 passing - the 107 that existed plus 22: 21 in `tests/task-board.test.mjs` (the row shape and id
  assignment, both cap refusals including the exact boundary, the read-form `problem` and structural load
  refusals, every cell of the transfer matrix, the lossless-JSON results, and the byte-identical no-task
  brief) and one in `tests/entry.test.mjs` (the `task_board` wrapper's validation and forwarding, which the
  actions-level tests cannot cover).
- **Two refusals were proved able to fail.** Breaking the transfer (`handOverTasks` recorded the ids and
  wrote no owner) failed six matrix tests, the first with
  `AssertionError: the open task is the successor's / actual: undefined / expected: 'reviewer-g2'`; making
  the per-Lead cap off by one (`>` instead of `>=`) failed the cap test with
  `Missing expected exception`. Both breaks were restored and the suite re-ran green; `tests/task-board.test.mjs`
  carries the same SHA-256 before and after (`741FAB6B...030A5`), so the proof did not edit the tests.
- **What stays unverified.** The bundle was not installed and no `plugin_manager` call was made. A live
  `task_board` call, a live replacement carrying `transferred`, a retirement carrying `unowned`, and the
  rendered brief reaching a real child are covered by fakes and unit tests, not a running profile. The
  Lead's check is: `task_board { action: "create", title: "…", owner: "<member>" }`, then
  `spawn_member { replace: "<member>", … }` and look for `transferred` and for the ids in the brief.
- **Version.** `0.13.0`, and this is the first release whose feature P2-07 was waiting for; P2-07's blocker
  is noted as cleared in `PLAN.md` and the row itself is still open.

## 2026-11-12 — the drift audit: what `started_with` is, and three claims that did not match the tree (v0.13.1)

- **A read-only audit of the documentation was run against the tree, and four findings were repaired.**
  Every finding was re-checked against the code and the tests before anything changed, and the one wording
  that was already true was left alone rather than "fixed" for consistency.
- **`started_with` was documented as what the child got; it reports what the plugin forwarded.** Five
  places said "applied" or "实际用了什么": the README pair, `docs/architecture-en.md` §4.5, its Chinese
  pair, and the model-facing `spawn_options` description. `startedWith()` (`actions.js`) copies only the
  fields the caller supplied and never reads the child's resolved options;
  `tests/spawn-capabilities.test.mjs` pins that a relative `cwd` is echoed unresolved; ADR 0016 §6 already
  said "forwards rather than reads back", and `README.md` already said "echoing exactly what was passed",
  so the README contradicted itself. All five now say the field is a receipt for what the plugin
  forwarded, not a confirmation of what the child resolved — a model id that is plausible but wrong is
  still accepted and echoed, and fails on the child's first request — and the rule that omission inherits
  is unchanged. The `index.js` change is description text only, which is why the version moves: v0.13.0 is
  installed and this changes what a model reads.
- **A false cross-reference inside an accepted ADR.** ADR 0014 §4 said ADRs 0004, 0005, 0006, 0010 and
  0011 "still name the trash path under `~/.dsh/team-roster`". `git grep -n "dsh/team-roster" -- docs/adr`
  returns 0004, 0010, 0011 and 0014 only: 0005 and 0006 cite the old HTTP route `/api/team-roster`
  (`0005:37`, `0006:28-29`). The sentence now names 0004, 0010 and 0011, and says what 0005 and 0006
  actually keep — the old route prefix. This corrects a factual claim inside the same sentence; the
  decision itself is untouched, because an accepted ADR is closed.
- **`AGENTS.md` carried the pre-claim framing.** §2 opened with what the shipped packages "lack" while
  the settled sentence — `只是换人，不是换活。` / `Only the person changes, not the work.` — lived only in
  the README pair and the locale files. An agent reads `AGENTS.md` first and it describes this same
  project, so its opening now states the claim in its own prose: permission to let a member go, a roster
  that shrinks as well as grows, retirement as a move into a trash the plugin controls.
- **`reasoning_effort` was missing from the field list, and so was the one exception to inheritance.**
  The README pair and `docs/architecture-en.md` §4.1 named the model settings as "a cheaper model,
  another provider or a token limit"; `reasoning_effort` appeared only in ADR 0016, `PROGRESS.md` and
  `index.js`. All four now name it (`provider`, `model`, `reasoning_effort`, `max_tokens`), and both
  languages state the exception where the inheritance rule is stated: a changed provider or model
  **without** `reasoning_effort` lets the new route resolve its own default instead of inheriting the
  Lead's effort (`index.js` `AGENT_OPTIONS_SCHEMA`, `:150` and `:462`).
- **How this change was verified.** `node scripts/check.mjs` passes after the last edit;
  `node --check index.js actions.js roster.js trash.js host-hooks.js` exits clean;
  `node --test --test-isolation=none tests/*.test.mjs` is 129 tests, 129 passing — no test was edited,
  because the change is documentation except for one description string. The README pair was measured
  rather than assumed: 14 `##` headings on each side and an equal, identical set of distinct backtick
  identifiers on each side (112 before the change, 116 after, both sides equal in each state). The ADR 0014
  sentence was re-checked against `git grep -n "dsh/team-roster" -- docs/adr` and matches it: 0004, 0010 and
  0011 carry the path; 0005 and 0006 carry only the old route prefix.
- **What stays unverified.** No install and no `plugin_manager` call was made: the bundle was not
  reinstalled, so the new `spawn_options` description has not been seen by a live model, and the
  `started_with` wording is a documentation claim about behaviour the unit tests already pin, not a new
  observation. The model-facing `started_with` field itself is unchanged.

## 2026-11-12 - v0.13.0 answered a replacement with a result the host refused

- **What happened.** The first live replacement on a member that owned an open task came back as a tool
  error: `tool "spawn_member" returned invalid output: "value.transferred" is not a declared property
  (additionalProperties: false)`. `MEMBER_ROW` did not declare `transferred`, `transferred_tasks`,
  `unowned` or `unowned_tasks`, while the operation returns them: `RETIRE_VALUE` declared the same two
  fields, and `spawn_member` answers with `MEMBER_ROW`. The host validates a result when the tool
  returns, so the rejection arrives after the side effect: the replacement had already moved the
  predecessor work and retired it (the board showed the task owned by the successor, and the
  successor received a brief naming its id and title), while the model was told the call failed. A
  lost result beside a completed side effect is worse than a refused call.
- **Why 130 unit tests missed it.** They call `actions.js` and never pass through a declared output
  schema; the schema is only exercised when the host validates the wrapper return, which needs a
  running profile. Same shape as the v0.12.0 `minimum` failure: code and declaration disagreed, and
  only the host compared them.
- **The fix has two halves.** The four fields are declared on `MEMBER_ROW`. And
  `tests/entry.test.mjs` now has `assertMatchesSchema` plus a test that drives real wrapper calls —
  spawn, task create, list, a replacement that moves the work, task status change, template read — and
  validates each answer against the schema its own tool declares, implementing the same subset
  `scripts/check.mjs` enforces. **The test was proved against the un-fixed schema**: with the fields
  restored it passes 8/8; with the fix stashed it fails with `spawn_member.transferred: not declared
  in the output schema`, which is the host message in local form.
- **Live verification of P2-09.** Before the schema fix, and after it, the transfer itself worked: a
  created task, assigned to a member, moved to its successor in one `spawn_member` with `replace`, and
  the successor quoted the brief it received, including `Open tasks it still owned:
  0ed88592-... "Confirm the relay curve for the successor"`. That is the feature, observed end to end.
- **Version.** `0.13.2`: `0.13.0` is installed and its `spawn_member` can still lose a replacement
  result, so this is not a documentation-only patch.

## 2026-11-12 — the shipped team tool row is retired, the gap is written down, and the Status block is measured (v0.14.0)

- **P2-07 is one patch entry.** `cordis.patch.yml` now overrides the shipped `tool-agent-team` row with
  `disabled: true`. The row's plugin — read from the installed build,
  `@deepseek-ai/dsh-experimental-tool-agent-team` 0.2.2-rc.1, `lib/index.js` — registers `spawn_teammate`,
  `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_create`, `team_task_list`,
  `team_task_get` and `team_task_update`; it also publishes the shipped team-policy section and the
  Lead-identity context, which is what the entry's comment is checked against. The comment states what goes
  and what it costs: every shipped tool has an equivalent here (`spawn_member`, `message_member`,
  `list_members`, `stop_member`, `task_board`) except `wait_agent`, which has none — a model re-reads
  `list_members` and wakes a member with `message_member` instead of blocking, and reads `inactive` as "no
  turn is executing"; the shipped board's existing rows are not readable here and are not migrated, so a
  Lead that wants them re-creates them on `task_board`; and the two system-prompt sections go with the row.
  The `agent-team` service row is deliberately untouched: adoption and the projection filter read it, and
  the plugin's own Lead check calls `ctx.agentTeams.tryMembership`.
- **The two existing patch entries survived.** `compaction-basic` is still `disabled: false` and the insert
  still names `dsh-team`; `scripts/check.mjs` passes. The check does not pin the new disable — it pins only
  the compaction row and the insert — so the row id and the tool list were read from the installed bundle's
  own patch (`dsh-experimental-agent-team-profile/cordis.patch.yml`), the same text the change brief
  quoted.
- **P4-04 is `docs/upstream-lifecycle-gap.md`.** It states the gap in paste-ready form for a
  `dsh-experimental-agent-team` issue: the closed phases and the permanent projection failure
  (ADR 0001:13-16), the never-shrinking budget and permanently taken names (ADR 0001:17-20), the absent
  completion notice (`docs/architecture-en.md:616`), the absent Session-deletion API
  (ADR 0011:18-26), and the rename rule that freezes stored names (ADR 0014:35-50). Section 3 says what
  this plugin works around rather than what upstream should build, and section 5 is the one short
  suggestions section. It is registered in both indexes and P4-04 is ticked; opening the issue itself is
  the owner's action.
- **The README pair's Status block was rewritten**, because it still said v0.13.1 while the package was
  0.13.2 and it grouped live and unit-only facts loosely. It now names v0.14.0, lists the verified-live
  results per release with the observations from the author's profile (v0.9.0 sweep, v0.11.0 template,
  v0.12.0 spawn options, v0.13.2 task board), records the two failures only a live install could show —
  v0.12.0 installed and did not activate until a schema keyword was removed, and v0.13.0's replacement
  returned a host-refused result until 0.13.2 declared the fields — each now covered by
  `scripts/check.mjs` and `tests/entry.test.mjs` respectively, and keeps only what is honestly unit-tested,
  including the changed tool surface itself.
- **The documents that described the coexistence were corrected.** The README pair ("What it is",
  "Model-facing only", install verification), `docs/architecture-en.md`/`-zh.md` (§1 now says three things,
  §2 gains v0.14, and §2.3, §4.1, §4.5 and §6 stop saying the shipped tools stay enabled), and `index.js`'s
  header comment. The shipped roster's service is still mounted and `list_members` still reports the
  members it created; only its tools are gone.
- **How this change was verified.** `node scripts/check.mjs` passes after the last edit;
  `node --check index.js actions.js roster.js trash.js host-hooks.js` exits clean; and
  `node --test --test-isolation=none tests/*.test.mjs` is 130 tests, 130 passing, with no test edited. The
  bilingual pairs were measured before and after rather than assumed: the README pair had 14 `##` headings
  and 116 distinct backtick identifiers on each side with identical sets before, and 14 headings and 129
  identifiers on each side with identical sets after; the index pair went from 5 headings and 33
  identifiers per side to 5 and 34, sets still identical; the architecture pair moved from 234/231 to
  238/235 and kept its pre-existing localised code spans (formulas and host spellings) as the only set
  difference.
- **What stays unverified.** No install and no `plugin_manager` call was made. The changed tool surface is
  therefore unproven in the only place it can be observed: that a Lead's real tool list no longer contains
  `spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`/`wait_agent`/`team_task_*` and does
  contain this plugin's nine tools. That needs the owner's install and a `listTools` read. The patch is
  also new to a real composition: a profile that does not mount the experimental team bundle has no
  `tool-agent-team` row, where the Loader is expected to warn about the target and skip the entry.
- **Version.** `0.14.0`: the model's tool surface changes, so this is not a documentation-only patch.

## 2026-11-12 — the tool surface is measured: the spawn, wait and task tools are gone, three agent-service tools remain (v0.14.1)

- **The claim was measured, and three of the six names were wrong.** The owner called the `Tool` provider's
  `listTools` in a live Lead session immediately before and immediately after installing v0.14.0, and
  compared the two answers. Gone from the second: `spawn_teammate`, `wait_agent` and the `team_task_*`
  tools — calling `spawn_teammate` now answers `unknown tool`. Still present: `list_agents`, `send_message`
  and `interrupt_agent`. This plugin's `spawn_member` and `task_board` are present on both sides, and
  `plugin_manager install_bundle` answered `application: applied` with no warnings, so the patch row
  resolved and the plugin is active.
- **Why the three remain, and why no bundle patch can remove them.** They are published by the
  `agent-team` *service* row, which this bundle deliberately keeps mounted because adoption, the
  membership test and the projection filter read that service. The patch disables the `tool-agent-team`
  *tool* row; disabling the service row would take those three consumers with it. The true statement is
  therefore narrower than the documents made it: the shipped spawn, wait and task tools are retired, and
  three agent-service tools remain.
- **Corrected to that statement.** The README pair's "Model-facing only" paragraph and its
  install-verification bullet; the v0.14 release bullet, §2.3, §4.5 and §6 of both
  `docs/architecture-en.md` and `docs/architecture-zh.md`; `cordis.patch.yml`'s entry-3 comment, which now
  says the kept service also publishes `list_agents`, `send_message` and `interrupt_agent`; and P2-07 in
  `PLAN.md`, which is current-state prose. The README pair's Status block moves the tool surface from
  "unit-tested only" to "verified live" with the result, and `wait_agent`'s absence stays as the cost:
  there is no equivalent here, so a Lead re-reads `list_members`, wakes a member with `message_member`, and
  reads `inactive` as "no turn is executing", never as "finished".
- **This entry does not rewrite the v0.14.0 entry above.** That one recorded what was known before the
  measurement and is history. P2-07 stays ticked: its done-when was the shipped roster tools, and those are
  gone.
- **Two present-tense claims still overclaim, and were reported rather than edited.** `index.js`'s header
  comment says the plugin's tools "are the whole model-facing surface" (the change brief's file list did
  not include it), ADR 0001's decision paragraph says `list_members` reports "a superset of `list_agents`
  instead of replacing it" (an accepted ADR is closed), and `docs/upstream-lifecycle-gap.md`'s closing
  paragraph says the two rosters could both be visible "until the shipped tool row was retired" — with
  `list_agents` still registered, both listings remain.
- **How this change was verified.** `node scripts/check.mjs` passes after the last edit;
  `node --test --test-isolation=none tests/*.test.mjs` is 130 tests, 130 passing, with no test edited. The
  bilingual pairs were measured before and after rather than assumed: the README pair went from 14 `##`
  headings and 129 distinct backtick identifiers per side with identical sets to 14 and 130 per side, sets
  still identical; the index pair is unchanged at 5 headings and 34 identifiers per side with identical
  sets; and the architecture pair moved from 6/238 against 6/235 — 8 English-only and 5 Chinese-only spans,
  the pre-existing localised code spans — to 6/242 against 6/239 with exactly the same 8 and 5, no new set
  difference.
- **What stays unverified.** Nothing was installed in this change — the measurement was the owner's
  v0.14.0 install — so the three service tools' own behaviour was not exercised here, and no plugin tool
  was called. The patch is also still new to a profile that does not mount the experimental team bundle,
  where the Loader is expected to warn about the missing `tool-agent-team` target and skip the entry.
- **Version.** `0.14.1`: a documentation and comment correction, but the published bundle's version moves
  so the corrected claim can be told apart from the one it replaces.

## 2026-11-12 — the blocking wait comes back on this plugin's own surface (P2-15, v0.15.0)

- **The investigation found an event, and the shipped reader of it cannot see these members.** The Event
  provider lists `agent/status` (`idle` ⇄ `running`, scope-filtered to one Agent) and `subagent/end` ("a
  published child settled", published from `dsh-subagent`'s lifecycle observer). A plugin does receive
  them: `scopeTarget` admits an untagged listener to a scoped dispatch (`@deepseek-ai/dsh-scope`
  `lib/index.js:327-338`), and the shipped `agent-team` service is itself such a listener for
  `agent/status` (`dsh-experimental-agent-team` `lib/index.js:1477-1480`). Its public
  `agentTeams.waitForChange` is therefore notified only for an agent its own membership test resolves, and
  `tryMembership` answers `undefined` for a subagent its journal does not own
  (`lib/types/roster.js:75-79`) — which is every member this plugin spawns through `ctx.subagents`. So the
  wait is this plugin's own listener on `agent/status`, filtered by the child ids on the Lead's roster.
- **`wait_members` is that tool (P2-15).** It blocks one turn until a watched member's live status
  changes, or a timeout; it reports the member and the status it entered (`target`, `status`), and a
  timeout, a cancellation and an impossible wait each answer differently (`timed_out`, rejection,
  `no_progress`). The bound is documented and enforced: 30 s by default, refused above 1 h. It observes
  only post-call transitions, never wakes anybody, refuses a non-Lead caller like every other tool, and
  its description says what it does not wait for: a `task_board` write, a delivered message being
  processed, a member's whole assignment, or a retired member's state.
- **The README pair gained three sections, in both languages.** "Limits and deliberate omissions" — the
  single-file per-Lead store with no cross-process lock (ADR 0010), no browser half (ADR 0008), the kept
  `agent-team` service row and its three surviving tools (ADR 0017), a pruned tombstone that cannot be
  restored (ADR 0011), and the board's deliberate lack of priorities, dependencies, comments, sub-tasks
  and due dates (ADR 0017). "Requirements and compatibility" — what the host must provide to run, then
  what the test suite needs, citing the CI pin (`.github/workflows/ci.yml`, `node-version: "24"`) and why
  `--test-isolation=none` is not optional. "Upgrading from v0.13 or earlier" — a table naming each tool
  v0.14.0 removed (`spawn_teammate`, `wait_agent`, `team_task_create`, `team_task_list`, `team_task_get`,
  `team_task_update`) and its replacement, including the edits that have none (dependencies, priorities,
  comments).
- **Present-tense claims the new tool falsifies were corrected; history was left alone.**
  `docs/architecture-en.md`/`-zh.md` §4.5 gained the `wait_members` row and now say the disabled row's
  tools all have replacements; §5's "notice that a child stopped — none exists" row became the two events
  that do exist (`subagent/end`, and the `idle` edge of `agent/status`), neither durable, so the ephemeral
  sweep keeps its own evidence, and §4.3.1 now says "no durable completion event" for the same reason.
  `cordis.patch.yml`'s entry-3 comment lost its "no blocking wait" sentence; its three entries are
  unchanged. `PLAN.md` gains P2-15 with its done-when. ADR 0013 (accepted, closed), P2-07's delivered
  text and the v0.14.x entries above keep their wording: they were true when written.
- **How this change was verified.** `node --check index.js actions.js roster.js trash.js host-hooks.js`
  exits clean; `node scripts/check.mjs` passes after the last edit; `node --test --test-isolation=none
  tests/*.test.mjs` is 136 tests, 136 passing — the 130 that existed plus 6 (5 in `tests/wait.test.mjs`,
  1 in `tests/entry.test.mjs`), with no existing test edited. The new wait's main test was proved able to
  fail: `watched.get(payload?.agent?.id)` in `nextMemberStatus` was replaced with a key that is never
  present, the named test failed on `timed_out` (`true !== false`, `tests/wait.test.mjs:83`), the line was
  restored, and the test then passed. `tests/wait.test.mjs` hashed
  `20C292027658738A1EA949BD93263671B5DF18F6B01C11C3BE281F2E4ADEB48F` before and after that proof, so the
  proof edited the operation, not the test. Bilingual parity was measured before and after rather than
  assumed: the README pair went from 14 `##` headings and 130 distinct backtick identifiers per side with
  identical sets to 17 headings and 156 identifiers per side with identical sets.
- **What stays unverified.** No install and no `plugin_manager` call was made. The wait's live wiring is
  therefore unproven in the only place it can be observed: that a real Lead's `wait_members` call receives
  `agent/status` from the installed Harness and returns when a member's turn ends. That is the owner's
  install check, and the README's install-verification list carries the exact call to make.
- **Version.** `0.15.0`: the model's tool surface gains a tool, so this is not a documentation patch.

## 2026-11-12 — a member becomes a file on disk (P4-06, v0.16.0)

- **The split the feature is for: the member is a file, the roster stays runtime state.** Until this
  release every member was improvised in a tool call — prompt, label and assignment lived in that call
  and in the Lead's `storageDomain` record (ADR 0003), so a team could not be reviewed, versioned or
  cloned, and the same "reviewer" was retyped every session. `spawn_member` now takes one more optional
  parameter, `definition`, naming a markdown file under `team/` in the Lead's working directory; its flat
  frontmatter declares the member and its body is the prompt. No create/update/delete tool was added for
  those files: version control and an editor are what make a file better than a tool, and the model
  writes them with its own file tools (ADR 0018).
- **The path is the service the Harness itself uses, and it is never guessed.** The directory is
  `ctx.get('workingDirectory').ensure(leadAgent, signal)` — the same service and method the installed
  subagent seam uses to resolve a relative `request.cwd` (`dsh-subagent` `lib/index.js:1530`) — so a
  definition is read from exactly the directory `spawn_options.cwd` resolves against. It is not
  `process.cwd()`, which is the Harness process's launch directory. The service is read with `ctx.get`
  rather than added to `inject`, so a profile that does not mount it still activates every other tool; a
  definition spawn there answers `started: false, reason: "working-directory-unavailable"` and reserves
  nothing. An absent service, a rejected `ensure` and a non-absolute answer are all that same refusal.
- **The accepted frontmatter is written down, and everything outside it is refused with the file and the
  line.** Accepted: `name` and `label` (required) plus `assignment`, `ephemeral`, `cwd`, `provider`,
  `model`, `reasoning_effort`, `max_tokens`, `agent_preset`; `key: value` one pair per line, no
  indentation, a value plain or quoted at both ends with no escape interpreted, blank lines and `#`
  comments. Refused by name and line: nesting, list items, block scalars (`|`, `>`), anchors and aliases
  (`&`, `*`), merge keys (`<<`), flow collections, duplicate keys, an unknown field (the sentence lists
  the accepted set), a key with no value, a missing `name`/`label` and an empty body. There is no YAML
  library — the bundle imports nothing outside Node builtins (ADR 0002) — and a hand-written parser that
  "mostly" understands YAML fails by silently misreading a value, which is the class of failure v0.12.0
  already produced once. The field values are validated with the roster's own `checkMemberName`,
  `checkLabel` and `checkAssignment`, so a definition cannot declare what the reservation would refuse.
- **Precedence is per field, and it is reported rather than inferred.** Every argument the call passes
  overrides the file's, including inside `agent_options`, and `definition.from_file` /
  `definition.overridden` name the fields on both sides, so "I overrode it" is a fact in the answer. The
  one field the call cannot replace is `prompt`: the body is the member's standing prompt and the call's
  prompt is the task, so the call's text is appended after the body and `definition.prompt` reports
  `file` or `file+call`. That asymmetry is deliberate and documented — a definition a task string erases
  would be retyped in every call, which is the problem the feature removes.
- **One bad file does not hide the others, and it is still visible.** A scan reports what it could not
  read as `{path, line?, problem}`: `definition.problems` on an otherwise successful spawn, `problems` on
  a refusal. A name declared by two files refuses **both**, because a lookup that quietly picked one
  would make the other file's edits invisible. An unknown name answers `definition-not-found` with
  `available` (the names the same scan could use), or `definition-invalid` when the directory also held a
  refused file, since the name may be declared there. This is the rule a stored task already follows
  (ADR 0017).
- **Caps refuse, never truncate, and a refusal reserves nothing.** 16 KiB per file (`DEFINITION_FILE_MAX`,
  refused per file, so an oversized definition does not hide its neighbours) and 64 files per scan
  (`DEFINITION_LIMIT`, refused for the whole directory, because a partial set makes a missing name
  indistinguishable from a deleted one). No member record is written and no child started on any refusal,
  so fixing the file and retrying reuses the same name — unlike a capability refusal, whose `failed`
  reservation is deliberately visible in the roster (ADR 0016).
- **The result schema is a two-branch `oneOf`, and both branches are covered.** `spawn_member` now
  answers either the member row (with an optional `definition` report) or
  `{started: false, reason, message, …}` with a reason disjoint from the capability refusals, so exactly
  one branch matches. `tests/entry.test.mjs`'s conformance test validates a definition spawn, a
  `definition-not-found` refusal and a `working-directory-unavailable` refusal against that declared
  schema, which is the check v0.13.0's undeclared result field needed and did not have. `label` and
  `prompt` stopped being unconditionally required in the parameter schema — a definition can supply them
  — and their descriptions say so; their guards still fire when they are passed blank.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits clean; `node scripts/check.mjs` passes after the last edit; `node --test
  --test-isolation=none tests/*.test.mjs` is 146 tests, 146 passing — the 136 that existed plus 10, with
  `tests/entry.test.mjs` extended and no existing test edited. The new `definitions.js` was added to
  `package.json`'s `files`, to the repository check's Host-module list (so the zero-import rule covers it)
  and to the CI syntax step. The main test was proved able to fail: `applyDefinition`'s `if (supplied)` in
  `actions.js` was changed to `if (supplied && file[key] === undefined)`, the precedence test failed with
  `actual 'reviewer'` against `expected 'auditor'` (`tests/definitions.test.mjs:168`), the line was
  restored, and the test then passed. `tests/definitions.test.mjs` hashed
  `BF0DFE19D334E4D31879D8F30ED9A030B2B7497A80B71971C8774B399F3C6C9C` before and after that proof, and
  `actions.js` returned to `B80E11BB956A5494DA3FA2B42444F241A89C74F713A4F300D4165F6E64A10E75`, so the
  proof edited the operation, not the test. Bilingual parity was measured before and after rather than
  assumed: the README pair went from 17 `##` headings and 156 distinct backtick identifiers per side with
  identical sets to 18 headings and 170 identifiers per side with identical sets.
- **What stays unverified.** No install and no `plugin_manager` call was made, so the one thing only a
  live profile can show is unproven: that `spawn_member { definition: … }` in a real Lead session reads
  the real `team/` directory through the installed `workingDirectory` service and starts the member. The
  suite exercises the parser, the scan, the merge, every refusal and the wrapper against the real
  filesystem and a `workingDirectory` fake, but the service itself is the owner's install check. The
  README's install-verification list carries the call to make.
- **Adjacent correction.** `docs/architecture-en.md`'s release map skipped v0.15.0 — the entry was
  missing, not wrong — so the v0.15 bullet was added beside the new v0.16 one in both languages.
- **Version.** `0.16.0`: a new published module and a new parameter on the spawn surface are not a patch.

## 2026-11-12 — a definition no longer outranks the record on a replace (v0.17.0)

- **The defect was real, and it was two correct decisions never joined.** `spawnMember` merged a
  definition into the call's fields, wrote the merged `assignment` back over the model's argument, and
  then let `planMember` inherit `recorded ?? predecessor?.assignment` — where `recorded` was by now the
  *file's* sentence. So `spawn_member { definition, replace }` started every successor from the file's
  standing assignment instead of what the predecessor was doing. ADR 0009 point 4 says a successor
  inherits the recorded assignment, and the plugin's claim is that only the person changes, not the work:
  a definition file silently defeated both. The fix was found by reading the code, and the test written
  before it reproduced the defect as `actual 'Keep the parser green'` against `expected 'Finish the parser
  unit tests.'`.
- **The rule on a replace is call → predecessor record → file.** An explicit `assignment` on the call
  wins; otherwise the predecessor's recorded assignment wins; the file's applies only when there is nothing
  to inherit. A fresh spawn is unchanged: the call wins and the file fills the rest. The merge now runs
  after the predecessor is resolved, and only the *reading* of the definition stays before the sweep, so a
  refused file still changes nothing. The result reports the winner in `definition.assignment`
  (`call`/`predecessor`/`file`) — the way `definition.prompt` already reports its own source — inside the
  existing `definition` report, so `spawn_member`'s two-branch result `oneOf` is unchanged in shape
  (ADR 0019).
- **The rest of the matrix is written, one cell per field, in both languages.** `docs/architecture-en.md`
  §4.3.3 and its Chinese pair decide `assignment`, `ephemeral`, `cwd`, `provider`, `model`,
  `reasoning_effort`, `max_tokens` and `agent_preset` across `spawn`, `replace` and `message`: what the
  file contributes, what the call overrides, and the effect. Two facts the matrix forced into words: the
  predecessor's `cwd` and model route are *not* inherited, because start options are not record fields;
  and `message_member` never reads the file at all.
- **`ephemeral` applies on a replace, and the matrix states the cost.** The file describes the role, so a
  replaced one-shot role is still one-shot: the successor retires itself at the end of its turn, and the
  open tasks the replacement just handed it become unowned, reported by the sweep in
  `unowned`/`unowned_tasks` (ADR 0017). Ignoring the file's `ephemeral` on a replace was rejected in
  ADR 0019: special-casing one field on one event makes the file mean different things depending on how a
  member started. The escape hatch is one explicit field (`ephemeral: false`) or one message, which clears
  the flag.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits clean; `node scripts/check.mjs` passes after the last edit; `node --test
  --test-isolation=none tests/*.test.mjs` is 153 tests, 153 passing — the 146 that existed plus 7 in
  `tests/definitions.test.mjs`, with `tests/entry.test.mjs` extended and no existing test edited. The main
  test was proved able to fail: the precedence branch in `actions.js` was reverted (the file's branch moved
  ahead of the record's), the named test failed with `actual 'Keep the parser green'` against
  `expected 'Finish the parser unit tests.'` at `tests/definitions.test.mjs:423`, the branch was restored,
  and the test then passed. `tests/definitions.test.mjs` hashed
  `5FD4A6EB3833ABB8DC68B1B10A0F1DE7ECCFDDA0926EB92D6C41D64E70EA255B` before and after that proof, and
  `actions.js` returned to `0E523BC99B7FC08F1A502A1074C0BC0D8289E52755D39CBFACCBC9EAE8F5986A`, so the
  proof edited the operation, not the test. Bilingual parity was measured before and after rather than
  assumed: the architecture pair went from 6 `##` headings and 287 distinct backtick identifiers against
  284, with 9 English-only and 6 Chinese-only spans, to 6 and 297 against 294 with the same 9 and 6, so no
  new set difference; the README pair, touched for the new rule, went from 18 headings and 170 identifiers
  per side with identical sets to 18 and 176 per side, still identical; the index pair from 5/37 identical
  to 5/39 identical.
- **What stays unverified.** No install and no `plugin_manager` call was made, so the one thing only a live
  profile can show is unproven: that a real `spawn_member { definition, replace }` call composes this merge
  against the installed Harness. The suite runs the real parser and filesystem against a
  `workingDirectory` fake; the service and the start are the owner's install check.
- **Version.** `0.17.0`: which assignment a successor receives is behaviour, not a comment.

## 2026-11-12 — a task carries a body, and a board write cannot undo a handover (P4-07, v0.18.0)

- **Both findings were real, and both were verified here before anything changed.** The shipped board's row
  carries a `description` of up to 16384 characters that its update action can amend; this board's row had
  a 200-character `title` that **no action could change after create** (`update` read `status` and `owner`
  only), so a successor — whose brief names an id and a title — was handed the work's *name* and never its
  acceptance criteria or where the predecessor stopped, and a predecessor with three open rows could not
  describe them in the 1000-character member `assignment` either. The write path was worse: `taskBoard`
  read the roster once, built `const next = { ...existing }` from that snapshot, and wrote the whole row
  through `writeTask` → `withTask(current, next)`. A handover landing between the read and the write was
  undone by the next board call — an `update` restored the previous owner, a `release` un-owned work the
  successor had just taken, and a `delete` removed the row a replacement had just moved. (The survey's
  line numbers 1616/1686/1639–1641 were of the revision it read; the shape it described is what the
  pre-change code showed.)
- **The field is `body`, capped at 2000 characters and refused past it.** `TASK_BODY_MAX` sits at twice
  `ASSIGNMENT_MAX` — a body states what "done" means *and* where the work stopped — and eight times below
  the shipped `description`, because the whole task array is rewritten on every spawn, retirement and task
  write in a single-document domain. `create` and `update` set it, `update` amends it, `body: null` clears
  it, and `checkTaskBody` throws rather than slicing, exactly like `checkTitle`/`checkLabel`/
  `checkAssignment`. `list` returns it; a stored body past the cap (or empty, or not a string) is served
  with `problem` on the row rather than dropped, and the cap is a read rule rather than a load rule because
  one Lead's long body must not fail the domain open (ADR 0017 point 11).
- **The brief still carries the id and the title only, and now says so where it is composed.**
  `inheritedTasksLine`'s comment records that the body is excluded on purpose: its bound is the board's,
  not a cold child's prompt, and one maximal body per row would break the 600-character line. The
  successor reads the bodies from `task_board` with `action: list`. A test creates a task with a maximal
  body and pins that the brief still names its id and title, contains no body text, and stays six lines.
- **Every id-addressed board write is now built inside the serialized mutation, from the record the write
  lands on.** `update` applies only the fields the call named, so a status or body change keeps the owner a
  handover gave the row and never writes a snapshot's owner back. `release` and `delete`, whose effect is
  subtraction, act only on the state the call read: when the stored `status`/`owner` is no longer the one
  in the snapshot they write nothing, answer `changed: false` with the row they found, and name the owner
  that took it so one more call, from a fresh read, does what was asked. A row that vanished mid-write
  draws the same refusal an unknown id draws. No revision parameter is added — ADR 0017 point 5 still
  refuses making the model track revisions — and no schema gains a field for it.
- **The interleaving is simulated, because real concurrency cannot produce it in a test.**
  `tests/task-detail.test.mjs` wraps the roster table's serialized `update` so that the first write a board
  call makes is preceded by a `reownerTasks` handover, then asserts for all three actions that the
  successor still owns the row: the update's status change still lands, the release and delete report
  `changed: false` and write nothing.
- **`blocked_by` is refused a second time, with its reason written into the ADR.** The shipped board's
  field only gates *starting* work and never participates in carrying it, so it answers an ordering
  question this board does not ask; the shape to copy if ordering is ever wanted is a `context` list — the
  tasks whose output this one uses — rather than a bare blocked-by, because it names the dependency by what
  crosses it and a handover can then say whether the successor already holds that output.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits clean; `node scripts/check.mjs` passes after the last edit; `node --test
  --test-isolation=none tests/*.test.mjs` is 162 tests, 162 passing — the 153 that existed plus 9 in
  `tests/task-detail.test.mjs`, with `tests/entry.test.mjs` extended and no existing test edited. **Both
  main tests were proved able to fail**, each by reverting only the operation: with the lookup reverted to
  the pre-fix snapshot, the race test failed at `tests/task-detail.test.mjs:117` with `actual 'reviewer'`
  against `expected 'reviewer-g2'` (plus the release, delete and named-owner cases), and with
  `checkTaskBody` truncating instead of throwing the cap test failed with `Missing expected rejection`,
  `expected /cap is 2000/`. `tests/task-detail.test.mjs` hashed
  `4E5F7DC4A8B36315721A401583A5864A18D4F99D569861E3736A407D645D900A` before and after both proofs, and
  `actions.js` returned to `3688E879336097768F62042301E3079DD0886B3C2272480C041B37924B94FF7E`,
  `roster.js` to `A5D0CC75F02DBA8D3947D8CB7BDCBCA3A9ACABF91EE9FF012DB2A96F4AD1DCBE`, so each proof edited
  the operation and not the test. Bilingual parity was measured before and after rather than assumed: the
  README pair went from 19 headings and 176 distinct backtick identifiers per side with identical sets to
  19 and 178 per side, still identical; the index pair from 6/39 identical to 6/41 identical; the
  architecture pair from 22 headings and 297 against 294 identifiers with 9 English-only and 6 Chinese-only
  spans to 22 and 304 against 301 with the same 9 and 6, so no new set difference.
- **What stays unverified.** No install and no `plugin_manager` call was made, so the live `task_board`
  call is still the owner's install check: the suite drives `actions.js` and the tool wrappers against a
  table fake and never loads the Harness. In particular the interleaving the write path is built for cannot
  be produced by a live run on demand — the test drives the table's own serialized hook — and the body cap
  and the read rule are unit-tested only.
- **Version.** `0.18.0`: a task that cannot say what it is, and a write that can undo the handover it
  exists to move, were both behaviour.

## 2026-11-12 — the team scope moves onto disk: the brief's shape is a team file (v0.19.0)

- **A survey found the asymmetry, and this release closes it.** CrewAI splits a crew into `crew.jsonc`
  and `agents/<name>.jsonc`, both on disk. This plugin already had the member scope on disk (v0.16.0,
  ADR 0018), but the team scope lived only in the per-Lead `storageDomain` record — so the one setting
  that shapes a handover, the brief template, was the only team setting with no diff, no review, and no
  sharing between two Leads in one project.
- **One optional file, in the same directory the member definitions already use.**
  `<Lead working directory>/team/team.md`, resolved by `definitionDirectory` — the same
  `workingDirectory.ensure(Lead, signal)` + `join(..., 'team')` path — and parsed by the same
  `parseFrontmatter` reader, with no accepted field. Its body is the handoff template; its frontmatter is
  empty for now, so no team setting was invented. The directory resolution and the parser are code that
  already existed, not a second path or a second YAML subset.
- **The effective template has three sources, and the read reports which one is in effect.** The file
  wins; otherwise the stored `handoffTemplate`; otherwise the built-in shape. `handoff_template`'s read
  answer keeps `template`, `stored`, `valid`, `problem` and `message`, and gains `source`
  (`file`|`stored`|`builtin`), `file` and `file_problem`; the declared output schema and
  `tests/entry.test.mjs`'s conformance check both cover the new fields. A replacement passes the same
  resolved template to `handoffPrompt`, so the brief's composition is untouched — only where the
  template comes from changed.
- **A store write or clear is refused while the file exists.** The exact answer is
  `handoff_template: the team file "<path>" is in effect, so a stored template would be shadowed and this
  write would change nothing. Edit that file to change the brief, or remove it to use handoff_template
  again.` The refusal holds even when the file itself is unusable, because a fixed file would shadow the
  write on the next replacement; accepting it would only move the surprise later. This is the failure the
  feature is built to prevent — a successful call whose brief did not change.
- **`team.md` is reserved, explicitly.** The member-definition scan skips that exact filename, so a
  `team.md` can never be reported as a broken definition on every spawn. A member may still declare
  `name: team` in another file: the filename is not an identity, and the reservation covers one path. A
  test proves both halves.
- **The file is held to the placeholder rules.** `parseTeamFile` calls `handoffTemplateProblem`, so an
  unknown token is refused by name, `{assignment}` is required, the 1000-character cap is a refusal, and
  the existing rendered-brief cap still applies. A file that fails any rule is reported in
  `file_problem` and never becomes the effective template: the stored template is next, the built-in
  shape is last. That is the same fallback a stale stored value already gets, not a way around the rules.
- **No file means no change.** `tests/team-file.test.mjs` pins the built-in brief byte for byte and
  asserts the read reports `source: 'builtin'`; the existing 162 tests were not edited to accommodate the
  new first source. The one new test file carries seven cases.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits clean; `node scripts/check.mjs` passes after the last edit; and
  `node --test --test-isolation=none tests/*.test.mjs` is 169 tests, 169 passing (162 before, plus 7 in
  `tests/team-file.test.mjs`; `tests/entry.test.mjs` extended, no existing assertion changed).
- **The main test was proved able to fail, and the proof edited the operation, not the test.** With the
  file branch moved after the stored branch in `resolveHandoffTemplate`, the precedence test failed at
  `tests/team-file.test.mjs:84` with `actual 'stored'` against `expected 'file'` (`AssertionError
  [ERR_ASSERTION]: the file is the source while it exists`), and 6 of 7 passed. The file branch was
  restored and the test passed again. `tests/team-file.test.mjs` hashed
  `25AA40C0C0B783F744F9646A8AC97460056598CF42EFC0CF515AE20E51912CA9` before and after the proof, and
  `actions.js` returned to `B3627CC9B2E60FCB736EB5563F2F7C305A1A899E5EA4B06AEF32534B8D1015EF`, so the
  test file was never edited and the operation was exactly restored.
- **Bilingual parity was measured before and after rather than assumed.** The README pair went from 18
  `##` headings and 178 distinct backtick identifiers per side with identical sets to 18 and 184 per side,
  still identical; the index pair from 5/41 identical to 5/43 identical; the architecture pair from 21
  headings and 304 English/301 Chinese identifiers with 9 English-only and 6 Chinese-only spans to 22 and
  313/310 with 10 and 7 — the one new difference on each side is the localized team-file path
  (`<Lead working directory>/team/team.md` against `<Lead 工作目录>/team/team.md`), which follows the
  existing localized `<Lead working directory>/team/*.md` pair. No other set difference was added.
- **What stays unverified.** No install and no `plugin_manager` call was made. The live
  `handoff_template` read/write and a replacement rendered from a real `team/team.md` are the owner's
  install check: the suite drives `definitions.js`, `actions.js` and the tool wrappers against a real
  filesystem and a `workingDirectory` fake, and never loads the Harness. The four frozen names in ADR 0014
  and the three `cordis.patch.yml` entries were not touched.
- **Version.** `0.19.0`: the source of the handoff template changes, which is behaviour, not a comment.

## 2026-11-12 — a member can read the work it owns, and the brief points at the right board (P4-09, v0.20.0)

- **A live run found the gap this release closes.** A successor enumerated its tools, found no roster tool
  at all (every one in `index.js` called `requireLead`, and `apply` installed only Lead scopes), and read
  `~/.dsh/storages/team_roster.json` directly to discover the task body it had inherited. The body ADR
  0020 added was therefore readable only by the Lead, which made "a successor reads the bodies from this
  board" false in every document that repeated it. The same brief's `{task_board}` pointer named the
  shipped board (whose tools v0.14.0 disabled) and told the successor to ask the Lead for ids.
- **One member-scoped read, and no member write.** `list_my_tasks` takes no parameter and returns
  `{ target, tasks, open, message }`: the rows whose `owner` is exactly the caller's own target, projected
  through the same `taskRow` the Lead's board uses (id, title, body when present, status, owner,
  timestamps, read-time `problem`). A member owning nothing gets `tasks: []`, `open: 0` and a sentence, not
  an error. Another member's row, every unowned row and the Lead's whole board are absent. The authority
  is the caller's Session id resolved across the rosters (`memberScopeOf`/`requireMember`), never an
  argument, and the read never adopts. The board keeps exactly one writer: a member reports finished work
  and the Lead closes the row with `task_board`; the ADR records why that round-trip is cheaper than a
  second writer (ADR 0022).
- **The member scope is registered the same way as the Lead's.** `installMember` registers on the
  non-root Agent's own `agent.ctx` at load and on `agent/created`; `agent/disposed` and plugin unload
  remove it. The Lead's `install` is untouched, so its ten tools and their schemas do not change; a member
  whose Session is not this process's Lead still receives its tool, and whether it is on a roster is
  decided at call time.
- **The pointer was corrected where it was false.** `{task_board}` now renders "this Lead's own task board
  under the name …; read it with list_my_tasks and take those tasks over instead of redoing finished
  work" — no shipped board, no "ask the Lead", and no final period (a stored template that appends one
  produced the `board..` a live brief showed). The unrecorded-assignment fallback and the "and N more"
  remainder of the inherited-tasks line name the same board and tool. The `task_board` description,
  `TASK_ROW`'s comment, the README pair, `docs/architecture-*.md` and ADR 0020's wording were corrected;
  ADR 0009 and 0015 keep their historical bodies, and ADR 0022 records the wording adjustment.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits 0; `node scripts/check.mjs` passes after the last edit; and
  `node --test --test-isolation=none tests/*.test.mjs` is 170 tests, 170 passing (169 before, plus the new
  member-scope test). `tests/entry.test.mjs`'s two existing scope assertions changed on purpose — a member
  context now holds `list_my_tasks` instead of zero tools — and its conformance test drives a real member
  answer through the tool's own declared schema.
- **The main test was proved able to fail, and the proof edited the operation, not the test.** With the
  owner filter removed from `listMyTasks`, `tests/entry.test.mjs` failed at line 254 with actual
  `['mine-open', 'mine-done', 'theirs', 'nobody']` against expected `['mine-open', 'mine-done']`; 9 of 10
  passed. The filter was restored and the file passed 10 of 10. `tests/entry.test.mjs` hashed
  `AE9BE6F90DE72A299EA6913F51AC30E155659CC0D00D5FC66133AF0A79020C7E` before and after the proof, so the
  test was never edited; `actions.js` was returned to the delivered text.
- **Bilingual parity was measured before and after rather than assumed.** The README pair went from 18
  `##` headings and 138 distinct backtick identifiers per side with identical sets to 18 and 139 per side,
  still identical; the index pair from 5/43 identical to 5/44 identical; the architecture pair from 6 `##`
  headings and 233 English/234 Chinese identifiers to 6 and 236/237, with the same three set differences
  before and after (EN-only `put`; ZH-only `config`, `generation`), so no new difference was added.
- **What stays unverified.** No install and no `plugin_manager` call was made. The live call from inside a
  real member Session — the one thing the live run that found this gap did — is the owner's install check:
  the suite registers on a fake Agent context and never loads the Harness. The four frozen names in ADR
  0014 and the three `cordis.patch.yml` entries were not touched.
- **Version.** `0.20.0`: the plugin now serves a tool a real member can call, which is behaviour.

## 2026-11-12 — the shipped team panel lists this plugin's members (P4-10, v0.21.0)

- **The gap this closes is a read, not a lifecycle.** The built-in members/tasks panel renders
  `projectionsBySession[lead].values.agentTeam`, the wire view of the Lead Session's team fold. That fold
  only hears the `team/member` and `team/task` events the shipped roster appends, so a member started
  through `ctx.subagents` was never in it — the plugin could list, message, retire and replace a member,
  but the one in-app view the owner actually looks at could not show it. The log is not the place to fix
  that: a synthetic transition out of a terminal phase throws and the projection records the throw as a
  permanent `failure` (ADR 0001), after which every Team read and mutation for that Lead throws.
- **The same exit already carried the answer.** `host-hooks.js` already wrapped
  `sessionController.list` / `projections` / `control` / `follow` to strip retired ids from
  `subagentCatalog` and `agentTeam`. The change extends that seam to strip and merge: the outgoing value
  keeps losing retired ids, then gains this Lead's live members. The value is a parsed copy — every
  publish point validates it with `wire.viewSchema.parse`, which builds new objects — so the overlay can
  rewrite it without touching the projection's stored cell or appending a Session event. That property is
  what made the seam safe in the first place, and the ADR records it as the boundary: write the copy,
  never the log.
- **The synthesised row is four fields, because that is all the strict schema accepts and all the panel
  reads:** `{ id: childId, name: target, role: 'teammate', phase: 'active' }`. `id` is the recorded child
  Session id, so the panel's click opens the member's real chat and its running-state lookup finds the
  real child; `name` is the model-facing target (`reviewer`, `reviewer-g2`), the same handle every tool
  takes; `role` and `phase` are the only true values for an overlay-added member. Only a record whose
  phase is `active` and that carries a child id is offered (`livePanelMembers` in `index.js`), so a
  provisioning reservation, a failed start and a retired tombstone are not added. An id already present
  in the value is left exactly as it was — the overlay never duplicates, renames or re-roles a shipped
  row — and a member that is retired simply stops being appended, because the wire phase enum is closed at
  `provisioning | active | failed` and absence is the only honest statement of "retired" in this view.
- **The task half is deliberately not overlaid.** The shipped task view needs about ten fields
  (`id`, `revision`, `subject`, `description`, `status`, `blockedBy`, `writeScopes`, `ownerName`, `ready`,
  `writeScopeWarnings`), while a member row needs four. This board has no revisions, dependency graph or
  write scopes, so a synthetic task row would be rejected by the strict schema or drop most of what the
  panel shows. The ADR records it as the next step, not something to invent here.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits 0; `node scripts/check.mjs` prints `check passed` after the last edit; and
  `node --test --test-isolation=none tests/*.test.mjs` is 176 tests, 176 passing (170 before, plus six
  new overlay tests). The tests drive every shape the value arrives in — the `projections` baseline, a
  `list` row's `projections.values`, the `control` baseline's keyed map, a `control` change frame
  (`changes[].val`) and a `follow` snapshot — through the installed filter, and cover the duplicate case,
  the strip-and-merge order on all five shapes, the no-op (same payload and same array reference), the
  missing-child-id filter, a host without `sessionController`, and the disposer restoring all four
  methods rather than only `list`.
- **The main test was proved able to fail, and the proof edited the operation, not the test.** With the
  merge removed from the filter's `strip`, `tests/host-hooks.test.mjs` failed 2 of 14; the seam test at
  line 137 failed with actual `['lead-1']` against expected `['lead-1', 'child-live']`. The merge was
  restored and the file passed 14 of 14. `tests/host-hooks.test.mjs` hashed
  `9E1B6A287F9B306143B01CF25817DB8A96742B9249AF516397E74B65A26B7044` before and after the proof, and
  `host-hooks.js` returned to `D8470755B02A1CA5A63A6206669132B9CE90F84C19BD9A6292CF84A194DB78A2`, so
  neither the test nor the delivered operation was left edited.
- **Documents.** A new ADR 0023 records the overlay, its four-field row with the schema and render lines
  it was read from, the copy-not-log boundary, retirement as absence, and the task-view reason. The
  architecture pair gains §2.4.1 — what a plugin may write where, and how each written field maps to what
  the panel shows — plus updated §2.4, §5 and §6 entries. The README pair says plainly that the shipped
  **members** panel lists this plugin's live members and that a retired member leaves the panel rather than
  being marked; the index pair registers ADR 0023; `PLAN.md` gains P4-10, ticked because this PR delivers
  it.
- **What stays unverified.** No install and no `plugin_manager` call was made. The rendered panel — a
  member appearing, an idle one reading not-running, a click opening its chat, and a retired one disappearing —
  is the owner's install check; the suite never loads the Harness. The overlay's freshness is also a real
  limit: this plugin writes no Session event, so a spawn publishes no team change frame of its own, and a
  new row appears on the next `list`/`projections`/`follow` read or `control` frame. The four frozen names
  in ADR 0014 and the three `cordis.patch.yml` entries were not touched.
- **Version.** `0.21.0`: the shipped panel's content changes, which is behaviour, not a comment.

## 2026-11-12 — the cost and route boundary, measured rather than suspected (v0.21.1)

- **The report this answers.** After the owner connected a relay provider, their own account was still
  billed, and this plugin's members were the suspects. A read-only investigation of the installed Harness and
  of the profile's session logs found the opposite: nothing here chooses a route on its own, and the one
  component that does is web search, outside this plugin. No behaviour changed; this release is the record
  and the documentation of that boundary.
- **The plugin forwards, the Harness resolves.** `spawn_member` sends `spawn_options.agent_options` only when
  the caller supplies it (ADR 0016). With none, the request is `{ prompt, parent }`, and
  `@deepseek-ai/dsh-subagent/lib/types/child-agent.js:49-92` resolves the child from the parent Session's
  latest logged request header — `provider`, `model`, `reasoningEffort`, then `maxTokens` and the requested
  fields — falling back to `parent.options` only while no request has been logged. The creation-time snapshot
  a reader may have seen is that fallback, not the normal path: inheritance runs per spawn, so a member
  started after the Lead moved to the relay inherits the relay.
- **A changed route drops the parent's effort** (`:88-90`), which is why `spawn_member` is unchanged on
  purpose. Forcing an explicit route would put an effort the route may not support on a child whose member
  record is already written, and the shipped tool's preflight that would catch it is not on this path
  (`@deepseek-ai/dsh-tool-subagent/lib/index.js:440-448`). The capability gate is the provider's
  (`@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`), and the Session route allowlist belongs to the shipped
  tool (`@deepseek-ai/dsh-tool-subagent/lib/index.js:89-96`), which this plugin does not use.
- **The machine evidence agreed.** Across the 57 session logs the investigation read (the directory held 60
  when this entry was written), every child Session mirrored its parent's route in both directions: 15
  children, the official-route ones at `seq 1394`, `1503` and `1994` — all before their parent switched at
  `seq 3495` — and the relay children at `seq 6664` and `7119`.
- **No LLM call, and compaction follows the session.** No Host module in this repository reaches `ctx.llm`,
  and no code path calls `prepareCall`. The `compaction-basic` row the patch enables resolves
  `configured ?? session.requestHeader().config ?? agent.options`
  (`@deepseek-ai/dsh-compaction-basic/lib/index.js:292-303`), the session's own route, so enabling it started
  no new billing.
- **The exception is web search, and it is not this plugin's to change.** The base bundle's patch selects
  `searchProvider: deepseek-official` (`@deepseek-ai/dsh-base/cordis.patch.yml:467-471`), and
  `dsh-web-search-deepseek` pins `https://api.deepseek.com/anthropic/v1` and `deepseek-v4-flash`
  (`@deepseek-ai/dsh-web-search-deepseek/lib/index.js:20-22`, `:319-320`). It produced 107 official requests,
  two of them after a session had switched to the relay. Repointing it is not a config edit: it requires a
  `web_search_tool_result` block and throws `WEB_PROVIDER_ERROR` without one (`:61-62`); a direct test of the
  relay's `/v1/messages` answered 200 with `stop_reason: "tool_use"` when handed the `web_search` tool — the
  shape that plugin rejects — while its `/anthropic/v1/messages` path answered 404. The owner's options are to
  disable that row or to use an endpoint that executes native search.
- **No ADR, and why.** The boundary is an observation, not a decision: nothing was built, rejected in code, or
  made expensive to reverse. The one decision nearby — forward only what the caller supplies, never force a
  route — is ADR 0016's, and that ADR already records that the plugin reports what it forwarded rather than
  reading the child's resolved options. A new ADR would restate it and lend a measurement the authority of a
  decision.
- **Documents.** The README pair gains "Costs and model routes" / “成本与模型路由” with three subsections:
  what chooses a member's model, no LLM call and the compaction row, and the web-search exception with the
  two honest options and the request that separates them. `docs/architecture-en.md` §2.6 and its Chinese pair
  state the same facts compactly, §4.1 now says what "inherits the Lead's value" resolves to, and the README
  Status block is advanced to v0.21.1 — it still read v0.20.0 while `package.json` said 0.21.0.
- **How this was verified.** `node scripts/check.mjs` prints `check passed` after the last edit;
  `node --test --test-isolation=none tests/*.test.mjs` is 176 tests, 176 passing. Bilingual parity is
  unchanged: README headings 19/19 before and 23/23 after, architecture headings 25/25 before and 26/26
  after, and the locale-key and pair checks inside `check.mjs` pass before and after.
- **What stays the owner's decision.** Which of the two web-search options to take, and whether to install.
  No install, no `plugin_manager` call and no new live call was made for this release; the log figures are
  what the running profile had already written.
- **Version.** `0.21.1`: documentation of a measured boundary, with the Status block's version line changed
  alongside `package.json`.

## 2026-11-12 — a member runs on the API of the session that started it (P4-11, v0.22.0)

- **The defect, as the owner measured it.** A member spawned now records the starter's current route — the
  probe session's own header reads `provider: do, model: DeepSeek-V4.1-Flash` — but a member spawned *before*
  a model switch keeps the route it had at spawn for its whole life: its own `request/header` was written
  then and never changes. An inventory of 60 session logs found 18 sessions still on
  `deepseek-official/deepseek-flash`, several of them members of a live team (one member made 4 of 4 requests
  on the official API), while the live Lead sessions ran on the relay. The previous entry recorded the
  boundary correctly and drew the wrong conclusion from it: the seam does resolve a child from the parent's
  *current* header, so the fleet is only correct for members started after the switch — and nothing in the
  plugin said so, or reported the ones that had fallen behind.
- **The fix is one resolution, forwarded explicitly.** `spawn_member` now reads the calling Lead's current
  `provider` and `model` from `caller.session.requestHeader()?.config` — the same accessor and field the
  installed seam resolves inheritance from
  (`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:49-62`) — and sends them as the activation request's
  `agentOptions`. The accessor is probed, never assumed: a Session without it, an accessor that throws, an
  absent config, or a config that does not name both fields resolves nothing. The parent Agent's creation
  options are deliberately *not* a second source; they are the stale snapshot this release exists to stop
  using.
- **`reasoningEffort` is never added.** The seam drops the parent's effort only when the route it resolved
  differs from the parent's (`:88-90`), and forwarding the parent's own route is exactly the case where it
  does not differ, so the Lead's effort survives the merge without being sent. A caller-named
  `reasoning_effort` is still forwarded unchanged, and a caller-named `provider`/`model` still wins and is
  completed from the same read so the recorded route is the whole route the child runs on.
- **Every resolution failure is a recorded fallback, never a failed spawn.** Two cases forward nothing, keep
  the exact `{ prompt, parent }` request the previous release sent, and let the Harness inherit:
  `no-session-route` (no accessor, no config, or no complete pair) and `capability-absent`
  (`ctx.subagents.getProvider('spawn')?.capabilities.agentOptions !== true` — forwarding one would make the
  seam reject the start with `UNSUPPORTED_CAPABILITY`, `@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`).
  `started_with.route_source` reports which path ran: `caller`, `plugin` or `inherited`, the last carrying
  `route.select_reason`. A spawn is never broken to fix a route.
- **The member record carries the route, and the roster row exposes the stragglers.** The record gains an
  optional `route` (`{ source, provider?, model?, select_reason? }`), written once with the reservation and
  never rewritten — a fact about the start, not live state. `list_members` resolves the Lead's route once per
  read and, for a member whose recorded route differs, adds `route_stale: true` and a `route_note` naming
  both routes, saying the member is still billed on the one it started on, and naming the one call that
  clears it. A member with no recorded route, or a Lead whose own route cannot be read, is not flagged:
  absence of evidence is not a straggler, and the flag clears itself the moment the routes match again
  because the comparison is made at read time and stored nowhere.
- **The remedy is machinery that already exists.** Nothing re-routes a live member — its route lives in its
  own recorded `request/header` — so the README pair says the way to clear a stale member is
  `spawn_member { replace: "<target>" }`, which starts a successor on the current route and hands the
  predecessor's open work over in the same call (ADR 0009, ADR 0017). No `reroute_member` tool was added: the
  work has to move with the person anyway.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits 0; `node scripts/check.mjs` prints `check passed` after the last edit; and
  `node --test --test-isolation=none tests/*.test.mjs` is 189 tests, 189 passing (176 before, plus 12 in the
  new `tests/route.test.mjs` and one wrapper-level test in `tests/entry.test.mjs`). The new suite covers
  forwarding, the caller's route winning, a partial caller route, all three unresolvable-route shapes, the
  capability fallback, `reasoningEffort` never added, the flag being set and not set, the flag clearing when
  the routes match again, an unreadable Lead route flagging nobody, a pre-v0.22.0 record, and an adopted
  member that was never spawned here. `tests/entry.test.mjs`'s conformance test drives real answers through
  the declared schemas of `spawn_member` and `list_members`.
- **The main test was proved able to fail, and the proof edited the operation, not the test.** With the
  forwarding removed from `spawnMember` — `if (false && Object.keys(route.requestField).length > 0)` —
  `node --test --test-isolation=none tests/route.test.mjs` failed 2 of 12: the forwarding test at line 84
  with actual `undefined` against expected `{ provider: 'do', model: 'DeepSeek-V4.1-Flash' }`, and the
  `reasoning_effort` test with `TypeError: Cannot convert undefined or null to object` because there was no
  `agentOptions` object to inspect. The forwarding was restored and the file passed 12 of 12.
  `tests/route.test.mjs` hashed `61B6F2322C9E4CA6CC829B4A7CC34C9D91CDBA55E7124FDE26E87E9A3363CDB4` before
  and after the proof — the test was never edited — and `actions.js` returned to
  `45B248F0F60FBDDB9AB0E7FFA6867E77D026E324BCEA11788297BCBCDB3395CF`.
- **Documents.** ADR 0024 records the decision to forward rather than inherit implicitly, the
  `reasoningEffort` exception, both fallback rules, the record and row fields, and why the stale-route flag
  exists; it also states that it adjusts ADR 0016 points 2 and 6, which said a spawn with no
  `spawn_options` composes exactly `{ prompt, parent }` and that `started_with` carries only what the caller
  supplied — both true when written, and both changed here on purpose. `docs/architecture-en.md` gains
  rewritten §2.6, a `route` line in the §4.2 record shape, updated §4.1 request composition, updated §4.5
  `spawn_member`/`list_members` rows and a §2 delivery line; the Chinese pair matches. The README pair gains
  the route sentence in the members/tools section, the "how to clear a stale member" note, a rewritten
  "Costs and model routes" section, a Status entry for the measured boundary and an install-verification
  item. The index pair registers ADR 0024; `PLAN.md` gains P4-11, ticked because this PR delivers it.
- **What stays unverified.** No install and no `plugin_manager` call was made. The live spawn is the owner's
  install check, and specifically the route recorded on the **child's own** `request/header`: the suite runs
  against fakes and never loads the Harness, so it proves the request the plugin composes, not what the
  child's Session ends up storing. The four frozen names in ADR 0014 and the three `cordis.patch.yml`
  entries were not touched.
- **Version.** `0.22.0`: the route a member runs on is behaviour, not a comment.

## 2026-11-12 — a host hook installs when its service exists, and says whether it did (P4-12, v0.24.0)

- **The defect was a silent skip, not a bad rewrite.** `apply` called the two host installers once, each read
  its service with `ctx.get` and returned `installed: false` when the service was not there yet, and the skip
  logged nothing. A profile composes rows by service availability, so this bundle's row can activate before
  the Web layer publishes `sessionController` (it needs the workspace registry, uploads and the gateway); the
  projection filter was then never installed for the life of the process. The dispatcher reads the live
  instance property per request, which is why a patch that lands is visible — this one never landed. The
  shipped panel kept every retired member, listed none of this plugin's, and `list_agents` kept the retired
  ones too. Nothing said why.
- **The gate is `ctx.inject`, not a retry loop.** Each host effect is now a Cordis dependency-gated plugin:
  the projection filter waits for `sessionController`, the shipped roster read and the slot credit wait for
  `agentTeams`. The callback installs when the service appears, is unloaded and re-run when the service is
  replaced, and its disposer unwinds the patch with this plugin's own fiber — so unload still restores every
  method. The plugin's own `inject` array is unchanged: a hook is an effect, not a prerequisite for the
  tools, and a headless profile simply reports it absent.
- **One tombstone set, one invalidation, and a visible failure.** `createRetiredCache` holds the set every
  hook strips; `retire_member` and `restore_member` invalidate it in the call that writes the record (both
  were already calling `invalidate()`, and `tests/hook-install.test.mjs` now pins it). A read that throws no
  longer empties the set — the last good set stays in force and `tombstone_read_failed` says it is stale.
  Emptying the set was the second silent no-op: both lists came back full and nothing said so.
- **The shipped `list_agents` read is filtered too.** `list_agents` calls
  `agentTeams.listMembers(callingAgent(exec.agent, "list_agents"))` and maps the array directly
  (`dsh-experimental-tool-agent-team/lib/index.js:321-327`); `agentTeams.listMembers` is the append-only Team
  journal's view (`dsh-experimental-agent-team/lib/index.js:1496`, `lib/types/roster.js:103-134`). The
  wrapper drops only the retired ids, keeps `lead` and every live row, and stays **synchronous** because the
  shipped caller does `.map` without awaiting — an async wrapper would break the tool. It reads the same
  tombstone set straight from the in-memory roster table, so it cannot be stale and needs no invalidation of
  its own. `agentTeams` is not a remote-decorated service, so the shipped tool sees the patch; adoption in
  this plugin also reads it, and a retired member is already on the roster, so dropping that row changes
  nothing there.
- **The outcome is part of the answer.** `list_members` always returns `host_hooks`, declared in its output
  schema: `panel_filter`, `roster_filter` and `slot_credit` as `installed` or `absent`; `stripped_ids` and
  `tombstone_read_failed` while a filter is installed; and a `message` naming an absent hook, the service it
  waited for, and what that means for the two lists. This is what makes the next failure of this kind
  self-reporting instead of another release.
- **Retirement is a role decision, and the model-facing surface says so.** `retire_member`'s description now
  states that a member is a division of labour rather than a task: finishing one piece of work is not a
  reason to retire anyone, an idle member between rounds is not a candidate, and a judgement call asks the
  person first. The README pair carries the same statement once, in the lifecycle section.
- **How this change was verified.** `node --check index.js actions.js roster.js definitions.js trash.js
  host-hooks.js` exits 0; `node scripts/check.mjs` prints `check passed` after the last edit; and
  `node --test --test-isolation=none tests/*.test.mjs` is 199 tests, 199 passing (189 before, plus six in the
  new `tests/hook-install.test.mjs` and four in `tests/host-hooks.test.mjs`). The new suite covers a service
  absent at load and published later (installs once), a service that never appears (`absent`, every tool
  still works), a reload (no second wrap; one dispose restores every method and the shipped roster read),
  the 37-row panel with five tombstones (32 rows, lead and every live row intact), a 36-entry catalog frame
  (31), a failed tombstone read (reported, last set in force, recovered after the next good read), and the
  retirement and restore invalidations. The main test was proved able to fail: with the `ctx.inject` blocks
  replaced by the old immediate install, it fails at the `installed` assertion after the service appears
  (`actual 'absent'`) and the reload test fails because the exit was never restored; restored, the suite is
  green. `tests/hook-install.test.mjs` hashed
  `5475F350969E23B2A8BF179287E8F4C3040702EE0A35791857FDB839C23A0BED` before and after that proof — the test
  was never edited.
- **Predicted panel counts for the current profile.** For the Lead Session whose store this was read from,
  the roster holds **46** tombstoned child ids and 36 live ones. The projection checkpoint for that Session
  carries 30 fold members, **22** of them tombstoned, so the panel's 37 rows are consistent with those 30
  plus the lead row plus rows appended since the checkpoint. After the fix, every one of the 46 tombstoned
  ids leaves both lists wherever it appears — the 22 checkpoint-proven rows are the ones to check first
  (`survey-lifecycle`, `impl-panel`, `impl-session-scope`, `docs-readme`, `spike-messaging`,
  `probe-spawn-caps`, …) — while `impl-config`, `impl-template`, `impl-spawn-caps`, `fix-docs`, `audit-drift`
  and the `-g2` successors stay. Because the overlay adds this plugin's live members back, the **row count**
  may barely move (about 37 either way); the identities are the check, not the number.
- **Documents.** ADR 0025 records the decision (deferred gate, one tombstone set, the synchronous roster
  read, the reported outcome, no hook is fatal); `docs/architecture-en.md` gains rewritten §2.4, a v0.24
  delivery line, two §5 rows and the `list_members` row; the Chinese pair matches. The README pair gains the
  three-effect paragraph, the `host_hooks` sentence on `list_members`, the requirements and install-check
  lines, and the role-not-task sentence in the lifecycle section. The index pair registers ADR 0025;
  `PLAN.md` gains P4-12, ticked because this PR delivers it.
- **What stays unverified.** No install and no `plugin_manager` call was made, and `scripts/check.mjs` never
  loads the Harness. The live install — `list_members` answering `host_hooks.panel_filter: "installed"`, and
  the panel plus `list_agents` actually showing no retired member — is the owner's install check. The
  `agentTeams.listMembers` patch is safe for both shipped callers (`list_agents`, and the disabled
  `wait_agent`'s no-progress check, which only looks at active statuses) and for this plugin's adoption,
  but only a real `list_agents` call proves it. The four frozen names in ADR 0014 and the three
  `cordis.patch.yml` entries were not touched. The locale pair is unchanged: neither file holds a tool
  description, and `scripts/check.mjs` still reports the same two keys per language.
- **Version.** `0.24.0`: a host hook that never installed was a release-level lie; 0.23.0 belongs to another
  branch in flight.

## 2026-11-12 — a member's lifetime is declared, and ending a role asks the person (P4-13, v0.25.0)

- **The rule the owner asked to stop depending on a model remembering it.** A member is a division of
  labour, not a task: ending it is a decision about the role, and a judgement call asks the person first.
  v0.24.0 wrote that sentence into `retire_member`'s description and nothing enforced it. Three defects made
  that worse than an unkept promise: `message_member` deleted the one-shot flag, which silently made a
  one-shot member permanent; `retire_member` had no gate at all; and the sweep could retire a member that
  still owned open tasks, reporting them afterwards as `unowned` — a retirement nobody asked for, orphaning
  work in the same call.
- **Decision recorded in ADR 0026.** A lifetime is declared on the spawn call and nowhere else —
  `standing` (the default) or `one-shot`, with `ephemeral: true` kept as the older spelling and a
  contradiction refused rather than tie-broken. It is never inherited: a `replace` starts its successor as
  `standing` unless that call says otherwise, and a member definition can no longer carry one. The sweep
  needs three conditions at once — started, not resident, and owning no `open` row — and the board is a
  veto, never a trigger. A standing member's `retire_member` refuses until the call carries the person's
  answer quoted verbatim. A message re-opens a one-shot member instead of re-declaring it. A one-shot member
  handed work twice is advised on and never converted.
- **ADR 0013 point 5 is superseded, and ADR 0019 point 3's `ephemeral` row is gone.** The evidence for the
  veto was read out of the installed packages rather than remembered: `@deepseek-ai/dsh-subagent`
  `lib/index.js:2435` produces `activity` as `inactive` whenever the child is not resident, and the
  installed `dsh-experimental-agent-team` README states that `inactive` means "no turn is executing, whether
  loaded or stored" (README.md:62) — so the field describes residency and never an outcome, and a missing
  board row cannot stand in for a finished one either. ADR 0019 had accepted a file-declared one-shot
  successor, whose consequence was that a `replace` handed work over and the successor retired itself; the
  field left the file instead of the consequence getting another paragraph.
- **The stored field is deliberately not renamed.** `ephemeral: true` is what every roster this plugin has
  written already carries, and the storage facility validates every record when it opens the domain, so a
  rename would need a migration over state that is already correct. `lifetime` is the call's and the row's
  vocabulary; `lifetimeOf` is the one translation. `messageCount` and `assignmentCount` are new optional
  counters, written only on a one-shot member, and both are validated on load like every other optional
  field.
- **A replace and the sweep are exempt from the consent gate, deliberately.** Both call the same
  `retireMember` with `consentRequired` false: a replacement continues the role with a new holder rather
  than ending it, and a one-shot member's declaration already was the person's prior consent. A `failed`
  record is *not* exempt — the rule is about the member's declared lifetime, not about its phase, and
  exempting one phase would be a second rule with no reason behind it.
- **The vocabulary on the tombstone moved with the rest.** A swept member's `retireReason` now reads
  `one-shot member: it ran and stopped and owned no open task`. It is display text, nothing parses it, and
  tombstones that already carry the old spelling keep it.
- **How this change was verified.** `node --check` on the six host modules exits 0; `node scripts/check.mjs`
  prints `check passed` after the last edit; and `node --test --test-isolation=none tests/*.test.mjs` is 206
  tests, 206 passing. `tests/ephemeral.test.mjs` became `tests/lifetime.test.mjs` — every case it covered is
  still covered, with the seven decisions added — and `tests/definitions.test.mjs`, `tests/task-board.test.mjs`
  and `tests/entry.test.mjs` were updated for the removed field, the veto and the declared schema fields.
  The consent gate's wiring is proved in `tests/entry.test.mjs`, because the `actions.js` suites pass
  `consentRequired` themselves and would not notice a tool that forgot to set it.
- **The main test was proved able to fail.** With the board veto removed from `sweepEphemeral` (its
  `owned.length === 0` branch widened to `>= 0`, so every eligible member was finished), three tests fail:
  `the board is a veto: an owned open row blocks the sweep` and `the veto keeps the work a one-shot member
  still owns` both answer `true !== false` at their first assertion, and
  `a one-shot successor is held by the work the replacement just handed it` fails the same way. Restored,
  the suite is green. `tests/lifetime.test.mjs` hashed
  `C4F425D9C4F56B8E836C32A0DE86AB2CD05205874C1E014361DBF399C8600D95` before and after that proof — the test
  was never edited.
- **Documents.** ADR 0026 records the decision and its rejected alternatives; `docs/architecture-en.md` gains
  rewritten §4.3.1 (declared lifetimes, the three conditions, the veto's asymmetry, the consent gate, the
  message rule and the advice), a v0.25 delivery line, the record fields, the state and notice matrices, the
  definition matrix and the tool table; the Chinese pair matches. The README pair gains a *Member lifetime*
  section in place of *Ephemeral members*, the new parameters and fields on four tool rows, and the
  install-check line. The index pair registers ADR 0026 and states where a lifetime change belongs;
  `PLAN.md` gains P4-13, ticked because this PR delivers it.
- **One pre-existing drift, corrected in passing.** The README pair's *Current version* line still said
  v0.22.0 while `package.json` had been 0.24.0 since the host-hook release. It now says v0.25.0. Nothing
  else in either README was unrelated to this change.
- **What stays unverified.** No install and no `plugin_manager` call was made, and `scripts/check.mjs` never
  loads the Harness. The live sweep — a real one-shot member finishing and leaving while a standing one stays
  — and a real consent refusal from a real Session are the owner's install check. The four frozen names in
  ADR 0014 and the three `cordis.patch.yml` entries were not touched, and the locale pair is unchanged
  because neither file holds a tool description.
- **Version.** `0.25.0`: a declared lifetime and a consent gate are behaviour, not a comment.

## 2026-11-12 — a record that never became a role needs no consent (v0.25.0, review follow-up)

- **The owner overruled the first reading, and the record above is what it said at the time.** The v0.25.0
  entry argues that a `failed` record is *not* exempt, on the grounds that the rule is about the declared
  lifetime and not about the phase. That reading charges a question for removing a reservation that never
  held a role, so it is now the narrower one: a record in `failed` never started, and one already `retired`
  has no life left to end, so neither goes through the gate at all.
- **What did not change.** A `standing` member that actually ran is `active` while it lives, so retiring it
  still needs the person's words quoted; a one-shot member and a `replace` successor are untouched; and a
  reserved record whose child published is reconciled to `active` by the read, so it is asked about rather
  than assumed. The gate is one condition on two phases, not a second rule.
- **Documents.** ADR 0026 point 6 states the decision and says why the broader reading was rejected;
  `docs/architecture-en.md` §4.3.1 and §4.5 and the Chinese pair match, as do the README pair's exemption
  sentences, the `retire_member` description in `index.js`, and P4-13 in `PLAN.md`.
- **How it was verified.** `tests/lifetime.test.mjs` gains the case: a `standing` + `failed` record retires
  in one call while a `standing` + `active` record still refuses and a reserved record whose child published
  still refuses. The test was proved able to fail — with the `failed` half of the exemption removed, it fails
  at `a failed record is removed without a question` (`false !== true`); restored, green, and the file hashed
  `1899565E2AE8F03DA130ABD05EDDD48A19151545BAE0AE54834CD06755C96830` before and after. `tests/entry.test.mjs`
  adds the required-field proof: an adopted member and a stored record written before v0.25.0 both answer
  `lifetime: "standing"` through the real `list_members` and against its declared schema.
- **The required-field question, answered.** `lifetime` stays required because `memberRow` sets it
  unconditionally from `lifetimeOf`, which answers `standing` for any record without `ephemeral: true` — so
  the two paths that could have omitted it (an adopted member, a record older than v0.25.0) are exactly the
  two the new entry test covers, through the real tool rather than the operation.

## 2026-11-12 — a standing member is asked about only when it carries something (v0.25.1)

- **The live acceptance passed and then the owner widened the gate, in their own words.** *"我觉得我们这方面
  不一定非要做的这么死，可以适当给Lead一些权限让他也能自动判断退役."* With what they had said before — *"如果我说
  文档检查我们暂时不用做了，那就可以询问我的意见，然后退役掉他"* — the two statements draw one line: the gate
  protects the person's decision to end a **role**, not every act of housekeeping. v0.25.0 refused every
  standing record that became a role, which is stricter than the principle it invokes: asking about a probe
  left behind is ceremony, which is exactly what the owner objected to.
- **The rule now.** A standing member is asked about only when it carries something — a recorded
  `assignment`, at least one `open` row on this Lead's board, or evidence it was re-tasked at least
  `RETASK_MIN` times. A member carrying none of the three retires in one call on a non-empty `reason`, which
  the tombstone keeps as `retireReason`; a call stating no reason answers
  `retired: false, reason: 'needs-reason'` with `carries: []` and changes nothing. Both refusals say which
  rule stopped the call, and the successful housekeeping retirement says so in words. No config field and no
  third lifetime value: the narrowing is by what the member carries, so the rule is about the member rather
  than about a profile's policy — a policy field is the next step if this is still too strict.
- **One thing had to move outside the gate for the gate to work.** The third carrier is evidence the record
  did not hold for a standing member: `message_member` counted only one-shot members, so a standing member's
  `messageCount` was permanently zero and "was re-tasked" could never be true for the members this gate is
  about. The counters are now written for every accepted message on every member. What stays one-shot-only
  is the *advice* drawn from them on `list_members`, because "this is probably a standing role" corrects a
  one-shot declaration; a standing member already is one. No stored field was added or renamed, so nothing
  migrates.
- **What deliberately did not change.** `lifetime` and its two values, the board veto, `blocked`/
  `blocking_tasks`/`blocking_note`, the sweep's three conditions, the one-shot and `replace` paths, and the
  `failed`/`retired` exemption. The sweep path was not touched at all, so `swept` still appears on a read
  as well as on a spawn, and the same tests that pin it still pass (`list_members` is the read they use).
- **The omission rule, kept rather than "fixed".** A consent refusal still omits `owns_tasks` and
  `assignment` when the member has neither, because an omitted field reads as "nothing to report" while an
  empty array would read as "checked, found none". The new `carries` field is the one exception and is
  always present: on the housekeeping refusal it is `[]`, and that empty list is the *statement* that the
  member carries nothing — it is the rule being applied, not a missing report. The two conventions are
  documented at the field, in §4.3.1 and in ADR 0026 so a later reader does not "fix" either one.
- **How this was verified.** `node --check` on the six host modules exits 0; `node scripts/check.mjs` prints
  `check passed`; `node --test --test-isolation=none tests/*.test.mjs` is 212 tests, 212 passing. The five
  cases the narrowing needed are in `tests/lifetime.test.mjs`: a bare standing member retires in one call and
  the result says why; a bare one without a reason is refused (`needs-reason`, and a blank reason is not a
  reason); and one case per carrier — assignment, an open row, and two accepted messages — each still
  `needs-confirmation` with `carries` naming it. Widening the gate back to "every standing member" makes the
  bare-member cases fail (verified before and after, with `tests/lifetime.test.mjs` hashed
  `69C1F7DA94F593CA2C9175B6C53DD9D136CBD952295C9491897E33322A6FF42A` on both sides of the proof).
- **One changelog gap, closed here rather than left standing.** `CHANGELOG.md` had no `[0.25.0]` section
  although #48 shipped 0.25.0 and wrote its `PROGRESS.md` entry: the file landed in #47, after #48 was
  written, and the section was not added when #48 rebased onto it. This PR adds both `[0.25.1]` and the
  missing `[0.25.0]`, whose bullets are derived from the matching `PROGRESS.md` headings the way the file's
  own header requires — including the v0.25.0 follow-up entry as a second bullet, the same way 0.12.0 keeps
  its follow-up.
- **Documents.** ADR 0026 gains *The gate narrows to what a member carries* (with the earlier, stricter
  reading kept as the record), new rejected alternatives — a policy config field, a third lifetime value,
  keying on the phase, an optional reason, counting assignments only — and the consequences; §4.3.1 carries
  the carrier table and both refusal shapes, §4.2 the widened counters, §4.4 step 0 and the §4.5 rows the
  narrowed rule; the Chinese pair matches. The README pair states the carrier rule in *Member lifetime* and
  in the `retire_member` row. `PLAN.md` gains P4-14, ticked because this PR delivers it.
- **What stays unverified.** No install and no `plugin_manager` call was made, and `scripts/check.mjs` never
  loads the Harness. The live half is the owner's install check: a real bare standing member retired in one
  call on a stated reason, a real refusal that names its carrier, and the `needs-reason` refusal appearing
  in a live Session.
- **Version.** `0.25.1`: the gate's scope is behaviour, and narrowing it is a patch rather than a feature.

## 2026-11-13 — the pair check is a rule over docs/, not a list of pairs (v0.25.2)

- **The defect was a list where a rule was claimed.** `scripts/check.mjs` held three hardcoded pairs, so a
  new `docs/foo-en.md` whose `-zh.md` was never written was simply not in the list and the check said
  nothing. The external review's third point named the live evidence: `docs/upstream-lifecycle-gap.md` is a
  single-language document the check had never examined, and nobody could tell whether that was deliberate
  or an oversight. Both readings were bad; the fix is to make the file declare itself either way.
- **What replaced it.** The check now reads the top level of `docs/` and classifies every `*.md` there:
  `name-en.md` must have `name-zh.md` (and the reverse), `name-en-zh.md` is one file carrying both
  languages, `name.md` is deliberately single-language and listed with a reason, and `docs/adr/NN-name.md`
  is out of scope because a decision is English-only and numbered. A file the rule cannot classify fails by
  name, which is the property the list lacked: a new document cannot escape by not being added to it.
- **Trap one, and why the suffix is not evidence.** `*-en-zh.md` also ends in `-zh.md`, so a naive reverse
  scan calls a two-column glossary "missing an English version". It is matched first and then asserted by
  content: the file must contain a CJK character **and** a real Latin word. The advance review's suggestion
  was to assert it "contains a Chinese column"; asserting both languages is the part that can actually fail.
- **Trap two: the exception is a list you must edit, on purpose.** The alternative was a naming convention
  (no language suffix means single-language by choice), which reads well until someone drops a suffix to
  pass the check without deciding anything — and it records the fact without the reason, so the next reader
  is back to guessing. The allow-list records the reason next to the file, fails closed for anything not on
  it, and refuses a stale entry: the list cannot outlive the document it describes. One entry today,
  `upstream-lifecycle-gap.md`, because that document is the issue-ready statement of the gap addressed to the
  English-language upstream tracker — a Chinese copy would be a second document to keep in step, not a
  translation of it.
- **Trap three: root documents were kept explicit.** The scan is scoped to `docs/`, which is what keeps it
  away from `README-zh.md` (it ends in `-zh.md` too, and would otherwise read as "missing an English
  version"). The README pair is checked by name, because `README.md` is the one English document without an
  `-en` suffix, and the other root documents are single-language by the policy in `CONTRIBUTING.md` §6. The
  root list is stated once and is also what the machine-path scan walks, so "which documents exist" and
  "which documents are single-language" stay one question.
- **CONTRIBUTING.md now states the rule** next to the existing document rules, including the four shapes and
  why the allow-list beat the naming convention, so an author meets the rule before the check does.
- **How this was verified.** `node scripts/check.mjs` prints `check passed`; `node --test
  --test-isolation=none tests/*.test.mjs` is 212 tests, 212 passing (no test file was touched). The rule was
  proved able to fail on all four branches, each failure naming its file: a temporary
  `docs/zz-pair-probe-en.md` produced `has no docs/zz-pair-probe-zh.md`, and deleting it returned
  `check passed`; the reverse probe `docs/zz-reverse-probe-zh.md` produced `has no docs/zz-reverse-probe-en.md`;
  an undeclared `docs/zz-plain-probe.md` produced the "single-language document with no declaration"
  refusal; a `docs/zz-both-en-zh.md` holding only English produced the "no Chinese text by content" refusal,
  and the same file with a two-column table passed; and a temporary stale entry in the allow-list produced
  "declared single-language but does not exist". Every probe was deleted, `docs/` holds exactly the five
  files it started with, and `scripts/check.mjs` hashed
  `A98F2B9F2BAE655F2E92DAC2AB442698A0F95436ECD4F9B05913FE90FB6FA4BB` before and after the probe session,
  so the script was not left carrying a probe.
- **Scope.** Only `scripts/check.mjs` and `CONTRIBUTING.md` changed in code and rule; no file under `docs/`
  was created, edited, moved or deleted beyond the temporary probes, which is also why the parallel split of
  `docs/` is unaffected and will be classified by the new rule as soon as it lands.
- **What stays unverified.** Nothing about the plugin: this is a repository check, and `check.mjs` still
  cannot prove the plugin activates. The rule has not yet met a `docs/` tree other than today's, so the
  parallel split branch is its first real test; if it adds a document the rule cannot classify, the check
  will say so by name and the entry belongs in the allow-list with its reason.
- **Version.** `0.25.2`: a check that ignores new files is a promise the repository was not keeping.

## 2026-11-13 — the architecture document splits by subject (v0.25.3)

- **One filename carried five documents.** `docs/architecture-en.md` was 1167 lines, 1010 of them
  non-blank, and 110 KB: a reader who started at the first line had forgotten it by the thousandth, and
  changing one behaviour meant finding passages far apart in one file. It is now five bilingual pairs —
  `member-lifecycle` (311/132 lines), `task-board` (91/58), `handoff` (124/52) and `roster-storage`
  (109/83) — and `architecture-` (610/279) keeps the layers, the Harness substrate, the released surface
  and the risks, which is what its name says. The external review's first point is what this answers.
- **Four subjects moved and three stayed, each for a stated reason rather than by line count.** The
  model-facing surface stayed in `architecture-` (§4.5 → §5) because its table has one row per tool and
  those rows span every subject, so moving it would mean cutting rows mid-sentence. Member definitions
  stayed (§4.6 → §6), together with the definition-precedence matrix (§4.3.3 → §6.1), because they are one
  subject with ADR 0018 and ADR 0019 and were not on the review's list. The release map stayed because it
  is the index of the design, not a subject of it. That judgement is the whole change: the review's own
  criterion was "split where changing one behaviour means editing several far-apart passages", not a row
  count, and a fifteen-line file is not worth opening.
- **The retirement protocol could not move whole, so a section was divided rather than relocated.** Its
  retention step became `roster-storage` §3, with a one-line pointer left in its place so the protocol
  keeps the step numbers its own prose and the ADRs cite; its brief-shape block became `handoff` §1; the
  protocol itself is `member-lifecycle` §3. The same was true of §4.2, whose record block went to
  `roster-storage` §1 while its task and template passages went to `task-board` §1/§3 and `handoff` §3.
- **The move is byte-identical, and that is proved rather than asserted.** Every destination was assembled
  from line ranges of the source, and a tiling assertion shows every non-blank line of both languages
  landing in exactly one destination: 1139 English lines and 532 Chinese lines, none lost, none
  duplicated. A second assertion pins the list-marker count at 64 per language — it caught a real defect
  in the generator's own re-flow pass, which had folded the release list into a single paragraph, and it
  exists so that class of damage cannot ship quietly again.
- **Every section of the old document is accounted for.** All 26 headings are present in the new document
  set, moved, renumbered, renamed (four) or superseded (the old `## 4. v0.2, in progress` heading). The six
  headings with no counterpart are exactly the sub-sections created because a section carrying several
  subjects was divided, which is what a subject split is supposed to produce.
- **The references were the real work, and a machine checked them.** 188 section references across 44
  documents resolve, in both languages: a path-qualified reference resolves inside the document it names,
  and a bare one either continues the citation before it or resolves in its own document. 27 references
  were retargeted in ADR 0008, 0009, 0011, 0013, 0017, 0019, 0022, 0024 and 0026, `PLAN.md` and
  `docs/upstream-lifecycle-gap.md`, plus the index pair's document map, reading order and coupling table,
  the README pair's pointer and `AGENTS.md` §4.8, which names the document the state matrix now lives in.
- **`upstream-lifecycle-gap.md` lost the line ranges in its citations, and they were already wrong.** It
  cited `docs/architecture-en.md:170-175` for §4.1, a section that spans 293-343: the ranges had rotted
  before this change and any edit moves them. A section number is the locator that survives an edit, so
  the ranges were dropped rather than recomputed. It is the only prose edited beyond heading renumbering
  and the cross-reference rewrites the split forced.
- **Parity was measured per pair before and after, not assumed.** Before: 3 pairs, 55 headings per side.
  After: 7 pairs, 64 headings per side, none divergent — README 23/23, `INDEX` 6/6, `architecture` 26/26
  (h1=1 h2=6 h3=13 h4=6) → 18/18 (h1=1 h2=8 h3=8 h4=1), and 5/5, 4/4, 4/4, 4/4 for the four new pairs.
  Locale keys are unchanged at two per language. `node scripts/check.mjs` prints `check passed` and the
  suite is 212 tests, 212 passing.
- **The new pairs are inside the rule that landed while this was being written.** `main` moved to
  `b3a94f9` (v0.25.2) mid-branch, which replaced the hardcoded pair list with a directory scan. This
  branch had added four entries to the old list; the scan classifies them without an edit, so the merge
  took main's `check.mjs` and dropped those four, and the merge commit records why. Proved again on the
  merged tree: moving `docs/member-lifecycle-zh.md` aside makes the check exit 1 with
  `docs/member-lifecycle-en.md: has no docs/member-lifecycle-zh.md (bilingual pair)`, and restoring it
  prints `check passed`.
- **What stays undone, and where it goes next.** The checker that proves a `§X` citation resolves lives
  outside the repository in the session's scratch folder. A citation to a section that does not exist is
  the defect class that already bit this project once, when ADR 0025 was cited in 17 places before the
  document existed, so it is assigned to its own small PR rather than folded into this one. Nothing about
  the plugin changed, so nothing here needed an install: `check.mjs` still cannot prove the plugin
  activates, and this release does not pretend otherwise.
- **Version.** `0.25.3`: a reader asking six months from now which release split the architecture document
  should find the answer in the changelog, and PR 47 set the precedent that a documents-and-manifest
  change still ships a version.


- **The defect was not length, it was order.** `README.md` was 651 lines (559 non-blank) across 23
  sections, and `Install and verify` was the eighteenth, at line 526: a stranger had to scroll past four
  hundred lines to learn how to install the thing. The owner's verdict was that it had become too long,
  and the length was a symptom — depth had migrated out of the README while the README kept its copy.
- **One criterion was applied to every section, not a table taken on trust.** *Delete the section: can the
  reader still find it from README's pointer table?* Eight sections passed it and were deleted or cut
  down, one failed it and had to grow a home first, and one was kept because it is not depth: `Limits and
  deliberate omissions` is why the project is trustworthy, so it stayed verbatim. The measurements were
  taken again rather than reused — the owner's reading of the section table was accurate to within four
  lines, but it is a reading and the counts here are from the file.
- **Four subjects left for the documents that already owned them.** The tool table became eleven one-line
  rows pointing at `docs/architecture-en.md` §5, which is the authoritative version; `Defining a member`,
  `Member lifetime`, `Replacing a member` and `The lifecycle` became the smallest example or the two-line
  judgement plus a pointer to `member-lifecycle`, `handoff`, `task-board` and `roster-storage`. That is
  what the split in `0.25.3` was for: a subject with a document of its own does not need a second,
  shorter copy in the README, because the two drift.
- **Two subjects got a home, because they had none.** `Costs and model routes` is 75 lines of measured
  billing behaviour that answered a real confusion, and the upgrade table is reference material for the
  moment someone upgrades; neither belongs in a first-use document, and neither had a document. They are
  now `docs/routes-{en,zh}.md` and `docs/upgrading-{en,zh}.md`. Both are **pairs** rather than the
  `-en-zh.md` two-column shape: that shape is for a term table where the two languages sit side by side
  line for line, while these carry prose, citations by file and line, and code spans, which a two-column
  document would mangle. The routes document keeps the measurement that caused it — 18 of 60 session logs
  still on the old route — because that is the fact that makes the section worth reading.
- **`Status` was a changelog in disguise.** 66 lines of per-release verification prose became 14: what has
  been exercised in a profile, what is unit-tested only, what nothing here can prove, and where the two
  lists live. The prose itself was not lost: `PROGRESS.md` keeps one entry per release and every entry
  records what that release proved live, so the claim now points at the evidence instead of restating it.
- **What stayed is deliberate.** `Limits and deliberate omissions` (34 lines) is the section that tells a
  reader what the bundle will not do and why each of those was decided, which is a different kind of
  statement from depth; `Configuration`, `Requirements and compatibility`, `Development`, `Repository
  layout` and `Model-facing only` are first-use or first-debug material and stayed, in that order, after
  the install path.
- **The Chinese side is Chinese prose, not a translation.** Both sides are 13 headings and the same six
  table shapes, but the Chinese text was written to be read as Chinese and says the same facts in its own
  sentences — a word-for-word rendering of English sentence structure is what made the old pair tiring to
  read in either language.
- **How this was verified.** `node scripts/check.mjs` prints `check passed`, which now also classifies the
  two new pairs by the `docs/` rule, and `node --test --test-isolation=none tests/*.test.mjs` is 212 tests,
  212 passing (no test file was touched). Parity per pair, heading sets per side: `README` 23/23 before and
  13/13 after, `INDEX` unchanged at 6/6, the five design pairs unchanged, and the two new pairs 4/4 and
  3/3 — every pair matches, 0 divergent. Reachability was checked by search rather than by eye: for each
  section the README dropped, the PR body carries the grep that finds its subject in the document the
  pointer names.
- **What stays unverified.** Nothing about the plugin: no JS, locale, patch or config file was touched, so
  no install was needed and `check.mjs` still cannot prove the plugin activates. The README's own claims
  are unchanged facts, restated — this release moves them, it does not re-measure them.
- **Version.** `0.25.4`: the README is the first thing a stranger reads, and its install path moved from
  the eighteenth screen to the second; `0.25.3` belongs to the split this one builds on.

## 2026-11-13 — the live sweep and the consent gate, accepted on the running profile

- **What this entry is, and why it exists.** The owner ran the acceptance for the one-shot sweep and the
  consent gate on 2026-11-13 against `v0.25.0` / `v0.25.1`, and the values below are his to attest. It is
  recorded here because the claim had no source in this file: the `v0.9.0` entry says the bundle was not
  installed and lists the two-member sweep as the pending check, and every entry since then listed "a live
  sweep and consent refusal" as the owner's install check. The claim was true; nothing had written it down.
  That `v0.9.0` wording stays exactly as it stands — this file is append-only, and what it says was true
  when it was said.
- **The sweep, from a spawn.** `spawn_member` with `ephemeral: true` returned `swept: 1` with
  `swept_targets: ["oneshot-acceptance"]`. The stored record for that target then read `phase: "retired"`,
  `retiredAt`, `retireReason: "one-shot member: it ran and stopped and owned no open task"` and
  `trashState: "done"`, and the child's session directory had **moved** into
  `~/.dsh/team-roster/trash/<lead>/` — the original path no longer existed, so this is a move and not a
  copy.
- **A read sweeps too.** `list_members` returned `swept: 1` with `swept_targets: ["read-sweep-probe"]`, and
  that row was already `phase: "retired"` in the same payload.
- **The board veto, both halves.** A spawn returned `blocked: 1` with
  `blocking_tasks: ["6ec387f9-cd26-42a9-8733-2a461725dfbd"]`, `blocking_note` naming the one clearing call,
  and **no** `swept` field at all. After that row was closed, the next spawn returned `swept: 2` with
  `swept_targets: ["oneshot-veto", "veto-trigger"]`.
- **The consent gate, both halves.** A standing member retired in bare words, with no confirmation,
  answered `retired: false` with `reason: "needs-confirmation"` — and **nothing moved**: the record was
  still `active` and no trash entry existed. The retry, carrying the person's sentence verbatim, answered
  `retired: true` and echoed that sentence back into the result.
- **A fact about the surface that this run corrected.** A refusal emits `owns_tasks` and `assignment` only
  when the member actually carries them; omitting them is deliberate, because an empty array would read as
  "checked, and found none". The brief that commissioned the verification demanded they always appear — the
  code was right and the brief was wrong.
- **What it does not change.** No code: this is an acceptance run against `v0.25.0` / `v0.25.1`, both
  already released. It is the evidence behind the README's status list, and its date is what the README now
  cites instead of describing the run itself.
## 2026-11-13 — Every in-repository citation resolves, or the check says which one does not (P4-17, v0.25.5)

- **The defect class this closes, and its two proofs.** ADR 0025 was cited from about seventeen places in
  `roster.js`, `actions.js` and the architecture document before that ADR existed, and nothing noticed until
  a read-only survey grepped for it. The checker written for that class during the document split lived in a
  session scratch folder, where it could not fail anyone's pull request. Both are now one numbered section of
  the repository's own gate.
- **What was built.** `scripts/check.mjs` §7 follows two forms: a document reference — `docs/<name>.md` in
  prose or a link — must exist, and a section reference — §N, §N.M, §N.M.K — must resolve to a numbered
  heading in the document it points at. Which document that is follows four steps, in order: the document the
  same citation names (`` `docs/x-en.md` §4.5 ``, "§4.5 of `docs/x-en.md`", the short stem form the split
  introduced — `member-lifecycle §3` — a markdown link, "[docs/x-en.md](docs/x-en.md) §5", and a
  continuation after a separator, "§4.5 and §4.5.2",
  "§4.2/§4.3/§4.4"); failing that, the document the reference appears in, when it has the heading; failing
  that, the one English document at the top level of `docs/` that has it, when exactly one does; and failing
  all three, it fails and says so rather than picking one. A bare § that two documents both have is reported
  as ambiguous, with both named. The link form was added while this branch was being merged: the README pair
  names its document that way, the resolver read only the backticked and stem forms, and the result was a
  correct citation reported as an ambiguity between `docs/architecture-en.md` and `docs/INDEX-en.md`. The
  document-reference pass had always accepted a link, so the repair was to make the section pass agree with
  it rather than to rewrite prose that already named its document plainly.
- **Three decisions about what is *not* checked, each with its reason.** `PROGRESS.md` and `CHANGELOG.md` are
  exempt: an entry that cited a section before it moved is correct as of the commit that wrote it, and
  re-checking history would force edits to a record that may not be rewritten. A section reference into a root
  document is checked as a document reference only — `AGENTS.md` numbers its points in prose, so "§4.8" is the
  eighth point of §4, and the heading test would call a correct citation wrong. The six host modules *are*
  read, because their comments cite these documents and are current-state commentary rather than history —
  seven section references and two document references between them at the time of writing — while `scripts/`
  is not, since its `docs/` strings are patterns rather than citations.
- **What the check found on the merged tree, which is the point of it.** Six citations the document split had
  left pointing at sections that no longer exist anywhere, and one placeholder of this repository's own:
  `actions.js` cited `docs/architecture-en.md` §4.3 and §4.3.1 twice each, `roster.js` cited §4.4 and §4.3,
  and ADR 0021 cited §4.3.2; the sections had moved to `docs/member-lifecycle-en.md` §1 and §2,
  `docs/handoff-en.md` §1 and `docs/task-board-en.md` §2, which the change map in `docs/INDEX-en.md` §4
  records. The placeholder was `docs/foo-en.md` in this file, now written `docs/<name>-en.md` so a pattern
  cannot be read as a citation. Each fix is a citation only: no sentence was reworded, and nothing about the
  plugin changed. Every other ADR citation had already been rewritten by the split, which is what makes
  0021's an oversight rather than a convention.
- **Verification.** `node scripts/check.mjs` prints `check passed`; `node --test --test-isolation=none
  tests/*.test.mjs` is 212 tests, 212 passing (no test file was touched). The rule was proved able to fail
  twice on the real tree, and the exact text is quoted here because the message is the deliverable: a
  temporary line in `CONTRIBUTING.md` reading "`docs/architecture-en.md` §99" produced
  `CONTRIBUTING.md: docs/architecture-en.md has no §99`, and one reading "`docs/zz-missing-document-en.md` §1"
  produced `CONTRIBUTING.md: cites docs/zz-missing-document-en.md §1, but docs/zz-missing-document-en.md does
  not exist` and, from the document-reference pass, `CONTRIBUTING.md: cites
  docs/zz-missing-document-en.md, which does not exist`. Both probe lines were removed and the tree returns to
  `check passed`; `scripts/check.mjs` hashed
  `E728A7F5E7C9565EAA1EFDA0E836B688AB14814600F8A30E22F1927035E68268` before and after the proofs, so the
  script was not left carrying one.
- **What stays undone, and what would make it sure.** A section reference that exists in exactly one document
  but was meant for another still resolves — `PLAN.md`'s "the external review's §3" reads as its own §3 — and
  no mechanical rule can tell, so the check only promises that a citation *can* be followed. The check has met
  one `docs/` tree, the one it was written against; it has not seen the next rename.
- **Version.** `0.25.5`: the repository promised that a citation resolves, and this is the release where that
  promise is kept by something other than the reader's patience. (The README rewrite claimed `0.25.4` and
  `P4-16` while this branch was open, so both numbers moved; the collision is recorded in the merge commit.)

## 2026-11-13 — the architecture pair points at the document that holds the statement (v0.25.6)

- **The defect, and why no check could have caught it.** `docs/architecture-en.md` §2.5 closed with "The
  user-facing statement is in the README pair." That was true when it was written, and `#52` made it false:
  the README no longer states the costs and the routes, it links `docs/routes-en.md` (`README.md:112` and
  `:249`), which is where those statements now live. Every mechanical rule in `scripts/check.mjs` passed while
  this was wrong — it proves that a citation resolves and that two sides carry the same headings, and it has
  nothing to say about a prose claim concerning what another document contains. It was found by reading, which
  is the gap the checker's own section names as deliberately out of scope.
- **The fix is two sentences, one per side.** `docs/architecture-en.md:262` now names `docs/routes-en.md`, and
  `docs/architecture-zh.md:132` names `docs/routes-zh.md` — each pointing at its own language's document, which
  is how this file already cites every other pair member. Nothing else in either paragraph moved, and the two
  `§2.1` references in it were not touched.
- **The premise was re-verified on `main` before editing rather than taken from the brief.**
  `git grep -n "Costs and model routes" main -- README.md` returns nothing; `git grep -n "routes-en.md" main --
  README.md` returns `README.md:112` and `README.md:249`; and `docs/routes-en.md:74` and `:80` hold the
  statements that section used to carry.
- **Verification.** `node scripts/check.mjs` prints `check passed` and
  `node --test --test-isolation=none tests/*.test.mjs` is 212 tests, 212 passing, with no test file touched.
  The check is explicitly **not** treated as evidence for the claim here, because it cannot be. The search that
  stands in for it is `git grep -n "README" -- docs/ ':!docs/adr/*'`, whose remaining hits are `docs/INDEX`
  rows listing which documents to update — still true, the README keeps the install path and the short tool
  table — and citations of an installed package's own README.
- **One finding of the same class, deliberately not fixed.** `docs/adr/0024-forward-the-lead-route.md:160-161`
  says the README's member section names the replacement as the way to clear a stale member, and the README
  contains no `route_stale` at all. The bullet records what `v0.22.0` updated, and an accepted ADR is a closed
  record: it was true of the tree that commit wrote. Rewriting it is the thing the ADR rules forbid, so it
  stands as history and the current statement is in `docs/routes-en.md`.
- **Version.** `0.25.6`: a correction to where the architecture pair sends a reader, which changes released
  documentation even though no code moved.

## 2026-11-13 — a retirement tombstone stores where its artifact went, not where the root was (v0.26.0)

- **The defect this removes before it can happen.** A tombstone recorded the **absolute** path its artifact
  was moved to, and two readers trusted it: restore moved it back from that path, and the per-Lead retention
  cap matched recorded paths against the directory it scanned. Both break the moment the data root moves —
  restore fails, and the cap silently stops pruning because nothing it recorded lives under the new root any
  more. That is the failure the data-location plan exists to prevent, and this release is the enabler: it
  changes the record and the readers, and **moves nothing**.
- **The new shape, and the one field that stays absolute.** A record now carries `trashDir` — the name
  retirement gave the directory — and `trashRelPath`, where it sits under the data root. The absolute path is
  computed when it is read. `originalPath` deliberately stays absolute: it points into `~/.dsh/sessions`,
  which is the host's tree and does not move with this plugin's data, so it has no root to be relative to.
- **The directory name is the part that survives a move, so it is the key.** `recordedTrashDir` reads the
  name from either stored shape — `trashDir` from this release, or the last segment of an older `trashPath` —
  and `pruneLeadTrash` now matches tombstones by that name instead of by a recorded path. The cap therefore
  keeps working across a move and keeps working for the 94 records already on disk, with no migration.
- **Restore tries three legs, in a fixed order, and stops at the first that exists.** The data directory in
  effect (rebuilt from the name when the record carries a name but no relative path), then the absolute path
  the record itself carries, then the frozen `~/.dsh/team-roster`. Duplicates are dropped, so the ordinary
  case yields one candidate per leg rather than two. Nothing throws: no leg holding the artifact is reported
  as `trash-missing`, which is what a `pruned` record already answered.
- **Measured against the real roster before it was merged, read-only.** 94 tombstones carry a trash field:
  28 answer `pruned`, 20 resolve at the first leg from the root configured today, 46 are `done` with no
  artifact left on disk, and **none throw**. Swapping the root for a directory that holds no data moves all
  20 from the first leg to the legacy one, which is the whole point of the change. 28 + 46 is the 74 dangling
  records the plan measured earlier.
- **Proved able to fail, then restored.** Deleting the legacy leg kills exactly three chain tests — the
  expected array loses the `legacy` entry, `actual` is `undefined`, and a record carrying nothing but an
  absolute path restores `false` instead of `true`. Writing the tombstone back to `trashPath` fails one test
  in `retention.test.mjs` and one in `handoff.test.mjs`. Both probes were reverted and the full suite re-run.
- **`actions.js`, `index.js` and one comment in `roster.js`.** Both retirement writes record the new fields;
  `trash_path` in a tool result is the resolved absolute path; the `pruned` refusal prints the location it
  computed rather than one it found. `restoreMember` gained a `dataDir` and the `restore_member` wrapper
  passes the directory the plugin resolved at install. No stored field was renamed, so the load path did not
  change. `tests/handoff.test.mjs` asserted `typeof record.trashPath === 'string'`, which the new shape must
  break, so that assertion moved with it.
- **What is deliberately left to the data-location documents.** `docs/roster-storage-{en,zh}.md` still
  describes the old field and the `pruned` paragraph; `docs/member-lifecycle-en.md` §4 and the Chinese §4.4
  still list `trashPath`; each README still names it once; and ADR 0011 §6, ADR 0014's absolute-path
  paragraph and ADR 0009's comparison sentence are **accepted records** that a new ADR supersedes rather than
  an edit. All of it is the document phase's work, listed in the PR body so none of it is invisible.
- **What is not proved.** The `index.js` line that passes `dataDir` into the wrapper is covered by nothing:
  the unit tests call `actions.js` directly. It reads correctly — it passes the directory the plugin resolved
  at install, the same one the rest of the plugin uses — but only a live `restore_member` call proves it, and
  the bundle was not installed for this release.
- **Version.** `0.26.0`: a stored record shape changed. Nothing a user does behaves differently today, and
  the old shape keeps loading, but a file on disk now carries different fields, which is not a patch.

## 2026-11-13 — the lifecycle-gap statement becomes a pair, and the pair rule loses its last exception (v0.26.1)

- **The owner read the inventory and spotted it; the rule said it was legal, and that was the problem.** He
  said the filename did not match the convention. It did: `CONTRIBUTING.md` documents `docs/name.md` as one
  of four legitimate shapes — deliberately single-language, listed in `SINGLE_LANGUAGE_DOCS` with its reason —
  and this file was listed. What was actually wrong is that it was the **only** file using that shape, and
  `docs/INDEX-en.md` advertises it: the `Language` column read `pair` on eight rows and `English` on this
  one. `docs/` is defined as design documents, English as the source of truth, and this document's own
  second and third sections are statements about *this repository's* design — so the exception was keeping a
  document a Chinese reader needs out of reach, for a reason (its audience is the upstream tracker) that is
  about who reads it rather than what it is.
- **So the exception was removed rather than renamed around.** `git mv` to `-en.md` (the commit records the
  rename at 100% similarity, so history follows), a new `-zh.md` written as Chinese prose with the same six
  headings and its citations pointing at the Chinese pair members, and `SINGLE_LANGUAGE_DOCS` is now empty.
  **The mechanism stays**: the shape is still documented as legal, and an escape hatch that carries its
  reason is what makes the next exception visible in review. Both indexes moved their row to the new
  filename and their language cell from `English` to `pair`.
- **The rule was proved able to fail, and then the proof was proved.** Moving the `-zh` half aside exits 1
  with exactly `docs/upstream-lifecycle-gap-en.md: has no docs/upstream-lifecycle-gap-zh.md (bilingual pair)`
  and `docs/INDEX-zh.md: cites docs/upstream-lifecycle-gap-zh.md, which does not exist`; restoring it returns
  `check passed`. **The first attempt at that probe did nothing at all** — its scratch directory did not
  exist, so the move failed silently and the check passed for the wrong reason. The implementer caught it and
  ran it again against a real directory, which is the whole reason a probe has to be seen to fail.
- **My brief was wrong and the PR says so in two lines of `PLAN.md`.** I told the scribe not to touch
  `PLAN.md`, but `scripts/check.mjs` scans it, so the rename made `check passed` impossible: `PLAN.md: cites
  docs/upstream-lifecycle-gap.md, which does not exist`. Rather than hand over a red PR it corrected the two
  lines that were forced — the path, and the sentence that said the allow-list had one entry — and changed
  no task text, no checkbox and no other wording. A prohibition that contradicts the gate is my error, not
  its deviation.
- **Two comments in `scripts/check.mjs` still named the old path as if it were current**, which the scribe
  reported rather than fixed because they read as statements about the past. That is a fair reading, and
  they were still a dead reference: the Lead made them explicit at merge — "the one unpaired document that
  existed then, `docs/upstream-lifecycle-gap.md` — a real pair now" — so a search for the old path finds the
  explanation instead of nothing.
- **Verification.** `node scripts/check.mjs` prints `check passed` with the pair rule now applying to this
  document in both directions, and `node --test --test-isolation=none tests/*.test.mjs` is 220 tests, 220
  passing, with no test file touched.
- **What is left undone.** `PROGRESS.md`'s own six references to the old filename stay exactly as they are:
  this file is append-only, an entry that cited a path before it moved is correct as of the commit that
  wrote it, and the citation check deliberately does not scan this file or `CHANGELOG.md` for that reason.
- **Version.** `0.26.1`: a document was paired and an exception retired. No behaviour, no shipped file.

## 2026-11-13 — the roster is this plugin's own file under the workspace, and the storage domain becomes the import and the rollback (v0.27.0)

- **What this changes, and what it deliberately does not.** The durable record moves out of the host's
  storage domain and into a file this plugin owns: `roster.json` under `.agents/team/` in the Lead's
  workspace, beside the memory notebook, with the trash under the same root. The domain is demoted to
  **one-time import source and rollback path**: never written once the file exists, never deleted, and
  deleting `roster.json` puts the plugin back on it. **This release moves no data.** The import happens the
  first time a Lead binds, so the real roster arrives in the workspace on the next tool call rather than
  during this merge — and the trash migration is still T3.
- **The binding is in memory, and the reasoning matters more than the code.** A session's working directory
  can change while it runs, so resolving the root per call would move the data out from under a running
  Lead. The first resolution binds, keyed by Lead Session id, and nothing a `working_directory` call does can
  reach it. It is **deliberately not persisted**: a file recording the binding would itself live somewhere
  the current directory decides, so it could not settle the question it was written to answer, and after a
  restart the host's own `session.header.cwd` is a better starting point than a stale absolute path. What is
  durable is the roster file at the bound root, and that is what a later process reads. A session whose
  workspace cannot be known answers `undefined` and **keeps using the storage domain rather than inventing a
  location**, which is also why a profile without a workspace behaves exactly as it did before.
- **The single-writer rule is documented and detected, with no lock file.** Two Leads in one workspace share
  the file by design; a lock would add a stale-lock failure mode nothing cleans up. Every write re-reads
  first, so a concurrent change is merged rather than clobbered, and a serial this process did not write is
  reported as `foreign_write_at`. Detection follows this process's next read or write, not the instant the
  other writer writes — an honest limit, stated in the document rather than implied.
- **The import was tested against the real thing.** `tests/fixtures/team_roster.json` is a byte-for-byte copy
  of `~/.dsh/storages/team_roster.json`, so the test asserts the shapes that actually exist: two Leads, 100
  records on one (95 retired), 94 carrying a trash path, 3 tasks. It reloads from a **empty** domain and still
  reads 100 members, which can only hold if the records came from the file. It is 1,922 lines and carries 188
  absolute Windows paths — kept rather than sanitised, because those paths *are* the legacy shape T1 taught
  the readers to accept and T3 will rewrite, and a hand-trimmed fixture would stop testing the real scale.
- **Nine tests, and the 220 that were already there are the regression.** Every `apply` fake in the existing
  suite has an empty `session.header`, so all 220 still take the storage-domain path — unchanged behaviour
  for a profile without a workspace, proved by the tests that were written before this existed and were not
  edited. The three probes that were meant to fail did: a non-atomic replace fails the crash test, re-resolving
  on every bind fails the binding test, and dropping per-record validation fails the fallback test.
- **This crossed from the code lane into the documents, and that was accepted.** The single-writer decision
  was owed to a document in this phase, and `docs/roster-storage-*` is the document that records the storage
  shape — the shape this release changes. §4 was added to both sides in the same commit, and the Chinese side
  carries every point rather than a summary of them.
- **The domain file was written again between the plan's baseline and this work, and the difference is now
  explained rather than mysterious.** A copy taken at 10:07 was 104,721 bytes and one taken at 11:05 was
  105,338. The line diff shows only the Lead's own `message_member` traffic: five standing members' recorded
  assignments gained a `Currently: …` sentence, `messageCount` and `assignmentCount` incremented, and
  `updatedAt` moved. No record was added, removed or reshaped; the counts are identical. **The consequence for
  T3 is that the 10:07 backup is stale**: the live plugin keeps writing that file as the team is used, so the
  migration must take its own backup immediately before it runs and must re-measure rather than reuse these
  numbers.
- **What is not proved.** The two new wires in `list_members` live in `index.js`, which no unit test loads:
  that it reports `storage.source: "file"` and the workspace path, and that a real session's
  `session.header.cwd` actually carries a value. One live call after this merges settles both, and it is worth
  making because if the header has no cwd the symptom is `storage.source` staying at `storage-domain` —
  visible, never silent, but only visible to someone who looks.
- **No new configuration field, deliberately.** The root is overridden by the two environment variables that
  already exist, and otherwise follows the workspace. A `workspaceDir` knob of the kind `dsh-memory` has was
  not added: it would need a patch row and two documents, and nobody has asked to set it.
- **Version.** `0.27.0`: where durable state lives changed. Nothing a user does behaves differently, the old
  domain keeps loading, and the change is reversible by deleting one file — but a new file appears on disk and
  `list_members` gained a field, which is not a patch.

## 2026-11-13 — the retention cap flips the record it emptied, instead of an id parsed out of the directory name (v0.27.1)

- **The defect, and how it stayed invisible.** The cap deletes an artifact and then flips its tombstone to
  `pruned`, which is what lets `restore_member` answer `reason: 'pruned'`. The flip compared an id parsed
  out of the trash **directory name** — the **child Session id** — against the roster's **memberId**. Those
  are two different uuids for every member a spawn created and equal only for an adopted one, so for spawned
  members the bytes were deleted and the record stayed `done` forever. **Pre-existing**: a probe reproduced
  it identically against `main` before T1, and T1 then rewrote precisely that block.
- **Confirmed live before it was fixed, not just argued.** Two Lead-scope calls on the shipped release:
  `restore_member survey-lifecycle` — an adopted record, `pruned` — answered
  `{"restored":false,"reason":"pruned","message":"… was pruned by the trash retention cap: the artifact at
  …\\3d21e806-…-1794452491223 is gone, so the record stays retired…"}`, and `restore_member eph-alpha` — a
  spawned record whose bytes the cap had deleted — answered
  `{"restored":false,"message":"Nothing was moved back: trash-missing. The record stays retired."}` with
  **no `reason` field at all**. Both moved nothing: the trash held 20 directories before and after, and the
  roster 100 records at 5 active and 95 retired.
- **The data predicted it before either probe did.** Of 94 tombstones carrying a trash destination, 28 are
  `pruned` and **all 28 have `memberId == childId`**; **none** of the 63 spawned records is `pruned`; and
  **46** of those 63 are `done` while their recorded location is already gone. 28 + 46 = the 74 dangling
  record paths T1 measured. The count was 45 in the audit and 46 a few hours later, because one more record
  crossed the cap in between — which is itself a reminder that this file is live.
- **Three fixes, and where the identity is now taken from.** `pruneLeadTrash` reports the **record's own**
  `memberId`, which is what `retireMember` flips on, using the name's id only as a fallback for a row that
  carries none. The `!moved` branch of the confirming write deletes `trashPath` again — T1 had replaced that
  line positionally, so a record could hold a legacy absolute path beside `archived: true` and send
  `restore_member` back into the trash branch for an artifact that was never moved. And `recordedTrashDir`
  now answers `undefined` rather than `''` for a path with no last segment, so a corrupt record reports
  `no-recorded-path` instead of resolving to the filesystem root and failing with `EBUSY`.
- **The suite was green because both test shapes hide it.** The only test asserting the flip seeded
  `childId === memberId`, and T1's new cap test passed rows with no `childId` at all. The new test seeds
  `memberId: 'member-N'` beside `childId: 'child-N'` — the shape `planMember` actually writes — and asserts
  both that the tombstone became `pruned` and that `restore_member` answers `reason: 'pruned'`. All three
  probes failed by name when the matching fix, the `trashPath` deletion and the empty-segment guard were
  reverted one at a time.
- **The 46 already-wrong records are left to the migration, deliberately.** Their future home —
  `<workspace>/.agents/team/roster.json` — does not exist yet, so correcting them here would write to the
  rollback path; the migration walks every tombstone anyway and the flip is idempotent. **Until it runs,
  those 46 still answer the generic `trash-missing`**: the fix is forward-only, and saying so is the whole
  difference between a fix and a claim. The migration has a rule to do it with — `artifactIsMissing`, which
  says a `done` tombstone whose artifact is on none of the chain's legs is one the cap emptied, and leaves
  `pending` records and records naming no destination alone.
- **A document finding, reported and not fixed, that explains the bug's survival.** Four places describe a
  trash directory as `<memberId>-<ms>` while a retirement actually writes `<childId>-<ms>`:
  `docs/adr/0004`, `docs/adr/0011` point 3, `docs/member-lifecycle-{en,zh}.md` §4, and the very document
  this release's predecessor paired, `docs/upstream-lifecycle-gap-en.md`. **The prose carried the same
  confusion as the code**, which is a good candidate for why nobody saw it. Owed to T4, with the ADRs
  superseded rather than edited.
- **What this does not prove.** `artifactIsMissing` is exercised by its own test but its first real use is
  the migration, so its behaviour over the live 46 is still a prediction. Nothing was installed for this
  release, and no document was touched.
- **Version.** `0.27.1`: a wrong answer was corrected. The tool surface, the stored shape and the location
  of the data are unchanged.

## 2026-11-13 — the decisions that moved the data are now recorded, and the statements they disproved are gone (v0.27.2)

- **Two ADRs, not the four the plan named.** ADR **0027** records that the roster is a file the plugin owns
  at `<workspace>/.agents/team/roster.json` and that the storage domain is demoted to import source and
  rollback; ADR **0028** records that a tombstone carries a directory name and a relative path, that the
  absolute path is a read-time computation, that restore has three legs, that the cap matches by directory
  name, and that the name carries the **child Session id** while the flip uses the record's `memberId`. The
  four collapsed because "the cap's matching rule" and "the id naming" are one subject — a name that is the
  matching key is *why* the ids matter. ADR 0018 and 0021 were read and produce **no** ADR: both locate
  `team/` through the `workingDirectory` service at call time, which the roster root does not change, so
  that coexistence is recorded as a consequence of 0027 instead. An ADR that exists to restate something
  unchanged is a document nobody maintains.
- **The code review that mattered more than either ADR.** ADR 0027 as first written said the marker beside
  `roster.json` is what stops a repeated import, and that "once the marker exists, an empty `roster.json` is
  empty, not a cue to re-import". Reading `roster.js` disproved both: `importLead` guards on whether the
  content it serves holds a record for that Lead and on nothing else, `writeMarker`'s own comment says its
  purpose is that "a reader can tell where the records came from", and the only read of the marker in the
  file is inside `writeMarker` itself. **The fix went into the document, not the code**, because the code's
  behaviour is what makes "delete `roster.json`" a complete rollback: if the marker gated the import,
  deleting the file would leave the workspace serving an empty roster while the domain still held the
  records — a documented rollback that rolled nothing back. The scribe then found a **third** instance of
  the same claim on its own: the Migration paragraph said rolling back is deleting the file *and* the
  marker, where the "and" quietly restated the thing just disproved.
- **One claim in those ADRs is now falsifiable by a command.** ADRs cite documents; they have never been
  able to cite behaviour, which is why no check in this repository could catch either false statement — the
  scribe observed that `scripts/check.mjs` resolves citations and sections but never claims, and that the
  only thing that caught all three was a person reading the code. So the rollback paragraph now names the
  test that proves it, `with the roster file deleted the domain is the source again, and the plugin keeps
  working` (`tests/store.test.mjs`), which deletes the file, rebinds, and expects the domain's hundred
  records back and the file rebuilt. A reader who doubts the claim has one test run instead of a paragraph
  to trust. It is the only claim in either ADR decorated that way, deliberately: names sprinkled for the
  look of rigour are worse than none.
- **Every statement the change made false, removed or corrected.** Six bilingual pairs, README included, and
  the two PLAN lines this file's own rules let the Lead touch. The **four places that called a trash
  directory `<memberId>-<ms>`** while a retirement has always written `<childId>-<ms>` are the pointed ones:
  `docs/adr/0004`, `docs/adr/0011` point 3, `docs/member-lifecycle-{en,zh}.md` §4 and
  `docs/upstream-lifecycle-gap-en.md`. The prose carried the same confusion as the code, which remains the
  best available explanation for a defect that emptied 46 records' bytes without flipping their state and
  survived for months. `PLAN.md:152` was corrected by the Lead at merge — the one word that survived
  because it was outside the document lane's scope.
- **The survivor list was reported rather than trimmed.** Strings that still read `trashPath` and are still
  *true* were kept with their reason: the resolver and its plan/result, `actions.js` deleting a legacy field
  on revive, `trash_path` computed through the resolver, and the new paragraph that deliberately describes
  the pre-v0.26.0 shape. A stale-looking string that is correct is not debt.
- **A correction to this file's own `0.27.1` entry.** That entry says the flip defect was "confirmed live"
  at `v0.26.0`. It was not: a read of the running instance's tool registry and three write probes
  established that the process serving the tools was **pre-0.26.0** the whole day — a merge writes the
  linked bundle's files, and that has not been reloading host code on this machine. The conclusion stands
  and is stronger than stated: the wrong answer was reproduced in the *shipped* code the owner has been
  running, not in a build of that morning. The defect was pre-existing either way; what was wrong was the
  version attributed to it.
- **What this does not do.** `docs/adr/0018`, `docs/adr/0021`, `docs/architecture-{en,zh}.md` and
  `README.md` still place member definitions at `<workspace>/team/`, which the template release changes to a
  three-leg chain — reported by that release's lane and left to it. `AGENTS.md` §2 still says the `files`
  list publishes "ten files", which stopped being true when `templates/` was added. And the team file,
  `team/team.md`, deliberately did **not** move beside the roster: it is not a member definition and has no
  shipped counterpart, so moving it is a separate seam and a separate decision.
- **Version.** `0.27.2`: documents and two comments. No behaviour, no stored shape, no shipped file.

## 2026-11-13 — five role templates ship with the plugin, and a definition is read from a chain of directories (v0.28.0)

- **What ships.** `templates/definitions/{implementer,reviewer,researcher,scribe,verifier}.md` — one per
  standing role, each a real definition `parseDefinition` reads, each body carrying the two rules this
  repository keeps relearning: report in three parts, and a check that can fail rather than a feeling. The
  owner's idea was that the plugin should ship refined templates a user can start from and then replace
  with their own, the way the memory plugin ships its notebook policy.
- **The rule that defines the feature.** A shipped template declares **only** `name`, `label` and
  `assignment` — never `provider`, `model`, `reasoning_effort`, `max_tokens`, `agent_preset` or `cwd`. The
  file describes the role; the route belongs to whoever starts it, and a bundled default route would pin a
  user's bill to whatever model was current on the day the template was written. `scripts/check.mjs`
  **refuses** the forbidden fields by name rather than documenting them, because a rule nobody can check is
  a comment.
- **The chain is `<workspace>/.agents/team/definitions/` → `<workspace>/team/` → the shipped templates**,
  first declaration wins. Two decisions inside it are worth more than the code:
  - **The legacy `team/` directory outranks the shipped set.** Publishing `reviewer.md` this release means a
    project that has carried its own `team/reviewer.md` for a year is exactly the one that would have been
    silently replaced by a bundled file. Both user legs win; the shipped one is last.
  - **A malformed file blocks the name it claims.** If a more specific layer declares a name and gets it
    wrong, a later layer does not take over: the author is editing a file that is not taking effect, and
    quietly substituting the shipped role hides that. `scanDefinitions` reports the name each rejected file
    `claims`, and the layer above it is blocked only for that name — so an unrelated broken file does not
    lock a project out of the shipped set.
- **The sentence the model reads was false and is now true.** `index.js`'s module header said "its durable
  state lives in one storage domain (ADR 0003)" — untrue since the roster became a file, and worse than a
  stale comment because tool-description prose shapes how the tools get called. It now says the durable
  state is the plugin's own `roster.json` under the bound workspace root, with the domain as import source
  and rollback. `spawn_member`'s description, which placed definitions "under `team/`", now names the chain
  and the five roles. Five stale comments went with them — including `trash.js`'s parser doc, which said it
  read `<memberId>-<ms>` "exactly as retirement writes it", the same confusion inside the module whose
  defect it explains.
- **`AGENTS.md` §2 said the `files` list publishes "ten files", and stopping being true twice without saying
  so** — the count never included `templates/`, and this release added five files to it. The Lead replaced
  the count with the list itself at merge, since a number in an inventory is the part that rots first.
- **Verification, and one probe that failed badly.** 238 tests pass, +5. The probes behaved: adding
  `model: cheap-model` to a template fails **both** `check.mjs` and the unit test by name, which is the
  point of putting the rule in both; removing `templates/` from `files` produces five failures, one per
  template; reverting the chain fails four of the five template tests. **The fifth failed with a
  `TypeError` rather than its own assertion** — it did fail, but it said less than the other three, and the
  implementer reported that rather than counting it as a clean probe. That is the standard this repository
  asks for: a probe that fails for the wrong reason is not evidence.
- **What is not proved.** Nothing was installed, so two things rest on tests rather than on a live call: that
  the model actually receives the corrected `spawn_member` description, and that a profile whose install
  copy contains `templates/` can spawn `definition: 'reviewer'` — the test reads the directory beside the
  module, which is where an installed copy resolves, but only a profile proves the published files arrive.
- **What this leaves, reported rather than fixed.** Four documents still place member definitions at
  `<workspace>/team/` with no mention of the chain: `docs/adr/0018`, `docs/adr/0021`,
  `docs/architecture-{en,zh}.md` (§4's definitions row, §7 and §9) and `README.md`. Queued as a document
  follow-up. And `team/team.md` **deliberately did not move** beside the roster: it is not a member
  definition and has no shipped counterpart, so `.agents/team/` now holds `roster.json` and `definitions/`
  while the team file stays in `team/`. That asymmetry is a real seam and is left as a decision rather than
  absorbed into this task.
- **Still true, and it now blocks the last phase:** none of today's releases is running. The process serving
  the tools was measured again at the end of this release and still serves pre-0.26.0 code, so the roster
  file has still not appeared under the workspace. A full restart is required before the migration, and the
  migration will be the last thing to run.
- **Version.** `0.28.0`: new published files, a new capability, and a description the model reads. Nothing
  stored changed shape.

## 2026-11-13 — the definition chain is recorded, and the team file's path is a decision rather than an unfinished move (v0.28.1)

- **ADR 0029, and the judgement that produced exactly one ADR.** ADR 0018 point 1 *decided* that the path is
  `<Lead working directory>/team/*.md` and that there is one directory rather than a path parameter — v0.28.0
  changed that decision, so 0018 is superseded **for point 1 only**. Everything else in it stands: the
  frontmatter subset and its refusals, the caps, the typed refusal, the one-parameter surface, and ADR 0019's
  precedence on a `replace`. ADR **0021 gets no new ADR**, only a pointer: it decided one `team.md`, its
  precedence, the reservation and the write refusal, and none of those changed — what went stale is a premise
  in its *Context* ("a team file and a member definition share one directory"), and the reservation still
  suffices because the member scan skips `team.md` wherever it reads. A closed record is amended where its
  premise moved and replaced where its decision did; that distinction was the whole question.
- **The sharpest rejected alternative, and it is why the order is what it is.** Putting the shipped templates
  **first** would give every profile the maintained version — and would silently replace a project's own
  `reviewer.md` of the same name. The ADR states the consequence in the terms this repository uses for it: the
  plugin would be editing the meaning of a member without touching a file. So the shipped set is the last leg.
- **The asymmetry is written down as a decision, not left to be read as an unfinished move.** `.agents/team/`
  holds the roster file and the definitions the plugin owns; `team/` holds the project's own team file — one
  artifact per project, not per member — and any definitions a project prefers to keep there. The file was not
  moved. Every document that now describes the chain says the team file is outside it, so a reader meeting both
  paths side by side is told which is which.
- **Four places beyond the list I gave.** The document lane found `architecture` §9's substrate row and §7's
  limits bullet (which promised "exactly the readable `.md` files under `team/`" — the very promise the chain
  changes), the handoff pair's "same `team/` directory" sentence, and the README's package row, which had never
  listed `templates/` at all, so a reader could not learn the shipped templates existed. A brief is a lead, not
  a boundary; every one of today's five releases was improved by a lane searching rather than obeying.
- **The method fix that made this deliverable survive.** The first attempt at this task failed after gathering
  its whole inventory and before writing any of it down, and nothing was lost to the repository because nothing
  had been written. The second attempt committed **four times, one document each**, and pushed as it went. That
  is the lesson to carry: the inventory *is* the work, so write it down before verifying it, and a failure then
  costs one file instead of a task.
- **Verification.** `node scripts/check.mjs` printed `check passed` after every one of the four commits, and the
  suite is 238 tests, 238 passing, with no test file touched. Heading parity for every pair edited, as levels:
  architecture 18/18, README 13/13, handoff 4/4, INDEX 6/6. A re-grep afterwards shows `team/*.md` as a
  definition path surviving nowhere outside `docs/adr/`, where 0018 keeps it and the new pointer explains it;
  every remaining `team/team.md` refers to the team file; and the only other `team/` mentions are the v0.16
  release-history bullets, which are correct as history.
- **What is stated but not tested.** That a shipped template is read-only is a property of the code, and no
  document check can prove it — the same class of gap this file recorded for the rollback claim, where the fix
  was to name the test. There is no test to name here yet, and that is worth knowing rather than papering over.
- **Version.** `0.28.1`: documents only. No code, no stored shape, no shipped file.

## 2026-11-13 — the roster and the trash can be moved into the workspace, dry-run first (v0.28.2)

- **What this adds, and what it deliberately is not.** `scripts/migrate-roster.mjs` and its tests. It is not
  in `files`: a one-off operation is not a bundle capability, and shipping it would imply the plugin
  migrates on its own, which it never does.
- **`--apply` refuses until the ordering is right.** The roster file must exist, and if it does not the script
  names the order — restart, call one roster tool so the plugin imports, then run this — rather than deciding
  for the operator. The dry-run needs no such thing: it reads the storage domain and says so in its header,
  which is why a full plan could be produced before the plugin had ever bound a workspace.
- **Nothing is written before a backup exists**: byte copies of the roster file and of the storage domain in
  `<data root>/backups/<stamp>/`, plus a `manifest.json` naming every source path, every destination path and
  each artifact's size. The domain is read and copied, never written and never deleted — it is the rollback.
- **The move is cross-volume on this machine, so it is a copy.** `rename` is tried first and answers `EXDEV`
  from `C:` to `D:`, after which the artifact is copied, **verified by file count and total byte size**, and
  only then is the source removed. A verification that fails drops the incomplete copy, keeps the source, and
  leaves the record untouched — the failure mode is "nothing happened", not "half moved".
- **The rewrite and the reconcile.** A moved record becomes `trashDir` + `trashRelPath` and loses
  `trashPath`; `originalPath` stays absolute because it points into `~/.dsh/sessions`, which has no root to be
  relative to. A record whose artifact is on none of the chain's legs is one the retention cap emptied, and is
  flipped to `pruned` with `artifactIsMissing` — the rule v0.27.1 added for exactly this.
- **The ordering that makes it idempotent is not obvious, and it was found rather than assumed.** The
  destination is asked about **before** the old chain. A completed run leaves the artifact only at the
  destination, so asking the old chain first would read "absent where it used to be" and misclassify a
  migrated record as emptied by the cap. The probe that skips this fails on `reconcile-pruned` and on the
  apply-twice counts, which is how the ordering is known to be load-bearing rather than tidy.
- **The real plan, re-measured on the live data rather than copied from the audit**: 110 records, **20
  artifacts to move, 46 to reconcile to `pruned`, 28 already `pruned`, 44 left alone by reason, 0 refused.**
  One record carries no destination at all and is counted as left alone rather than guessed at.
- **Verification.** `scripts/check.mjs` prints `check passed`, `node --check` is clean on the script too, and
  the suite is **247 tests, 247 passing**, nine of them new, all on fixtures in temporary directories — no
  test touches the real roster or the real trash. Three probes were each shown to fail on their own
  assertion: not deleting `trashPath`, skipping the copy verification, and asking the old chain first.
- **A probe was caught silently doing nothing, for the second time today.** The first attempt to capture the
  dry-run's output produced no file at all, because its scratch directory did not exist and the redirection
  failed quietly; the next command naming the missing path is what exposed it. The earlier occurrence was a
  pairing probe in the document lane. Two independent agents, two silent no-ops, both caught by looking for
  the artefact instead of trusting the exit code — which is the argument for that habit, not for the exit
  code.
- **What is left, and it is mine.** `--apply` has not run against real data and will not until the owner reads
  the plan and says go. **A second restart is required afterwards** — the plugin keeps the roster in memory
  and re-reads it only on a load or a write, so it serves pre-migration records until it restarts; the script
  prints that in every report, not only in its own documentation.
- **One consequence worth stating for the operator.** Records that arrive from the running process *after*
  `--apply` will be imported by the plugin in the old layout, so `records rewritten` may be less than 20 on a
  later run. Re-running the migration is safe by design, which is the point of making it idempotent.
- **Version.** `0.28.2`: a script and its tests. No bundle file, no stored shape, no behaviour of the plugin.

## 2026-11-13 — the README presents what a reader can weigh, and the migration's run is recorded at last (v0.28.3)

- **The presentation the owner asked for.** After seeing how two sibling plugins introduce themselves, the
  README pair gained a badge row, the `English | 中文` switch, and a three-part `Status`: what was exercised
  in a real profile, what was checked with something stronger than a reading, and what is **not** covered.
  **Only badges the repository can prove** — ci (`.github/workflows/ci.yml` exists), MIT (`LICENSE`), no
  dependencies, no build step. **No DSH-version badge, deliberately**: nothing here claims a Harness range,
  `engines` names Node, and a badge asserting a fact nobody maintains is worse than no badge.
- **Every number in the Status has a source, and one had none until this entry.** The README states 110
  records, 20 artifacts moved, 46 reconciled to `pruned`, 44 left alone, 0 refused, and **4,913,598 bytes**.
  All but the last trace to earlier entries; the byte total was measured two ways on disk — the sum of the
  `move` rows in the backup manifest, and the size of the destination directory — and both read 4,913,598,
  which is the only reason the word "verified" appears beside it. The document lane **reported the gap
  instead of quietly leaving an unsourced figure in a merged file**, which is why this paragraph exists.
- **The record the previous entry could not carry, because it was written before the run.** v0.28.2 says
  `--apply` "has not run against real data and will not until the owner reads the plan and says go". It has
  since run, with that consent: **20 artifacts moved, 20 records rewritten, 46 reconciled to `pruned`, 44
  left alone by reason, 0 refused** — and the destination verified **byte for byte** at 4,913,598 across 20
  files, with the old trash root left empty and two backup stamps on disk, both planning the same 20/46/44,
  so the plan is stable across attempts.
- **The first attempt failed, and the failure was worth more than a success would have been.** The rename
  raised `EPERM` rather than the `EXDEV` the script anticipated: the *source* directories live outside the
  workspace and `workspace-write` refuses a delete there — same-volume and cross-volume probes both returned
  `EPERM`, so it was policy, not an errno quirk. **The consequence was zero**: backup written, destination 0,
  source 20, roster untouched, `serial` unchanged. The remedy was the one the rules ask for — the same
  command, once, with a wider sandbox and the reason named — never a workaround, and never a silent retry.
- **Three live acceptances after the restart, and they are the point of the whole day.** `eph-alpha`, which
  before the migration answered `trash-missing` with **no `reason` field**, now answers the typed
  `reason: "pruned"` — the 46 reconciled tombstones are correct where the plugin can see them.
  `restore_member bare-standing-probe` answered `restored: true, reason: "moved-back"` and the 40,748-byte
  artifact returned to its `originalPath`, found at the **workspace** root through `trashRelPath`. Retiring
  it again wrote `trash_path` under `<workspace>/.agents/team/trash/…` with a fresh stamp, and the record now
  carries `trashDir` + `trashRelPath` and **no `trashPath`** — the plugin writes the new shape natively,
  which is the one thing a migration cannot prove about its own host.
- **74 records still carry an absolute `trashPath`, and that is correct rather than unfinished.** Their
  artifacts are gone — 28 pruned before the migration and 46 by it — so there is nothing to rewrite relative
  to a root; ADR 0028 says a pruned tombstone keeps what it recorded, and the retention cap matches those
  records by directory name precisely because a name is the part that survives the root moving.
- **No `PLAN.md` box is owed.** Its tasks predate this work and its store task (P2-01) was closed long ago;
  the storage move has no box to tick, and inventing one after the fact would be a task written to be
  completed rather than to be done.
- **Version.** `0.28.3`: documents only. No code, no stored shape, no shipped file.

## 2026-11-13 — the Host's own validator accepts every schema, and the keyword outside its subset is explained (v0.28.4)

- **What was never asked, and is asked now.** `scripts/check.mjs` validates the manifest, the published
  files, locale parity, the patch rows and that every `execute(` declares `(args, exec)` — and it has
  always carried a hand-copied list of forbidden JSON-Schema keywords. It never asked **the Host** whether
  the schemas were acceptable, and the Host is the thing that decides whether a tool exists at all: a
  keyword outside its subset does not fail one tool, it fails the plugin's activation. `scripts/check.mjs`
  cannot close that gap because it never loads the Harness; the validator, however, is a pure function
  inside the archive, which makes this the one Host-side check a repository *can* carry.
- **How it reaches the Host's code without packing or unpacking 213 MB.** `scripts/schema-check.mjs` reads
  the archive by its own header, extracts the validator and its module closure into a temporary directory
  that preserves the package boundaries, and imports the package entry the Host itself imports
  (`@deepseek-ai/dsh-tools/lib/index.js`) — so the code instance is the same one, not a copy of it.
- **The verdict: nothing was rejected.** `assertSupportedJsonSchema` accepted **11 of 11 output schemas**,
  `validateJsonSchemaValue` accepted **13 real results** produced through the tools' own wrappers, and the
  Host rejected nothing. The validator names itself from the archive: `@deepseek-ai/dsh-tools 0.2.2-rc.1`,
  `assertSupportedJsonSchema` / `assertObjectJsonSchema` / `validateJsonSchemaValue`, `JsonSchemaError`
  (code `UNSUPPORTED_SCHEMA`).
- **Three assumptions came out of the notes as facts.** (1) Three parameter schemas use `maxLength` —
  `spawn_member.assignment`, `message_member.assignment`, `handoff_template.template` — which is outside the
  subset, and the check explains *why* it survives rather than merely that it does: `register()` asserts
  `output.schema` only and projects a parameter schema to the model unasserted, so the cap is enforced by
  the action when the value arrives, not at the schema boundary. **Decision: the keyword stays** — the model
  gets a machine-readable range, the action enforces it, and the Host does not object; the comment in
  `check.mjs` that used to say "the host tolerates it" now states the mechanism and cites the check that
  established it. (2) `spawn_member`'s output schema is not object-rooted — its root is a `oneOf` over the
  started and refused answers — and the registry accepts it, because the assertion it runs is the subset
  assertion and not the object-root one; a note, not a defect, and only a problem if that schema were handed
  to a path that demands an object root. (3) Everything else is within the subset.
- **Verification.** 254 tests pass, seven of them new, and the new ones need **no archive at all**: a
  synthetic archive with the same layout exercises the header read and the per-file byte ranges, the
  specifier scan covers `import … from`, bare `import`, re-exports and dynamic `import()` while skipping
  comments, resolution walks `node_modules` and relative paths, and a stand-in validator drives the verdict
  logic. Three probes were each shown to fail by name — a wrong header field, a suppressed output-schema
  rejection, and a parameter note counted as a failure. The first of those is the implementer's own bug
  reproduced as a test: it hit it twice while writing the script, which is why the test builds an archive
  instead of mocking the reader.
- **What this cannot do, stated so nobody leans on it.** It is a **local** check and deliberately not a CI
  gate, because CI has no Harness; a Host upgrade can change the verdict and nothing will announce it. The
  real results come from a minimal fixture context, so a live profile's shapes — `list_members` against a
  real roster, `wait_members` against a real child session — are outside it. And it proves nothing about
  activation: a schema the Host accepts still waits for a profile to show a tool exists.
- **The README pair carries the conclusion**, because a check nobody can see is a check nobody trusts: both
  sides of the Status gained the bullet, in the same commit and in parity. That edit is the Lead's at merge
  rather than the document lane's, because the evidence is this release's own output and the lane would have
  had to re-derive it from a PR.
- **Version.** `0.28.4`: a local script, its tests, and one bullet in each README. No bundle file, no stored
  shape, no behaviour of the plugin.

## 2026-11-13 — the import marker is named after what it is, and the file on disk keeps the record (v0.28.5)

- **`roster-import.json` is now `provenance.json`**, at the owner's judgement and for a better reason than
  taste: the old name described **a process**, while the file is **a record** of where the roster came from.
  Its own contents say so — `source: "team_roster"`, and per Lead the import time and the counts that came
  across. The exported constant went with it, `IMPORT_MARKER_NAME` → `PROVENANCE_FILE_NAME`, beside
  `ROSTER_FILE_NAME`: a constant called `IMPORT_MARKER_NAME` that points at `provenance.json` would be a
  small lie, and a reader pairs a filename only with those two exported names.
- **The rename needed no compatibility leg, and that was established rather than assumed.** Two claims were
  checked against the repository before the change and again after: **no document writes the filename**
  (the ADRs and both READMEs say "a marker beside the file"; a grep over the whole tree found the literal
  name in exactly four code places and two test references, and none afterwards), and **nothing reads the
  file to decide anything** — `importLead` guards on whether the served content already holds a record for
  that Lead, and `writeMarker` reads the file only to merge the `leads` map it is rewriting. So this is not
  the trash path, which really is read and really does break when a root moves; a rename here has no
  fallback to build.
- **The trap in this kind of rename is that the test can be worthless without anybody noticing.** Changing
  only the constant's *value* moves the writer and the reader together, so a test that writes and then reads
  through the same constant passes whatever the name is. The probe therefore moved **one side only** — the
  write — and `tests/store.test.mjs` failed by name with `ENOENT … provenance.json`, which is the proof that
  the test pins the name rather than the existence of a file somewhere.
- **The disk was the Lead's, because it is live data.** `<workspace>/.agents/team/roster-import.json` became
  `provenance.json` by a move, not a rewrite: 358 bytes, two Leads, the same `importedAt` times and the same
  100/10 members and 3/0 tasks. The old name leaves no orphan, and because the guard is content rather than
  the marker, the plugin will find and merge that existing file instead of writing a second one.
- **What was deliberately not renamed.** `state.marker` and `writeMarker` keep saying "marker": they describe
  the mechanism, their comments still read true, and renaming them for symmetry is churn. The test's own
  wording keeps "marker" for the same reason.
- **One limit worth stating for a provenance record.** The file accumulates one entry per Lead it has
  imported. A copy left under an older name elsewhere would not have its older entries carried across if a
  new Lead imported later — but nothing merges two provenance files, and for a record of what happened that
  is a cosmetic gap rather than a contract. It is not worth a compatibility leg, and saying so is cheaper
  than building one.
- **Version.** `0.28.5`: a published module and one test file. The stored shape is unchanged, the file on
  disk is the same bytes under a better name, and nothing about how the plugin behaves is different.

## 2026-11-13 — a tombstone stays only while its artifact could, and the rest become history (v0.29.0)

- **The last structural problem, and it was real.** `roster.json` grew without bound: 100 records, 95 of
  them retired tombstones, roughly a kilobyte each, one more per retirement, nothing ever leaving. The
  retention cap bounded the **trash directories** (20 per Lead) and never bounded the **records**, and
  `list_members` mapped every record to a row, so the tool's own output grew with the file.
- **The invariant, and why it is not an arbitrary threshold: a tombstone belongs in the roster exactly
  while its artifact could still exist.** Beyond the most recent `trashLimit` retirements the cap has
  already deleted the artifact, so `restore_member` can only answer `pruned` there — which makes archiving
  such a record **lossless for functionality**, and leaves it only the two duties that are kept: being
  read, and being counted.
- **Enforced on every write for that Lead, not on retirement alone.** That is the difference between a
  property of the file and a rule inside one operation, and it is why the 74 records already over the
  window need no migration script: the next write of any kind flushes them. The window is derived from the
  effective `trashLimit`, so it cannot drift out of step with the thing it is derived from.
- **Four conditions, and the last one is the safety argument: outside the window, carrying a recorded
  trash destination, not `pending`, and the artifact absent on every leg of the same resolver
  `restore_member` uses.** The window decides *when to look*; the filesystem decides *the outcome*. A
  record whose bytes are still on disk stays however old it is, and one that never moved anything stays
  too, because its session may still be where it always was.
- **The archive is `<data root>/archive.jsonl`** — append-only, one JSON object per line, each the full
  tombstone with when and why it left, and **appended before the roster is replaced**: a crash between the
  two leaves a duplicate line in an append-only history, where the other order would lose the record
  entirely. The hot path never reads it. There is deliberately no cap on it — an archive that deletes is
  not an archive — and if it ever needs one, that is a separate decision.
- **The ids are the reason naive deletion would have been wrong.** `retiredChildIds` is a compact per-Lead
  list of every retired child Session id, archived ones included, because the host hooks strip the shipped
  panels and the `list_agents` rows **by id**: a tombstone that left the roster without leaving its id
  would let its member reappear there. It is rewritten on every write so a **restored** member leaves the
  list — a live member the panel strips would be worse than a stale record.
- **The coupling I did not name, found by the implementer: adoption.** `ensureAdopted` compares a child id
  against the roster's own records, so a child whose tombstone had been archived looked unseen and was
  **adopted back as a live member** — a resurrection with a new `memberId` and the next generation of the
  name, silently contradicting a tombstone that still existed. The panel filter is an exit wrapper, not a
  source of truth, which is exactly why the guard had to go where the ids live. It is pinned by
  `a child whose tombstone is archived is not adopted back as a live member`.
- **Two more queries of the same class.** A `spawn_member` with `replace` naming an archived predecessor
  now refuses by naming the archive — an archived predecessor cannot be replaced, because the handover
  brief lives on the record — and the slot credit counts the id list rather than the tombstones still in
  the roster, without which archiving would have quietly shrunk the credit a Lead gets for having retired
  members. Both are the same lesson: **an archive changes every question that used to be answered by
  looking at the roster.**
- **Measured on a fixture shaped like the real one: 100 records become 26** — five live plus the newest
  twenty — with **74 archived and 95 retired ids kept**, while one tombstone with no trash destination
  cannot be archived and stays. **That 74 is the same number T3's dry-run measured as dangling**, which is
  the window and the audit corroborating each other from opposite directions.
- **Verification.** 263 tests pass, nine new, and four existing assertions were updated because the
  behaviour deliberately changed — an import is now itself a bounded write, so `tests/store.test.mjs`
  reads 26 rather than 100, and `list_members` gained a field. Four probes were each shown to fail by
  name: removing the artifact check archived a record whose bytes were still there, removing the id
  retention left thirty ids unstripped, reverting the adoption guard brought an archived member back as a
  live row, and skipping the archive query turned the typed refusal into a generic one. `schema-check.mjs`
  still reports 11 of 11 output schemas accepted and no Host rejection.
- **A note on probe quality, of the kind this file keeps recording.** The adoption probe first failed on
  its *second* assertion — the archived count read zero because the adopted-back member had legitimately
  left the id list — rather than on adoption itself. The assertions were reordered so it now fails on the
  reason it exists. A probe that fails beside its mechanism is a probe that very nearly slipped through.
- **What this does not do.** The storage-domain mode is not bounded: with no root there is no neighbouring
  file to archive into, so a profile without a workspace keeps its records in the domain exactly as before.
  Records with no trash destination and records whose bytes are still on disk are never archived, by the
  rule above rather than by oversight. And the flush needs the first **write** after this release is
  loaded — reads never trigger it and never need it, so a roster can sit over the window until something
  writes, which loses nothing.
- **Version.** `0.29.0`: a stored shape changed and one documented behaviour changed with it — the roster
  now holds recent history rather than all of it, and says so.

## 2026-11-13 — the decision that a tombstone must stay is superseded by the record that it may leave (v0.29.1)

- **The clause that had to be superseded was not where anyone would look for it: it was a rejected
  alternative.** ADR 0011 refused "Delete the tombstone along with the artifact" in these words — *"draining
  a child does not remove its row from the parent's durable `subagentCatalog`, so the tombstone is the only
  thing preventing the next read from re-adopting the member. Dropping it re-adopts the member as a live
  ghost."* That is a decision, and it was the reason the roster grew without bound. The plan's own
  paraphrase ("a tombstone is never dropped") was the only place it surfaced, and the implementation's
  History section is where it was found. **A rejection is a decision**, and a record that reads only the
  Decision section will miss half of what a document decided.
- **ADR 0030 supersedes that rejection alone**, and ADR 0011's header now carries a clause-scoped pointer
  that names what still stands. The boundary was checked rather than assumed: `pruneLeadTrash` is still
  called from exactly one place, inside the retirement that moved an artifact in, so "enforcement only
  inside a retirement" is untouched by a bound that runs on every write for a different reason — moving
  records, not deleting bytes.
- **The rejection was right about the risk, and the new design keeps the guard rather than the record.**
  `retiredChildIds` holds the child id that the rejection was protecting, which is exactly why the rejection
  can be lifted without re-introducing the ghost. The paragraph the implementation found the hard way —
  that `ensureAdopted` compares a child against the roster's own records, so an archived tombstone's child
  would have been adopted back as a live member with a new `memberId` — is in the ADR's Context as the
  second fact, next to the first one that made the bound possible at all.
- **The ADR records the four arguments and, as importantly, what it does not bound**: the storage-domain
  mode, records with no destination, records whose bytes remain on a leg, and the archive itself. It also
  states the one thing still growing — `retiredChildIds` — rather than leaving a reader to discover it.
- **Five documents, five commits, one per file**: `roster-storage-{en,zh}` (the id list, the window, the
  files beside the roster), `member-lifecycle-{en,zh}` (a protocol that ended in a permanent tombstone now
  ends in one that may leave), `architecture-{en,zh}` (`list_members` reports what left), the README pair,
  and the `PLAN.md` sentence this file's rules let the Lead hand over. Heading parity is unchanged on every
  pair: roster-storage 5/5, member-lifecycle 5/5, architecture 18/18, README 13/13, INDEX 6/6.
- **The README states the behaviour and not a number, deliberately.** The flush has not happened on this
  profile — it needs the first *write* after the plugin reloads — so the Status says the bound runs on a
  write and never on a read, and calls itself suite-covered rather than live-observed. A count nobody
  measured is the thing this file has had to correct twice today.
- **One correction of the Lead's at merge.** ADR 0030's consequence list named both "its import marker" and
  `provenance.json` as files under the data root, which is the same file counted twice since v0.28.5 renamed
  it. Corrected before the merge, because an ADR in review is not yet a closed record — once it is accepted,
  the fix would have needed a new ADR rather than an edit.
- **Version.** `0.29.1`: documents only. No code, no stored shape, no shipped file.

## 2026-11-13 — a new root is seeded from a file the user names, and the storage domain's last file is gone (v0.30.0)

- **The domain had two roles, and the one that mattered was not the obvious one.** The fallback for a
  session with no workspace is rare; **the import source for any new root** is not: a Lead that binds a
  different workspace — a moved project, a second one — gets its records refilled from the domain, and
  without them a new root starts empty. An empty root has no tombstones, so `ensureAdopted` hands every
  child a **new live row**; the v0.29.0 guard blocks only an *archived* tombstone's child, and cannot
  block a child that nothing remembers. So the job was never "delete a file" but "keep that second role in
  a form the user can see", which is what `DSH_TEAM_SEED` is.
- **`DSH_TEAM_SEED` is a path to one file, read once per new root, never written.** It accepts **both
  shapes** — this plugin's own `{version, serial, rosters}` and a storage-domain dump `{tables: {rosters}}`
  — so a user can carry a roster to another machine or point at a dump if that is what they hold. It applies
  only to a root with **no** `roster.json`: an existing file is the truth, and a root counts as established
  the moment it has one, even if that file lacks this Lead's record.
- **The order is seed → domain → nothing, and a broken seed is loud.** Setting the seed is an explicit act,
  so it wins. A path that does not exist, a file that does not parse, or a record the loader refuses leaves
  the root empty and reports the problem — **it does not fall back to the domain**, because a silent
  fallback turns a typo in a path into a mystery that looks like a successful import of somebody else's
  records. The test asserts the domain was **never asked**, not merely that its answer lost.
- **A seeded root records where it came from** — `provenance.json` with `source: 'seed'` and the path,
  which is what that file exists for. And with no root, no seed and no record, `list_members` reports
  `source: 'none'` with the two ways out: give the Session a working directory, or set
  `DSH_TEAM_DATA_DIR`. An empty roster for a session with no workspace is the **true** answer, and the tool
  says so instead of serving records that belong to somewhere else.
- **The storage domain's file on this machine was deleted, and that is safe for a reason worth recording.**
  Both migration backups in `<workspace>/.agents/team/backups/` are the **byte-identical** original
  (SHA256 compared against the live file before deleting it), so the pre-migration snapshot survives as two
  named copies. The domain is also **not the same data as the workspace file**: same 100 memberIds, but the
  domain is the **pre-migration** shape — 94 absolute `trashPath`s, 0 `trashRelPath`s, 28 `pruned` — against
  74 / 20 / 74 in the file. Rolling back to it would restore the 46 records to `done`-with-missing-bytes,
  which is the defect's wrong answer coming back. That is the clearest statement yet of what a rollback to
  a snapshot older than the last migration actually buys.
- **One honest caveat, from the question I made the implementer answer: the file can come back.** Asked
  "is there any path left that reads the storage domain", the answer was yes — a Lead with **no bound root**
  still reads it *and still writes it* (`table.put` / `table.update` are the only remaining write paths),
  so a rootless session that ever writes recreates the file. The seed removes the need for a domain at a
  **new root**; it does not remove the write path. That is the next task, and it is a real design question:
  what should a session with no root write to?
- **Verification.** 270 tests pass, seven new, one per acceptance line. Four probes were each shown to fail
  by name: removing the seed lookup, removing the established-root guard, letting a broken seed fall back
  to the domain (which produced exactly the failure the rule exists to prevent — the domain's two records
  appearing in a root whose seed path was mistyped), and removing the `none` branch.
- **Version.** `0.30.0`: a new environment variable and a new source in `list_members`, on top of a stored
  behaviour that no longer exists.
