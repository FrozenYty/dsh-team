# 0009 — Replacement hands over the record, and the successor starts before the predecessor is retired

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

P2-05 asks for one model-facing call that retires a member and installs its successor with the
predecessor's work handed over. The owner's original complaint was that people could not be removed at
all; removal works now, but a successor starts from nothing, so the feature is still incomplete.

Three decisions had to be made together, because each constrains the others:

1. **Which surface.** A new `replace_member` tool is the obvious shape, and it is the name ADR 0001 and
   `PLAN.md` used. But the operations already exist as `spawn_member` and `retire_member`, and a model
   that must learn a third name for the same job is worse off than one that widens a call it already
   knows.
2. **Ordering.** Retiring first and starting second is the order the words suggest. When the start then
   fails, the predecessor is already in the trash, its work is briefed to nobody, and the only way back
   is `restore_member`.
3. **What the brief contains.** A successor is a cold child: it has no transcript, and the roster only
   held a label and timestamps. The plugin therefore needs something durable about the assignment, and
   the work itself lives on the shared team task board, which this plugin does not own.

## Decision

**No new tool name. `spawn_member` gains `replace` and `assignment`; `message_member` gains
`assignment`.**

1. `spawn_member({ name?, label, prompt, assignment?, replace? })`. With `replace`, `name` defaults to
   the predecessor's base name, so the existing `planMember` naming rule yields the next generation
   (`reviewer` → `reviewer-g2`) unless the model names the successor. A model-set `assignment` is
   capped at 1000 characters; the durable record refuses anything longer, so a store cannot grow without
   limit.
2. `message_member({ target, message, assignment? })` replaces the recorded assignment, because the
   moment the Lead tells a member what to do is the moment that record changes. It is stored only after
   the message is accepted, so a refused delivery does not silently rewrite the record. This is
   deliberately not a new `assign_member` tool: it is the same act as the message.
3. **The successor starts first; the predecessor is retired second, in the same call.** A failed start
   therefore changes nothing: the predecessor is untouched and still live, and the failed reservation is
   recorded as the successor's `failed` record — the thrown error says the predecessor was not retired.
   A failed retirement leaves two live members, which one more `retire_member` call recovers, and the
   returned row says `predecessor_retired: false` with the reason. Neither half can report success on
   its own.
4. The successor's prompt is composed by this plugin from the predecessor's record: the successor's
   name, the predecessor's target and label, the recorded assignment, the fact that the predecessor is
   gone, and a pointer to the shared team task board under the predecessor's name. The board is not
   copied and not duplicated. A successor inherits the predecessor's assignment unless the model records
   a different one, so the handoff does not thin out one generation at a time.
5. An already-retired target is accepted as `replace`: the tombstone supplies the brief and the retire
   half is a no-op, which is what the state matrix already says a retire on a retired member is.

## Rationale

- The one thing the model cannot redo cheaply is a lost member; the one thing it can redo cheaply is a
  second call. The chosen order spends the redoable half on failure.
- The brief must be short and self-contained because a cold child pays for every word of it. Pointing at
  the board by the predecessor's name is both shorter and more correct than copying task rows that may
  already have changed.
- The assignment is what turns a label plus timestamps into a handoff. Keeping it on the member record
  means it survives retirement as a tombstone fact, exactly like `trashPath`.

## Alternatives rejected

- **A separate `replace_member` tool.** It would duplicate `spawn_member`'s parameters and its start
  path, and give the model a third name for one operation. The task title in `PLAN.md` was reworded
  instead of the tool being added.
- **Retire, then spawn.** Loses the predecessor on a start failure. The failure is recoverable, but only
  through a trash move the model has to know about.
- **An `assign_member` tool.** A fourth write tool whose whole parameter set is one string; the update
  belongs where the new work is given.
- **A brief the member writes before it is retired** (`docs/architecture-en.md` §4.4 as first drafted).
  It costs a model round-trip on a member that may be unresponsive or already failed, which is exactly
  when a handoff is needed. It remains a candidate for P4-02, alongside the stored template.
- **A per-member brief file.** A second artifact to keep in sync with the record that already holds the
  assignment.

## Consequences

- `spawn_member`'s result carries `replaced` and `predecessor_retired` beside the member row, and the
  prompt the successor actually received is not echoed back; the assignment is, because the Lead needs
  to see what the successor will be told.
- A partial retirement leaves the successor's brief saying the predecessor is gone while the predecessor
  is still live. The result says so in the same sentence, and the next `retire_member` makes it true.
- The assignment is model-written, so it can be stale or thin. `list_members` reports it per row, which
  is what lets the Lead notice before replacing.
- Existing records carry no `assignment`; the field is optional and nothing migrates.

## Revisit when

P2-09 gives this plugin its own task board (the brief then names that board instead of the shipped one),
or the Harness ships a handoff or replacement primitive that makes the composed prompt unnecessary.
