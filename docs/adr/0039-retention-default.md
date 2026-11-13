# 0039 — The retention default, and the window it means

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes, as one clause:** [0012](0012-configurable-retention.md)'s decision point 2 — precisely
  *"The default is documented and is not hardcoding: `DEFAULT_TRASH_LIMIT = 20`"*. The default becomes
  **200**. What carries over from 0012 unchanged is named below; its mechanism is not touched.
- **Related:** [0011](0011-trash-retention.md) (whose `TRASH_LIMIT = 20` this number came from, already
  superseded for point 1 by 0012), [0030](0030-tombstone-window-and-archive.md) (where a record goes when
  its bytes are gone).

## Context

The cap was 20, and 20 was inherited rather than chosen: it arrived from the shipped Agent Teams roster's
`maxMembers` reasoning (ADR 0011) and was carried forward unchanged when the cap became configurable (ADR
0012). Nothing had measured it.

**What the measurement says.** On this machine twenty trash directories occupy **4.2 MB** — an average of
**210 KB** each, the largest **467 KB**. Two hundred is therefore about **41 MB**, against **616 GB free**
on the same volume. And what the cap destroys is **irreversible**: a pruned artifact cannot be restored —
not by configuration, not by a later release — while the archive keeps only the record of it, never the
bytes.

**A default belongs on the generous side when the failure is irreversible and the cost is a rounding
error.** That sentence is the decision. 41 MB is 0.007% of the free space available; a person who loses a
transcript loses it permanently. The asymmetry is the whole argument, and it does not depend on these exact
numbers: it holds for any machine where transcripts are small relative to a disk.

## Decision

1. **The default is 200.** A profile that configures nothing keeps two hundred retired artifacts per Lead
   instead of twenty.
2. **The window is stated where the decision to retire is made.** Until now a person learned the cap existed
   from a refusal (`restore_member` answering `pruned`) or from a prune message **after** the bytes were
   gone. `retire_member` and `restore_member` will say what the cap means — **that it is the undo horizon,
   how many retirements back recovery reaches, and that past it the artifact is gone** — before it bites.
   The intent is recorded here; the wording lands with the code.
3. **The cost becomes visible.** `list_members` will report the trash's **count and size per Lead**, so the
   number can be **chosen** rather than inherited, and "why did my artifact disappear" has an answer instead
   of an archaeology exercise. **The walk is bounded by the cap itself**, so it cannot grow without limit:
   it inspects at most the entries the cap allows to exist.

## What carries over from ADR 0012, unchanged

- **The cap exists** — retirement is a move into a bounded trash, and the bound is enforced inside a
  retirement that actually moved an artifact in (ADR 0011 point 2).
- **The effective value comes from the patch row's `trashLimit`**, resolved by `resolveTrashLimit`.
- **The minimum is 1**, and a value outside the range is **refused rather than clamped**, naming the field,
  the value seen and the minimum.
- **The pruning semantics**: oldest first, one artifact per retirement past the cap, a `pending` move never
  pruned, only direct children whose name and tombstone both parse.

## The escape hatch, recorded rather than built

If session artifacts ever grow large enough that 200 stops being a rounding error, **compressing the
artifact** changes this trade by roughly an order of magnitude — the same cap would cost about a tenth of
the space. It is **deliberately not done now**, because it puts a decompression step into what is currently
a move: the trash becomes readable only through the plugin, and every restore gains a failure mode the
filesystem does not have. It becomes worth doing when the measured average artifact size is large enough
that 200 × average is no longer a rounding error on a typical free-space figure.

## And one sentence that must be said plainly

**Raising the default restores nothing already pruned.** On this machine **75 retired records have no bytes
left**; their history lives in the archive and their transcripts are gone for good. This decision changes
what happens from the next retirement on, and it cannot reach backwards — the artifacts it would have kept
were removed before it existed.

## Rejected alternatives

- **Leave it at 20.** The measurement does not support it: 20 × 210 KB ≈ 4.2 MB is not a bound worth the
  irreversible loss it causes.
- **Make it configurable with no default change.** It already is configurable; a person who never edits a
  patch row inherits 20, and inheriting a number nobody chose is the actual defect.
- **Unbounded retention.** The cap exists because the trash is inside the workspace and a workspace is
  copied, backed up and carried; unbounded growth trades a small disk cost for a large one on a different
  operation.
- **Compress now.** See above — a decompression step in the move path is a real cost for a problem that has
  not been measured yet.

## Consequences

- **A larger workspace trash**: about 41 MB at the sizes measured here, per Lead, on the volume the
  workspace lives on.
- **A restore reaches further back**, and the refusal that says `pruned` becomes rarer — a person is more
  likely to get their transcript back, which is the point.
- **The three statements arrive together in intent**, though the code may land in more than one change: the
  number, the window said out loud, and the per-Lead cost in the read.
- **Not implemented in this version.** v0.38.1 still ships `DEFAULT_TRASH_LIMIT = 20`; this ADR records the
  decision the next change implements, so a reader checking the shipped constant is not misled.

## Revisit when

The measured average artifact size makes 200 × average stop being a rounding error, which would make
compression worth its decompression step; or the per-Lead size report shows a distribution so skewed that a
count cap is the wrong shape and a byte cap is the right one.
