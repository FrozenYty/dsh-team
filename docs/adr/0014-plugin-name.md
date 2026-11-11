# 0014 — The plugin is renamed `dsh-team-relay`, and its stored names stay frozen

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

The plugin was called `dsh-team-roster` and displayed as *Team roster* / *团队花名册*. That name described
the piece of state — a roster — rather than what the plugin is for. What it actually does is hand a
member's work to a successor: retire, replace, and take back. A roster is the bookkeeping; the relay is
the thing being delivered. The owner chose a new name, `dsh-team-relay`, displayed as *Team relay* /
*团队接力*, and this ADR records it because a package identity is expensive to reverse: the bundle is
linked into a running profile, so the name is read by the profile, the provider inspect surface and the
installed plugin's own row.

The rename is version `0.10.0`. A rename is a new identity for a package that is linked into a profile
rather than vendored, and a version that only moved a patch number would hide the change from both the
lockfile and a reader.

## Decision

1. **The package, the patch row's `name` and the display title are `dsh-team-relay`, `Team relay` and
   `团队接力`.** `package.json` is the identity; the bundle patch's inserted row declares the same name,
   which is what `scripts/check.mjs` pins; `locale/en.json` and `locale/zh.json` change the title and
   keep their descriptions (`Retire it, replace it, take it back.` / `该退就退，该换就换，还能找回来。`)
   unchanged — the rename does not change what the plugin does.
2. **The `team` segment is kept.** It names the thing the plugin operates on: an agent *team*. The
   familiar packages in this ecosystem — `dsh-subagent`, the shipped Agent Teams row, the shared task
   board — are all team-scoped, and a name that dropped `team` would have to earn a new association.
   `relay` is the second half of the same thought: the member run moves on, the work does not stop.
3. **The two contracts are frozen and must not be renamed with the package.** They are places where data
   or configuration already exists, not part of the display identity. Each is documented where it lives
   so a later reader does not "fix" it by finishing the rename:

   | Frozen contract | Where it is declared | Why renaming it breaks something |
   |---|---|---|
   | storage domain `team_roster` | `roster.js`, `ROSTER_SPEC` | It names where every roster record and every tombstone already lives. A new domain name is an empty domain: a running profile would see no members at all, and `restore_member` would lose the tombstones it depends on. Moving it requires a copy migration like the one from `team_control`, not a rename. |
   | patch row id `team-roster` | `cordis.patch.yml`, the inserted row | It is the override target a profile writes (`- id: team-roster` + `config: { trashLimit: … }`). Renaming it would make every existing profile's override stop matching silently, and the cap would quietly fall back to the default with no error. |

   Two more names follow the same rule for the same reason, and are recorded in `trash.js` as well: the
   data directory `~/.dsh/team-roster` and the environment variable `DSH_TEAM_ROSTER_DATA_DIR`. Every
   tombstone on disk records an absolute `trashPath` under that directory while `pruneLeadTrash` lists
   that same root, so renaming it would leave recorded paths outside the scanned root — the trash would
   look empty, the cap would stop seeing those artifacts, and `restore_member` would move files back from
   a directory nothing writes to. The variable keeps working as a legacy name;
   `DSH_TEAM_RELAY_DATA_DIR` is the new spelling and wins when both are set.

4. **Earlier documents keep saying `dsh-team-roster`, and that is correct.** `PROGRESS.md` is append-only
   and an accepted ADR is closed, so entries and ADR bodies written before this change are historical
   facts: the plugin *was* called that then. That is why ADR 0012 still shows the provider reporting
   `include:team-roster` with package `dsh-team-roster` and the refusal quoted as
   `dsh-team-roster: config field …`, and why ADR 0004, 0005, 0006, 0010 and 0011 still name the trash
   path under `~/.dsh/team-roster`. The same applies to the v0.3 note that renamed the storage domain from
   `team_control` to `team_roster` — it is the record of that migration, not a current name. After this
   change the provider reports `include:dsh-team-relay` with `patchId: team-roster`, and a refusal reads
   `dsh-team-relay: config field …`. A current document (the README pair, `docs/architecture-*.md`,
   `AGENTS.md`, `CONTRIBUTING.md`, `PLAN.md`) names the project as `dsh-team-relay`, because those
   describe the present.
5. **The repository URL becomes `https://github.com/FrozenYty/dsh-team-relay`** once the repository is
   renamed. The directory the bundle is installed from is not renamed by this change; the Lead does that
   after the branch merges.

## Alternatives rejected

- **Rename everything, including the four frozen identifiers.** Rejected: it trades one coherent name for
  an orphaned roster, an invisible trash and silently ignored profile configuration. A migration could
  move the data, but a patch row id cannot be migrated at all — it is a key the profile chooses — and
  invisible tombstones break `restore_member` until a migration has run for every profile.
- **Keep the package name and change only the display title.** Rejected: the package name is what the
  profile links and reports; a bundle whose title and identity disagree confuses exactly the surface the
  rename exists to improve.
- **Keep `team-roster` in the variable and directory but rename them silently later.** Rejected: that is
  how a name drifts — two spellings, one of them undocumented. They are in this table instead.
- **Rewrite the old `PROGRESS.md` entries and ADR bodies to say `dsh-team-relay`.** Rejected: they were
  true when written, and a historical record that is corrected to the present cannot be trusted about
  anything else.
- **Call the new release `0.9.1`.** Rejected: a rename is not a patch. The version moves to `0.10.0` so
  an installed profile, its lockfile and this ADR all agree that the package identity changed.

## Consequences

- A profile that had this bundle installed must be pointed at `dsh-team-relay` once; the row's `id` and
  `config` are unchanged, so its `trashLimit` override keeps applying.
- The display name, the row `name` and the documentation agree; the durable state, the profile override
  and the trash keep working without a migration.
- Any future rename has this ADR as the pattern: rename the identity, freeze the storage and the
  configuration keys, and record why in the document, not in the commit message.

## Revisit when

The storage facility gains a rename-with-migration primitive, a profile can address a patch row by
package name instead of by id, or the plugin stops storing tombstones — any of which would remove the
reason an identifier is frozen and let the remaining names follow the package.
