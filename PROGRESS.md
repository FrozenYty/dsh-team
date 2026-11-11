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
