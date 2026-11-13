# Member lifecycle

> Owner: @FrozenYty · Revisit when: a roster phase, a transition, or a retirement or sweep rule changes

How a member moves between phases, what a retirement and a replacement do and in which order, how a
declared lifetime is swept, and what a standing role must carry before it may be ended. The record
these phases live on, and the trash a retirement fills, are `docs/roster-storage-en.md`; the work a
replacement hands over is `docs/task-board-en.md`; the brief it composes is `docs/handoff-en.md`.
Decisions: ADR 0001, ADR 0004, ADR 0009, ADR 0013, ADR 0016, ADR 0017, ADR 0026.

## 1. The four phases and the state matrix

Every cell is decided before implementation (AGENTS.md §4.8). The four phases are the ones `PHASE` holds.
**refusal** marks a deliberate rejection: the call reports why instead of acting, and it is neither a crash
nor an omission. "Same base" means spawning the name whose earlier holder is in that phase.

| Phase \ Event | adopt | spawn (same base) | replace | message | stop | compact | retire | restore | sweep |
|---|---|---|---|---|---|---|---|---|---|
| `provisioning` | not produced by adoption — an adopted record starts `active` or `failed` | reserves the next generation; this row is untouched | successor starts, then this reservation is drained and tombstoned | delivered through `sendMessage`; a child that has not published yet is refused by the subagent service and the error is reported | no-op unless the child is already resident, then its turn is cancelled | refusal `not-resident` until it is resident and idle | drain, then tombstone; the artifact usually cannot be moved yet, so `trashed: false` and the archive branch decides | refusal `not-retired` — only `active` is the no-op success (`restored: true, reason: 'already-active'`) | no-op — nothing has run, so there is no evidence to sweep on; only the read-time reconciliation can move this row, and it moves it to `failed` |
| `active` | no-op — identity is the child id, so a known child is never adopted twice | reserves the next generation; this row is untouched | successor starts from the brief, then this member is drained and tombstoned | delivered; a running child sees it at its next step, an unloaded one is cold-resumed | current turn cancelled; activation, inbox and record kept | compacts in place when resident and idle; refusal `busy` while running, `not-resident` when unloaded | drain, tombstone (`pending`), move and confirm, refresh the host effects | no-op success: `restored: true, reason: 'already-active'` | the one phase a sweep acts on, and only on a one-shot member that has started, is no longer resident and owns no `open` row: three conditions, all required, and a member that fails the third stays and is reported (`blocked`/`blocking_tasks`). A standing member, a running or resident member, and a member holding open work are each left exactly as they are (§2, ADR 0026) |
| `retired` | no-op — the tombstone holds the child id, which is what stops re-adoption | allowed: a new generation of the base starts with no replacement link (`docs/architecture-en.md` §2.3) | successor starts from the tombstone's brief; the retire half is a no-op (`reason: 'already-retired'`) | refusal `retired` | refusal `retired` | refusal — only `provisioning` and `active` are addressable | repeat: no-op success, `retired: true, drained: false, reason: 'already-retired'` | moves the artifact back, or runs the workspace unhide branch; `reason` names which one ran. A `trashState: 'pruned'` tombstone instead refuses with `restored: false, reason: 'pruned'` and never calls the workspace | no-op — the tombstone is already the result the sweep exists to produce |
| `failed` | no-op — known child id | reserves the next generation; this row is untouched | successor starts, then this record is tombstoned | refusal `failed` — the child never started, so there is nothing to receive it | refusal `failed` | refusal — only `provisioning` and `active` are addressable | accepted and tombstoned; there is usually nothing to drain or move | refusal `not-retired` — only `active` is the no-op success (`restored: true, reason: 'already-active'`) | no-op — it never ran, and the record stays visible and retirable |

Harness notices are the events no plugin operation can prevent:

