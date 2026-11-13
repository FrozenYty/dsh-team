# 0035 — The archive is readable, on request

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes:** — nothing. **ADR 0030's hot-path rule is untouched**: a plain `list_members` still never
  opens the file. What this adds is the caller saying *"this is a file read, do it"*, which is why the flag
  exists rather than a background sweep.
- **Related:** [0030](0030-tombstone-window-and-archive.md) (what is in the file), [0028](0028-trash-directory-name-not-path.md)
  (the seam shape this borrows).

## Context

ADR 0030 made the archive append-only and deliberately unreadable: a tombstone past the retention window
leaves `roster.json` for `archive.jsonl`, and no tool opens that file, because opening it on the hot path is
what the window exists to avoid. That left the history write-only — recoverable by opening a file by hand,
which is not an answer a model can give a person.

The question this ADR answers is not "should the archive be readable" but **"how does a read stay a read"**:
the file is unbounded by design, one file serves every Lead under a data root, and the append-before-replace
order that makes a crash survivable is *supposed* to leave duplicate lines.

## Decision

1. **The read happens only under `archived: true`.** A plain `list_members` never opens the file, so ADR
   0030's rule is a property of the call site rather than of the reader, and the walk crosses that boundary
   only when the flag says so.
2. **The proof is a seam that throws when called.** `listMembers` takes `readArchive`, defaulting to
   `readArchivedRecords`, and a test replaces it with one that throws. A comparison of two answers cannot
   prove that a read *did not happen*; a probe that cannot be made to explode measures something else.
   This is the shape the trash path already uses for `renameFn`.
3. **The reader carries four rules, each because the writer cannot**:
   - **one Lead's records only** — the line records the `leadSessionId` it was written for, and another
     Lead's tombstones must never appear in this answer;
   - **one row per member id** — `dedupe by member id`, because the append-before-replace crash window
     leaves duplicates **by design**, and the reader is what makes that harmless; the surviving entry
     carries the newest line that named that member;
   - **a damaged line is counted, not raised** — a crash mid-append leaves a partial last line, which is
     skipped and counted and reported as `archived_unreadable`;
   - **at most the newest 50, with the real total beside it** — `archived_returned` and `archived_total`,
     because the archive is unbounded by design and a read must not become a way to pull an unbounded file
     into one answer.
4. **A row read from the archive says so**: `archived: true` with `archived_at`, and the succession edge
   resolves against the archived records too — so a target whose predecessor left the roster reports its
   target only when this read asked for the archive, and the bare id otherwise (ADR 0032's rule, unchanged).
5. **A missing archive is not an error.** The flag asks for something that may never have been written.

## Rationale

The asymmetry is the point: the writer appends without knowing who will read it, and the reader carries
every rule that follows from that. Moving any of them to the writer would mean the writer deduplicating
history it is required to keep, or the file carrying an index that a crash could lose — which is the failure
mode append-only exists to avoid.

## Rejected alternatives

- **Read the archive on every `list_members`.** Rejected: it is exactly the hot-path read ADR 0030 forbids,
  and it would put an unbounded file in front of every routine call.
- **A separate tool (`list_archived_members`).** Rejected: one more surface for the same rows, and the
  caller already has a read whose answer is these rows.
- **Return every archived record.** Rejected: the file is unbounded, and a read that can grow with it is a
  read that eventually fails in a way nobody can explain.
- **Let a damaged line throw.** Rejected: it turns one truncated line into an unreadable history.

## Consequences

- **The history is answerable.** A person can ask what left the roster, through a tool, without opening a
  file by hand.
- **The cap is fixed at 50 and not configurable.** The honest next step if it is ever too small is another
  parameter, not a larger constant — a cap that silently grows with the file is the thing it prevents.
- **The flagged shape has not been through the Host's validator**, because `schema-check.mjs` calls
  `list_members` without the flag; the unflagged shape is what that check covers today. Stated rather than
  implied.
- **An archived record's tasks travel in its line but no tool shows them.** They are in the history and
  not in an answer, which is better than dropping them from the history and worse than showing them.

## Migration

None. The file and its lines are unchanged; this release adds a reader.

## Revisit when

The 50-record cap proves too small for a real question, which would want a parameter; or a tool needs to
show an archived record's tasks, which would want a second read rather than a wider one.

## A defect fix that was not one

The same branch carried four lines passing the caller to four call sites, on the theory that they fell back
to the process default. The theory was wrong: `install` receives a closure already bound to the agent, so
the argument was never read, and reverting the lines leaves the new test green. It was reverted at the merge
and the latent distinction is in the code comment. **It is recorded in `PROGRESS.md` and nowhere else** — a
change that turned out to be a no-op is a fact about the day, not a decision about the plugin.
