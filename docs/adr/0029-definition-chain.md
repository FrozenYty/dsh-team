# 0029 — Member definitions are read from a chain, and the shipped templates are its last leg

- **Status:** Accepted
- **Date:** 2026-11-13
- **Supersedes [0018](0018-member-definitions.md) for point 1 only** — *"The path is
  `<Lead working directory>/team/*.md`"* and *"one `team/` directory rather than a path parameter"*. The
  frontmatter subset and its refusals, the caps, the typed refusal, the one-parameter surface and ADR
  0019's precedence on a `replace` all still stand.
- **Also amends [0021](0021-team-file-handoff-template.md) for its shared-directory premise only** — the
  team file keeps the path that ADR gave it, and the premise that a member definition sits in the same
  directory no longer holds. The reservation decision itself is unchanged.

## Context

ADR 0018 put a member definition at `<Lead working directory>/team/*.md`. That was right for the question
it answered — a path both the model and the plugin can name, resolved through the same service the spawn
seam uses for a relative `cwd` — and it left two things unsaid.

The first is what a profile that has never written a definition sees. The feature that makes a team
reviewable is invisible until somebody authors five files, so the first experience of it is authoring
work, not using it. The second is that `<workspace>/team/` is the *project's* directory, while the state
this plugin owns moved to `<workspace>/.agents/team/` when the roster file did (ADR 0027): the canonical
home for a definition the plugin reads is beside the roster, not in a directory whose other contents the
plugin knows nothing about.

A third fact is a constraint rather than a reason. A project that has been carrying its own `reviewer.md`
for a year must not have it quietly replaced by a bundled file of the same name.

## Decision

**A member definition is read from a chain of three directories, most specific first, and the first
declaration of a name wins.**

1. `<workspace>/.agents/team/definitions/` — the canonical location, beside the roster file. The plugin
   owns this directory in the same sense it owns `roster.json`: it reads it and never rewrites it.
2. `<workspace>/team/` — where every profile before this release kept its definitions. It outranks the
   shipped templates, because a user's own file must never be quietly replaced by a bundled one of the
   same name, which is exactly what a shipped `reviewer.md` would do to a project carrying its own.
3. `templates/definitions/` inside the bundle — the five starting points this release ships. They are the
   last leg, so any file the workspace has beats them.

**A name declared twice in the same directory is still refused.** That is an ambiguity no precedence rule
can resolve, and it stays a typed refusal naming both files. A name declared in two *different*
directories is simply the more specific file winning, which is what a chain is for.

**A malformed file blocks only the name it claims.** It is reported by path and line, and the rest of the
chain is still read, so one broken definition cannot take the other four out of service.

**Shipped templates are never written to.** The plugin reads them; a profile that wants to change one
copies it into either workspace directory, where it wins.

**The team file does not move.** It stays at `<workspace>/team/team.md` (ADR 0021), because it is not a
member definition, it has no shipped counterpart, and it is one artifact per project rather than one per
member. The asymmetry is deliberate: `.agents/team/` holds the roster file and the definitions the plugin
owns, `team/` holds the project's own team file and any definitions a project prefers to keep there. A
reader who meets the two paths side by side should read that as a decision, not as an unfinished move.

## Rejected alternatives

- **Keep one directory and document the shipped templates as examples to copy.** Rejected: it leaves the
  first spawn in a fresh profile with no definitions at all, and it makes "where do I start" a paragraph
  of instructions instead of a working default.
- **Put the shipped templates first, so a profile always gets the maintained version.** Rejected: it
  silently replaces a project's own file of the same name. The plugin would be editing the meaning of a
  member without touching a file, which is the failure mode this repository spends the most effort on.
- **Copy the templates into the workspace on first use.** Rejected: it writes into the user's project at
  spawn time, which is a surprise, and it creates a second writer of files the project believes it owns.
- **A config key naming the definition directory.** Rejected: it adds a setting nobody asked for, and it
  makes the canonical location a profile-specific fact rather than a documented one.

## Consequences

- **The chain is part of the refusal.** A `definition` that names nothing now reports the directories it
  searched, so "not found" says where it looked instead of only what it wanted.
- **A definition can come from the bundle.** The result says which directory a definition was read from,
  so a caller can tell a project's file from a shipped one without reading the filesystem.
- **Two locations are now legitimate, and one of them is invisible to version control.** A definition
  under `.agents/team/definitions/` is as real as one under `team/`; a project that wants its members
  reviewed in a diff keeps using `team/`.
- **The reservation rule keeps working unchanged.** `team.md` is skipped by the member scan wherever the
  scan reads, which is the only thing ADR 0021's decision needed.

## Revisit when

A shipped template has to be editable in place, which would need either a fourth leg or a copy-on-write
rule; or a project wants a definition to win in one directory while losing in another, which would mean
the chain has stopped being a precedence order.