| Phase \ Notice | the child finishes its turn | the child's turn fails | the host drains or unloads the child | the persisted Session disappears |
|---|---|---|---|---|
| `provisioning` | not applicable — the reservation precedes any turn | `failed`, with the start error in `note`; this is the only failure the plugin records | nothing observed; the reservation stands until the start resolves | retirement reports `trashed: false` with the reason, then the archive branch hides the Session |
| `active` | no durable change on its own — no completion notice is observed; the phase stays `active` and live state reports `unloaded`. A one-shot member is retired by the next lazy sweep once it also owns no open row, which is the only thing that turns this notice into a durable change (§2, ADR 0026) | no durable change — a failure after the start is invisible here, so the record stays `active` | phase unchanged, live state `unloaded`; still messageable (cold-resumed) and retirable | retirement reports `trashed: false` and falls back to the archive; restore reports the reason and leaves the record retired |
| `retired` | ignored — there is no live child | ignored | ignored | restore refuses and the record stays retired |
| `failed` | ignored | ignored | ignored | ignored |

What the cells depend on:

- **`dormant` does not exist, and P4-01 did not add one.** The four phases above are exactly `PHASE` in
  `roster.js`; live state (`running`, `idle`, `unloaded`) is read from the Harness at call time and never
  stored. A one-shot member does not need a stored "finished" state either: the `ephemeral` flag rides on
  the record and a lazy sweep retires the member once positive evidence that it ran and stopped exists and
  it owns no open row (§2). The completion hook this note used to expect does not exist in the Harness
  (ADR 0013, ADR 0026).
- **`replace` is one model call composed of `spawn` and `retire`.** The successor starts first in every
  cell, so a start that fails leaves the row exactly as it was, and the retire half reports
  `predecessor_retired: false` when it fails.
- **A start the Harness refuses is the same failed start, answered as a typed result.** The capability
  gates are asserted before a child is reserved, so nothing is running: the reservation the plugin wrote
  first becomes a `failed` record, nothing is left `provisioning`, and `spawn_member` returns
  `started: false` with a `reason` the model can act on instead of a host error (ADR 0016). On the
  `replace` cells this is the ordering already written above: the predecessor is untouched and the
  answer says `predecessor_retired: false`.
- **`replace` with a stored or file template is the same cell.** The phases and the order of the two
  halves do not change: the successor starts from the brief, and the brief is rendered from the effective
  template — `team/team.md`, then the Lead's `handoffTemplate`, then the built-in shape (§3, `docs/handoff-en.md` §2).
  Two refusals are added and both happen before anything starts — a template is validated when it is set
  or parsed, and a rendered brief past its cap refuses the call — so the cells stay as written and the
  record is not touched. A `handoff_template` write or clear while the file exists is a refusal, not a
  phase transition: it changes no member row and no stored template (`docs/handoff-en.md` §2).
- **Two tools in one model turn.** Every call re-reads the roster and every mutation is one atomic
  `update` (`docs/roster-storage-en.md` §1), so the second call acts on the first one's result: `message_member` then
  `retire_member` in one turn delivers and then tombstones, the reverse order refuses with `retired`,
  and `retire_member` then `spawn_member` starts the next generation. Parallel tool calls are serialized
  by the storage table, not by the caller.
- **A retired or failed member is still a controllable record.** It is listed, retirable and
  replaceable: `retire_member` and `restore_member` look a target up in any phase. Only the operations
  that need a live child — `message_member` and `stop_member` — are narrow, and they refuse a retired or
  failed target with the typed reason `retired`, `failed` or `missing`.
- **A pruned tombstone is retired, not gone.** The retention cap (§4) removes the artifact, not the
  member's identity: the record stays listed and keeps its assignment and path, so `restore_member` can
  answer `pruned` from the record instead of failing on a missing directory. That cell is a refusal, and
  it leaves the phase `retired`.

Two cells are the expensive ones and are called out deliberately:

- **retire while provisioning** — the record becomes `retired` immediately, and the in-flight child is
  drained when it publishes. A member must never come back to life after retirement. `replace` on a
  provisioning member does the same to the predecessor, after the successor has started.
- **retire while active** — retirement wins over in-flight work. The record's `assignment` is the brief
  (§3); if the model never recorded one, the successor's prompt says so and sends it to the Lead's own
  task board instead of inventing a summary.

