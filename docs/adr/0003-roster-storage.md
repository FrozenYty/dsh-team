# 0003 — The roster lives in `ctx.storageDomain`, not in the Session log

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —
- **Superseded by [0010](0010-roster-layout-and-retention.md)** for the record layout only. This ADR's
  "one record per member plus a per-Lead index" was never implemented; the store, the hand-written spec
  and the single-file warning below all still stand.

## Context

ADR 0001 decided the plugin owns the roster. That leaves where the roster records live. Three
candidates were examined against the installed Harness, not its public source:

1. **A new Session event type.** Forbidden in practice: readers accept an unknown stored event only
   when its envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker, so
   the Session would refuse to reopen. `appendPluginRecord()` writes ignorable `plugin:` records but is
   reserved for DSH's own experimental packages, and its records survive a format migration only
   best-effort.
2. **`ctx.storage`.** It is the hub, not a store: it exposes a backend registry and mounts form
   facilities. Nothing durable to hold a record in.
3. **`ctx.storageDomain`.** A domain store: `open(spec)` returns a handle whose tables support
   `get`/`put`/`update`/`delete`/`entries`, backed by JSON files under `$DSH_HOME/storages`.

## Decision

The roster lives in one `storageDomain` domain, opened from the Host plugin's `apply`. Inject
`storageDomain`; `open()` the domain; close it from a `ctx.effect` disposer. One table holds one record
per member, keyed by a plugin-generated member id, and a per-Lead index record maps a Lead Session id
to its member ids.

The domain is declared with a hand-written spec and a duck-typed schema whose only method is `parse`,
because a linked bundle cannot import `defineDomain` or `zod` (ADR 0002) and the `open()` path only ever
calls `.parse` on the schema.

The domain uses the default single-file layout, a `version`, and `compatibleVersions`, so an incompatible
upgrade fails loudly instead of reading old records as absent.

## Rationale

- It is the only mechanism that keeps third-party state durable without writing Session events.
- Reads are synchronous and writes resolve after the record is on disk, which is the ordering a roster
  needs: a member is only reported `active` once its record exists.
- The whole plugin state is one small JSON document per domain; no migration machinery is warranted.

## Consequences

- `$DSH_HOME/storages` is shared by every profile and every Harness process on the machine, and
  `storageDomain` has no cross-process lock. Two Harness processes over one store are last-writer-wins.
  The roster is therefore correct for one running Harness, which matches how subagents themselves work.
- The store is not part of a Session. Forking or deleting a Session does not move or clean its roster;
  a roster record outlives the Lead it belongs to. A future cleanup task may be needed.
- Schema validation on write is ours: `put` does not validate. The roster service validates before it
  writes.

## Revisit when

`storageDomain` gains cross-process locking, or the Harness provides a per-Session plugin store with
defined fork and delete semantics.
