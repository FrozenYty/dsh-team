# Live acceptance

> Owner: @FrozenYty · Revisit when: the checklist is run against a new Host build, a check gains a
> precondition, or a check is retired

This is the **only** check in this repository that proves the **Host's service behaviour**. Everything
else proves something narrower: `scripts/check.mjs` proves the bundle matches itself, `scripts/schema-check.mjs`
proves the Host's validator accepts our *shapes*, and the suite proves our *logic* on fixtures. None of
them can notice that `agentTeams.listMembers()` or `tokenMeter.contextPressure()` started returning a
different shape — a change that breaks this plugin with every automated check green.

So this procedure is run **after every Harness upgrade**, and only a real call catches that class of
breakage. Its result is recorded in `PROGRESS.md` with the **Host version** it ran against: this document
is the procedure, `PROGRESS.md` is the record, and `PLAN.md` earns a task only when the checklist has to be
scheduled rather than performed.

**What it cannot prove:** it is a snapshot of **one Host build**. A pass says the Host behaved as expected
on the day it ran; it says nothing about the next build, and it cannot replace the suite — a live round that
passes while a fixture test fails is a live round that measured the wrong thing.

**Read the numbers as relationships, not literals.** Every count below belongs to one profile and one day.
A different profile has different counts; what must hold is the relation between them, which is why each
check states the relation rather than the value.

## 1. The archive is bounded and says so

**Call** `list_members` with `archived: true`.
**Correct looks like** `archived_returned` equals the cap (50 today) **and** is smaller than `archived_total`
whenever more records exist, so the answer says both how much it shows and how much it holds. Observed
2026-11-13: `archived_returned: 50`, `archived_total: 74`.
**If it does not match** — `archived_returned` above 50: the cap is not being applied, and an unbounded
read is the failure the cap exists to prevent. `archived_total` equal to `archived_returned` when the file
clearly holds more: the total is being computed from the returned slice, so a caller can no longer tell
that history is being withheld.

## 2. A plain read never opens the archive — check it by arithmetic

**Call** `list_members` with no flag.
**Correct looks like** `archived_records` reported, `archived` rows absent, and the **arithmetic closing**:
`retiredChildIds` length minus the number of tombstones still in the roster equals `archived_records`.
Observed 2026-11-13: **95 − 21 = 74**. That subtraction is how you verify the hot path was respected
without a debugger: if the hot path had read the file, the count could come from the wrong place and the
difference would not close.
**If it does not match** — the arithmetic not closing: the count and the file disagree, so either the
archive is being read when it should not be or the window flushed without writing. `archived` rows
appearing without the flag: the flag has stopped meaning anything.

## 3. Restoring an archived tombstone refuses, by name

**Call** `restore_member` against a target known to be archived.
**Correct looks like** `reason: "archived"`, the message **naming the archive file and the archived time**,
and **nothing changed** — no trash entry, no record movement, the roster identical afterwards.
Observed 2026-11-13: the refusal named the file and the archive time and moved nothing.
**If it does not match** — a generic "not found" instead: the typed refusal was lost, and a person can no
longer tell "never existed" from "left the roster". Anything moving: a restore that writes on a refusal is
the false-success defect this plugin has been repaired for more than once.

## 4. A live retirement writes the workspace trash and a portable origin

**Call** `retire_member` on a member whose artifact exists.
**Correct looks like** the artifact inside the **workspace** trash (`<workspace>/.agents/team/trash/…`,
never `~/.dsh/team-roster`); `originalRelPath` written **with forward slashes** as `<slug>/<leaf>`; and
**neither `originalPath` nor `trashPath`** on the record (ADR 0034).
Observed 2026-11-13: exactly that — the moved artifact under the workspace, the relative origin with forward
slashes, both absolute fields absent.
**If it does not match** — the artifact under `~/.dsh/team-roster`: the frozen directory is being used as a
write target instead of only as a legacy read leg. `originalPath` or `trashPath` present on a new record: a
release went back to writing an absolute path, and the roster stopped being portable.

## 5. A restore works from a record with no absolute path

**Precondition, and it is not optional:** the member must have been **retired on or after v0.34.0**, so its
record carries `originalRelPath` and no absolute path.
**Call** `restore_member` on it.
**Correct looks like** the sessions root derived from a **sibling Session the persistence service still
reports**, the slug taken from the record, and the artifact moved back to its original path — with the
record returning to `active` and the trash entry gone.
Observed 2026-11-13: succeeded on exactly those terms. **This is the strongest check in the list**: it
proves the relative origin resolves on a live store, which no fixture can.
**If it does not match** — `unresolved-root` or a generic failure: the sibling leg did not find the root, so
the sessions root derivation is what to inspect first, not the record. A move to a path that does not exist:
the slug joined against the wrong root.

## 6. The cap runs, and a prune can archive a tombstone in the same write