## 2. Declared lifetimes, the sweep, and the consent a standing role needs (v0.25.0)

A member is a division of labour, not a task. The lifetime a Lead declares for it is the whole of what this
plugin does with that sentence:

- **`standing`** — a role the Lead expects to use again. It is never retired automatically, and ending it is
  the person's decision;
- **`one-shot`** — the parallel fan-out: a member created for one piece of work, which the lazy sweep retires
  by itself once it has run, stopped and owns nothing.

**The declaration is made on the spawn call, and only there.** `spawn_member.lifetime` is
`"standing" | "one-shot"`; `ephemeral: true` is the pre-v0.25 spelling of `one-shot` and keeps
working, and a call that passes both inconsistently is refused rather than tie-broken. An omitted
declaration is `standing`, which is the safe side: only a one-shot member is ever retired without
asking. **Nothing else can declare it** — a `replace` starts its successor as `standing` unless that
call says otherwise, and a member definition cannot carry a lifetime at all
(`docs/architecture-en.md` §6.1, §6). The reason is ADR 0019's precedence: a file that declared a
one-shot role would hand that lifetime to every successor of a replacement, which would then retire
itself at the end of its turn and orphan exactly the work the replacement had just moved to it.

**The property, not a phase, and the stored field is the old one.** A one-shot spawn records
`ephemeral: true` on the member and `startedAt` when its child starts, and every `list_members` row reports
`lifetime` — the vocabulary the call uses — so "may this member retire itself?" is answerable from the read
that shows the member. `ephemeral` is the durable spelling because it is already in every roster this plugin
has written; `lifetimeOf` is the one translation. No phase is added, and a member declared `standing` carries
none of these fields, so its record is what it was before v0.9.

**There is no durable completion event, so the sweep carries its own evidence.** The notices table above
records that nothing durable happens when an active child finishes its turn. The installed subagent seam
(`dsh-subagent` 0.2.2-rc.1) reports a descendant row's `activity` as `running` or `inactive`
(`lib/index.js:2435`, `sessions.get(entry.id) === undefined ? "inactive" : "running"`), and the installed
`dsh-experimental-agent-team` README states what that word means for a member: `inactive` is "no turn is
executing, whether loaded or stored" (README.md:62). So it describes residency, not an outcome — it is as
true of a child that never ran as of one that finished — and only `running` is trustworthy positive
evidence. The plugin therefore requires evidence it recorded itself: `startedAt`, written when the activation
resolved, so a reservation that never published has none; plus the local live registry (`liveStateOf`:
`ctx.agents.get(childId)`) reporting the member not resident. That pair is "it ran and then stopped" — a
member that never started, and a member still running, are both left alone. ADR 0013 records the signal and
why `activity` alone was not enough.

**The third condition is the board, and the board can only veto.** A member is eligible only when it
owns no `open` row on this Lead's board (`docs/roster-storage-en.md` §1, `docs/task-board-en.md`
§2). All three conditions are required:

| Condition | The fact it rests on | Where the fact is read |
|---|---|---|
| it started | `startedAt`, written when the activation resolved | the member's own record |
| it is not resident | the local live registry | `ctx.agents.get(childId)` at call time |
| it owns no `open` row | this Lead's board | `openTasksOf` on the roster record |

**An empty board is not a trigger, and that is a deliberate asymmetry.** An open row blocks a sweep; no row
never causes one. The three conditions are sufficient on their own, because a board cannot distinguish
finished work from work nobody wrote down — the upstream Claude Code agent-teams guidance records that its
teammates do not reliably mark their tasks completed, and the installed README's own words about `inactive`
are that it is not an outcome either. A member that never started also owns nothing, so treating an empty
board as evidence of completion would retire a freshly reserved member on the spot. A blocked sweep reports
itself instead: `blocked` counts the members the veto kept, `blocking_tasks` names the row ids, and
`blocking_note` names the one `task_board { action: "update", … }` call that clears each row. Closing the
work is what makes a one-shot member eligible to leave; it is never what proves the member finished.