**Call** a retirement that takes the trash past the effective cap.
**Correct looks like** one artifact pruned (`pruned` above zero in the retirement result) **and** an older
tombstone becoming archivable as a consequence — so the same write moves it to the archive and the file
grows by one line while the roster shrinks by one tombstone. Observed 2026-11-13: one pruned, **74 → 75**
lines, the newly archivable tombstone flushed in the same write.
**This emergent behaviour is expected and is not an error.** It is two rules meeting: the cap removes the
artifact (ADR 0011/0012), and the window then allows the record to leave because its bytes are gone (ADR
0030). A checklist reader who does not know this will read a correct run as a bug.
**If it does not match** — a pruned artifact whose record stays on the roster: the window is not being
applied on that write, so the bound is being forgotten somewhere. The archive growing without a prune: a
record left for a reason other than the cap, which the four conditions should have refused.

## 7. The host hooks report themselves, and the storage block names the file

**Call** `list_members` (with or without the flag).
**Correct looks like** `host_hooks.panel_filter`, `roster_filter` and `slot_credit` all `installed`,
`stripped_ids` equal to the number of retired child ids the filters are removing (observed 2026-11-13: 95),
and `storage.source: "file"` with a workspace `path` — not `storage-domain`, which the schema no longer
publishes (ADR 0031/0033).
**If it does not match** — a hook `absent`: that service did not exist when the plugin loaded, and the
shipped panel or `list_agents` will show members it should hide. `stripped_ids` zero while retired members
exist: the filter is installed but reading nothing, which is worse than absent because it looks healthy.
`storage.source: "none"`: this Lead was never bound, which on a real profile means the root was not
resolved.

## 8. Two Leads in one data root see only their own archived records

**Status: not yet run — one of three pending checks.** The archive is one file per data root and the
reader must answer one Lead only (ADR 0035). Today's profile has a single Lead Session, so the rule is
covered by the suite and by no live observation.
**Precondition:** two Lead Sessions sharing a data root, each with at least one archived tombstone.
**Correct looks like** each Lead's flagged read returning only its own records, with `archived_total`
matching that Lead's lines rather than the file's.
**If it does not match** — one Lead's records appearing in the other's answer: the reader is answering by
file rather than by Lead, and every count in checks 1 and 2 becomes meaningless once a second Lead exists.

## 9. One archived record is found by identity, past the cap

**Status: not yet run.**
**Precondition, and it is the whole point:** the archive must hold **more records than the cap**, with the
target living **only beyond it**. A lookup tested on a short archive passes while the feature is gone, which
is why the size of the file is part of the check rather than context.
**Call** `list_members` with `archived: true` and `archived_target` set to a target — or the raw member id —
that is older than the newest 50.
**Correct looks like** a hit returning **exactly one row**, `archived_returned: 1`, the row marked
`archived` with its `archived_at`, and `archived_scanned` reporting the lines it read — a scan larger than
50 is the evidence it looked past the window. A miss returns `archived_returned: 0` **with** `archived_scanned`,
`archived_total` and a message naming the target, never a bare empty success.
**If it does not match** — zero returned for a record you know is in the file: either the target you passed is
not that record's identity (a partial name is not a match, by design) or the scan is being capped at 50,
which is the defect this check exists for. `archived_scanned` missing on a miss, or equal to the returned
count: the answer is not reporting its cost, so a miss can no longer be told from a failed read. A hit on
prose such as `"Replaced by reviewer-g2"`: text matching came back, and identity stopped being identity.
## 10. Every member reports what it has spent, from one of three sources

**Status: not yet run.**
**Precondition, and it is the whole point:** one member of each kind — **mounted** with committed requests,
**unloaded but not retired**, and **retired on or after v0.39.0**. The retired case is the one with a
version floor: a tombstone written before v0.39.0 carries no number and never will, so a missing field there
is the correct answer rather than a failure. A checklist run on a profile whose retirements all predate that
version cannot exercise the third source at all.
**Call** `list_members` once, with no flags.
**Correct looks like** all three rows carrying `spend_tokens`: the mounted member's read from its own
projection; the **unloaded** member's read from the Host's cache, which is the case this check exists for
because it used to be absent; and the **retired** member's **frozen at its retirement** — the same number on
every later read, never growing again. On a live or unloaded row the number may grow, and it may fall between
two reads: a retry adds an attempt while a streaming sample replaced by its final one subtracts. Where the
number cannot be computed at all — including a retirement whose fold produced nothing — the field is
**omitted**, never `0`.
**If it does not match** — a number on an unloaded row that ignores everything attempted since it was last
loaded: the cache read returned a stale entry, so check whether the interval was really quiet. A retired row
with no number on a tombstone that **is** from this version or later: the capture at retirement did not
happen, and the value is unrecoverable — that is the one failure here with no second chance. A retired row
whose number **changes** between reads: the field is being recomputed from a live source instead of answered
from the tombstone. `0` anywhere nothing could be measured: the field used as a stand-in, the one thing it
must never be. A number on a row whose member is not mounted and not retired that never moves while its work
clearly spends: the listing leg did not match the header, so the identity witness is what to inspect.
## Recording a round

Write the Host version, the date, each check's observed values, and any check that could not be run and
why, into `PROGRESS.md` as one entry. A check that was skipped is recorded as skipped — silence about which
checks ran is how a procedure comes to be believed while it is broken.