**A message re-opens a one-shot member instead of re-declaring it.** `message_member` leaves `ephemeral`
alone and deletes `startedAt`, so the "it ran and stopped" evidence no longer exists; a later read that
observes the child resident again writes a fresh `startedAt`, and until then a sweep cannot conclude
anything about a member that was just handed work. Its result says so (`reopened: true`) and reports the
unchanged `lifetime`. This replaces ADR 0013 point 5, which cleared the flag and thereby made a one-shot
member permanent by accident. The same write counts what it wrote — `messageCount`, and `assignmentCount`
when an assignment changed. Since v0.25.1 those counters are written for every member, not only a one-shot
one, because the retirement gate reads them to tell a member that was handed work again and again from bare
residue; what stays one-shot-only is the *advice* below, which corrects a declaration rather than describing
a role.

**A re-tasked one-shot member is advised on, never converted.** Two or more accepted messages, or two or more
assignment changes, make the row carry `retasked: true` and a note saying the member is probably a standing
role and naming the call that declares it. The plugin does not act on its own count: a lifetime is the
person's consent, only a spawn can change one, and the sweep does not spare the member because it was
messaged twice.

**A standing member's `retire_member` needs the person's words — when that member carries something.** The
gate protects the person's decision to end a *role*, not every act of housekeeping (v0.25.1), so it depends
on what the member still carries. Three things count, and any one of them makes the ending a role-level
decision:

| Carrier | Where it is read | Why it makes the ending a decision about a role |
|---|---|---|
| a recorded `assignment` | the member's record | the role has a durable statement of what it was doing, which a person may still want kept |
| at least one `open` row | this Lead's board | somebody still owes work this Lead is tracking, and retiring the owner would leave it unowned |
| re-tasked at least `RETASK_MIN` times | `messageCount` / `assignmentCount` | the Lead has already handed this member work more than once, which is what using a role looks like |

With a carrier, the call retires nothing and answers `retired: false, reason: 'needs-confirmation'`, carrying
the `question` to put to the person, `carries` naming what it found, the `owns_tasks` it still holds, the
`assignment` it carries and a `message` saying what to do next. The retirement happens on the next call,
which passes `confirmed: "<their sentence>"`; the sentence is trimmed, echoed back into that result and
therefore stays in the transcript. Nothing is written on the refusal — no tombstone, no drain, no un-owned
work. A self-set boolean would ask nobody, which is what a model-only surface (ADR 0008) makes worthless.

**With no carrier, it is housekeeping and the Lead may do it — on a stated `reason`.** A standing member with
no assignment, no open row and no re-tasking is bare residue: a probe left behind, which nobody is still
deciding about. That call retires in one step, asks nobody, and must pass a non-empty `reason`, which the
tombstone keeps as `retireReason`; a call that states no reason answers
`retired: false, reason: 'needs-reason'`, carries `carries: []`, and changes nothing. The successful result
says in words that the member carried nothing and was removed as housekeeping, so the transcript shows the
Lead acted alone and on what. A blank reason is refused like every other empty value in this plugin.

Two retirements never reach the gate at all, because neither is the model deciding to end a role: a one-shot
member, whose declaration already was the person's prior consent, and a `replace`, which continues the role
with a new holder. Both call the same protocol with `consentRequired` false. The gate itself skips two more,
and for the same reason: **a record that never became a role has nothing to consent to** — `retired` has no
life left to end, and `failed` never started.

So the refusal's two values answer two different questions, and a reader can tell them apart without parsing
prose: `needs-confirmation` with a non-empty `carries` means a role with something behind it, and
`needs-reason` with `carries: []` means residue that needs a sentence. `owns_tasks` and `assignment` keep
their existing rule — present only when they exist — so an absent field still reads as "nothing there".

**The sweep is lazy, and it has exactly two trigger points.** It runs at the start of `list_members` (the
read where the model collects results) and `spawn_member` (the fan-out where the freed slots matter), and
nowhere else. Both already re-read the roster; neither runs on a plugin-owned clock, and no background task,
timer or model call is involved. It runs before the triggering operation's own read, so a `list_members`
result already shows a swept member as `retired`, and `spawn_member` can reuse the freed target. It returns
immediately — no read of the subagent registry, no write — when no member is one-shot. Every other tool is
either target-scoped (`message_member`, `stop_member`, `retire_member`, `restore_member`, `compact_member`),
reads live state without writing (`wait_members`), or touches no member at all (`handoff_template`), so a
sweep there would be an unrelated retirement on a result that does not report it.

**Retirement stays one implementation.** A swept member goes through `retireMember` exactly like a
model-invoked retirement — drain, tombstone-first, artifact move, retention cap, host effects — and its
tombstone records `retireReason: 'one-shot member: it ran and stopped and owned no open task'`. A triggering
operation whose sweep retired something adds `swept` and `swept_targets` to its result; when it retired
nothing and blocked nothing, the result is byte-for-byte what it was before this feature.

What the four events do to a one-shot member in each phase:

| Phase | retire | message | replace | sweep |
|---|---|---|---|---|
| `provisioning` | drains (usually nothing) and tombstones; the child is drained when it publishes | delivered or refused as the matrix says, and an accepted message re-opens it | the successor starts, then the reservation is tombstoned; the successor's lifetime is that call's | never — there is no `startedAt`, so nothing proves it ran |
| `active` | the normal retirement protocol | delivered, and the member is re-opened: the lifetime is unchanged and the finished-evidence is dropped | the normal replacement handoff, and the successor is `standing` unless that call declares otherwise | retires it only when it is not resident and owns no `open` row; a running member, and one holding work, are never swept |
| `retired` | no-op, `reason: 'already-retired'` | refusal `retired` | the normal replacement, briefed from the tombstone | no-op |
| `failed` | accepted; there is usually nothing to drain | refusal `failed` | the normal replacement | no-op — it never ran, and the record stays visible |

## 3. Retire and replace

Retirement is a protocol, not a deletion, because a member's Session is durable and its work may be
half-finished. What `retire_member` does, in the order the code does it:

0. **Decide whether the model is allowed to do this at all.** With `consentRequired` set — which is what the
   `retire_member` tool sets, and what a replacement and the sweep leave unset — the gate asks about a
   `standing` member only when it still carries something (an `assignment`, an open row, or a re-tasking),
   and *nothing below runs* on a refusal: no handover write, no drain, no tombstone. A member that carries
   something and has no `confirmed` returns `reason: 'needs-confirmation'` with the question to ask and
   `carries` naming what stopped it, and the next call carries the person's sentence quoted. A member that
   carries nothing is housekeeping: it retires on a non-empty `reason` alone, and a call with neither a
   reason nor a confirmation returns `reason: 'needs-reason'`. Step 1 proceeds with the sentence or the
   reason echoed into the result (§2, ADR 0026).
1. **Record the reason.** A model-supplied `reason` is kept on the tombstone as `retireReason`.
2. **Drain.** `ctx.subagents.drainChildren(lead, [childId])` stops the child and releases its activation
   slot and residency. A child that never published, or one that already settled, has nothing to drain;
   retirement proceeds either way, because the record is the lifecycle authority.
3. **Tombstone.** The record moves to `retired` carrying `retiredAt`, its `assignment`, any reason, and
   the trash path the next step intends to use, marked `trashState: 'pending'` (or `'none'` at once when
   there is nothing to move) — *before* the filesystem is touched (§4). A crash here leaves a retired
   record and an artifact that is either unmoved or already trashed; `pending` says which is unknown and
   restore looks in the trash first, so both cases are recoverable.
4. **Move the artifact, then confirm.** The persisted Session moves into the plugin's trash directory and
   the record is confirmed with `trashState: 'done'`, its `trashDir`, `trashRelPath`, `originalPath` and
   `trashKind`.
   When no artifact can be moved, the workspace archive hides the Session instead, the intended trash
   fields are dropped, and the record and the result say that this is what happened (`archived: true`,
   `trashState: 'none'`). `archived` and `trashDir` are mutually exclusive: the archive branch runs only
   when no move happened.

5. **Bound the trash, only here.** A retirement that moved an artifact in enforces this Lead's
   retention cap in the same call; the cap itself, its candidates and the `pruned` state are
   `docs/roster-storage-en.md` `docs/architecture-en.md` §3 (ADR 0011, ADR 0012).

6. **Hide.** Retired ids stop being served by the host projection exits, so every client drops the
   member, while the roster keeps the trash path for manual recovery.
7. **Report.** The result carries `retired`, `drained`, `archived`, `trashed`, `pruned` (0 when nothing
   was removed) and — when there is one — `trash_path`; when `pruned` is above 0 the message says how
   many artifacts were removed, at which cap, and why. A repeated call is a no-op that answers
   `retired: true, drained: false, pruned: 0, reason: 'already-retired'`.

The durable statement of the work is the member's `assignment`, set by the model with
`spawn_member.assignment` and kept current with `message_member.assignment`; it is capped at 1000
characters, so a record cannot grow without limit.

**Replace.** `spawn_member` with `replace: <target>` composes a short, self-contained prompt for the
successor: the successor's name, the predecessor's target and label, the recorded assignment, the
fact that the predecessor is gone, its open tasks by id and title, and a pointer to this Lead's own
task board under the predecessor's name — read by the member with `list_my_tasks`
(`docs/architecture-en.md` §5.2). The board's rows are handed over, not copied and not duplicated.
It then runs steps 2–6 on the predecessor. **The successor starts first and the predecessor is
retired second, in the same call**: a failed start leaves the predecessor untouched and live, and a
failed retirement returns `predecessor_retired: false` with the reason, so one more `retire_member`
call recovers it. A target already retired is accepted, and its tombstone supplies the brief. ADR
0009 records the ordering and why the alternatives were rejected; ADR 0017 records the handover
itself.

**A successor starts with the options the caller names for it.** `spawn_options` applies to a
replacement exactly as it does to a plain spawn; the predecessor's live record and its eventual
tombstone are unaffected. A start the Harness refuses — a preset id the profile does not declare, a
provider without the requested capability — is the failed start the ordering above already covers: the
predecessor stays live, the result says `predecessor_retired: false`, and the failed reservation is
listed so a retry can name a declared preset or omit the field (ADR 0016).

The successor's brief is inherited work, not a copy of the predecessor's state: the successor inherits
the predecessor's `assignment` unless the model records a different one, so repeated replacement does not
thin the record out one generation at a time.

The brief's shape — its placeholders, their bounds, and the three sources it can come from —
is `docs/handoff-en.md` `docs/architecture-en.md` §1.

## 4. A retirement moves the artifact

`retire_member` tombstones the record *before* it touches the filesystem, carrying the trash directory the
move is about to use and a `trashState: 'pending'` marker, then moves the persisted Session into
`<data root>/trash/<leadSessionId>/<childId>-<ms>/` and confirms the record with
`trashState: 'done'`; §3 owns those steps. The name carries the **child Session id**, which is not the
record's `memberId`, and the record stores it as `trashDir` with its `trashRelPath` instead of an absolute
path, so the artifact is still found after the data root moves (ADR 0028). The order is deliberate: a
crash between the two leaves a
`retired` row beside an artifact that is either still in place or already in the trash — recoverable in
both cases, because `pending` says the move may or may not have happened and restore looks in the trash
first. The reverse order would leave a trashed session behind an `active` record, which no later read
could explain.

The move is what removes the member from the host's own discovery, since session-query drops an
artifact that no longer exists, and it deletes nothing: the cross-device fallback is the only branch
there that removes the source, and when no artifact can be moved the workspace archive hides the
Session (`archived: true`, `trashState: 'none'`, and the intended trash fields are dropped).
Restoration is the inverse and equally explicit: the record keeps the original path and the artifact
kind (`trashKind` — the Session directory or a single artifact file), so `restore_member` is a move
rather than a guess; `docs/architecture-en.md` §5 owns the result branches and the refusals.

A retirement that actually moved an artifact in also enforces the per-Lead cap in the same call (§3
step 5, ADR 0011, ADR 0012): the move is the one moment the trash grows, so nothing is swept on a timer
and nothing is swept on a read.
