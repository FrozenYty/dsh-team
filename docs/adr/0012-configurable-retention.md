# 0012 — The trash cap is a config field, not a constant

- **Status:** Accepted. **Its default value is replaced by
  [0039](0039-retention-default.md)** (`DEFAULT_TRASH_LIMIT` becomes 200); the mechanism this ADR decided —
  the field, the minimum, the refusal — is untouched.
- **Date:** 2026-11-11
- **Supersedes [0011](0011-trash-retention.md) for point 1 only** — *"A fixed per-Lead cap: `TRASH_LIMIT = 20` … the constant is fixed on purpose."* Points 2–7 of 0011 stand unchanged: enforcement happens only inside a retirement that moved an artifact in, oldest first, conservatively about what it touches, never a move in flight, the tombstone stays truthful, and the result is reported.

## Context

ADR 0011 rejected a configurable cap on a mirror-the-platform argument: *"the shipped roster bounds members with a constant, and a safety cap nobody asked to tune is not a configuration surface."* The owner has overruled that decision:

> 官方是可配置的，我们别写死代码 — the official one is configurable; do not hardcode.

They are right, and the evidence is on their side. The live Host Config provider reports the official
Agent Teams row (`include:agent-team`, package `@deepseek-ai/dsh-experimental-agent-team`) with
`status: "schema"` and this projected schema:

```
maxMembers:        { default: 16,    minimum: 1 }
maxTasks:          { default: 256,   minimum: 1 }
maxMessageBytes:   { default: 65536, minimum: 1 }
disposalTimeoutMs: { default: 5000,  minimum: 1 }
```

That is a declared Config field with a default and a `minimum`, not a literal. The same provider reports
this bundle's entry (`include:team-roster`, `patchId: team-roster`, package `dsh-team-roster`) with
`status: "absent"`, because this entry declares no Config at all.

`minimum` is an acceptance bound, not a clamp: the official schema rejects a value below it. Any design
here has to reject too, not silently round.

## What was verified, and where

Read out of the installed asar, not from the public source tree.

**A plugin `Config` export is consumed, and what it must be.** `@deepseek-ai/cordis` `lib/index.js`
keeps the export on the plugin runtime (`Config: plugin.Config`, line 1703) and validates with it on
activation (line 359, `const config = this.resolveConfig(this.config)`):

```js
// @deepseek-ai/cordis/lib/index.js:244-250
function resolveConfig(runtime, config) {
	if (!runtime.Config) return config;
	const result = runtime.Config["~standard"].validate(config);
	if ("then" in result) throw new TypeError("Async config validation is not supported");
	if (result.issues) throw new ValidationError(result.issues);
	else return result.value;
}
```

So a `Config` export must be a **Standard Schema v1** object. A plain object with `type`, `properties`
and `default` — the shape ADR 0002 hoped for — has no `~standard`, and `runtime.Config["~standard"]`
is `undefined`, so activation throws `TypeError: Cannot read properties of undefined (reading
'validate')`. That failure is loud rather than silent, but it is still a failure: **a plain object does
not work.** Note what the `if (!runtime.Config) return config` branch means: with **no** `Config`
export the raw patch config is passed to `apply` unchanged.

**The Config inspect provider wants more than Standard Schema.** It reports `status: "schema"` only for
a native Schemastery graph: `@deepseek-ai/dsh-tool-cordis` `lib/types/config.js` lines 12–17 return
`absent` when there is no `Config` and `unsupported` when there is one that fails
`isNativeConfigSchema`, and `@deepseek-ai/dsh-app-boot` `lib/index.js` lines 3197–3201 define that
predicate as `Reflect.get(value, Symbol.for("schemastery")) === true && typeof value.type === "string"
&& typeof value.meta === "object"`. The profile schema generator is stricter still: lines 4152–4155 of
the same file record an **error** diagnostic, *"Config is not a native Schemastery schema"*, for any
`Config` that is present and not native, and line 3963 makes a document carrying an error diagnostic
`complete: false`.

**A hand-written Standard Schema is therefore possible but second-class.** It needs no import (the spec
package is types-only), Cordis would validate with it, and it would remove the point-2 validation from
our code. But both Schemastery consumers would treat it as foreign: the Config provider would say
`unsupported` instead of `schema` and project no JSON Schema, and the profile schema document would
carry an error diagnostic. It buys less visibility than it costs in surprise.

**The patch row does reach `apply`.**
`@deepseek-ai/cordis-plugin-loader` `lib/index.js` lines 588–591 unwraps the module and calls
`ctx.registry.plugin(plugin, this.options.config, …)`, and its `unwrapExports` (lines 812–817) returns
the module namespace itself when there is no default export, so a named `Config` export would be found
there and the row's `config` is the value passed to the plugin callback. The patch dialect is
`@deepseek-ai/dsh-app-boot` `lib/index.js` lines 505–553: a non-insert patch is matched by `id` and
every supplied field replaces the row's field wholesale — `config` is replaced, never deep-merged.

## Decision

1. **The cap is a config field of this bundle's patch row: `trashLimit`, an integer with a minimum of
   1.** `apply(ctx, config)` resolves it with `resolveTrashLimit` (`trash.js`) as its **first**
   statement, before any registration, storage open or host hook, and passes the resolved number to
   `install`, `retireMember` and `spawnMember`. An out-of-range value therefore fails the load, which is
   the same moment the official schema refuses.
2. **The default is documented and is not hardcoding: `DEFAULT_TRASH_LIMIT = 20`**, the value ADR 0011
   shipped. A profile that configures nothing behaves exactly as it did before, and `TRASH_LIMIT` is
   renamed `DEFAULT_TRASH_LIMIT` because it is no longer the authority — `apply` is.
3. **A value outside the range is refused, not clamped**, with a message naming the field, the value it
   saw and the minimum:
   `dsh-team-roster: config field "trashLimit" must be an integer >= 1 (minimum 1); received 0`.
   This covers `0`, negatives, fractions, numeric strings, `NaN`, and `null` when the field is present
   (the official schema admits `null` only because its `anyOf` also accepts a Loader expression; a
   bundle with no schema has no such reason to guess). An absent or `undefined` field takes the default.
4. **The effective value is what the retirement enforces and prints.** `pruneLeadTrash` is called with
   the resolved limit rather than falling back to its own default, and the message says which cap was
   actually in force, so an operator reading the result is not reading a constant. The `retire_member`
   tool description carries the effective number for the same reason.
5. **No `Config` export, deliberately, and the entry keeps reporting `status: "absent"`.** ADR 0002
   forbids the Schemastery import, and the consumers above accept nothing else as native; declaring a
   foreign schema would trade `absent` for `unsupported` plus an error diagnostic. The field is
   nonetheless validated and enforceable at load, which is what the owner asked for.

## Rejected alternatives

- **Keep the fixed constant (ADR 0011's decision).** Superseded: the platform's own comparable knob is a
  declared config field, and the owner asked explicitly not to hardcode.
- **A plain object `Config` (`type`/`properties`/`default`).** Rejected on the verified mechanism: it has
  no `~standard`, so activation throws before `apply` ever runs. The silent-acceptance failure mode does
  not apply here; the failure is a hard one.
- **A hand-written Standard Schema object.** Works for Cordis validation and needs no import, but the
  Config provider reports `unsupported` and projects no schema, and the profile schema generator emits
  an error diagnostic. More surprise than value while the Cap field is validated at load anyway.
- **An environment variable (`DSH_TEAM_ROSTER_TRASH_LIMIT`).** Already rejected by ADR 0011 and still
  rejected: the patch is the Harness's own edit surface for a row, it is per-profile rather than
  per-process, and it needs no new documentation of a second mechanism.
- **A `!!js` expression in the row's config.** Legal in the dialect, but it would put a piece of
  JavaScript in a profile the operator edits by hand, and it does not give a minimum or a refusal.

## Consequences

- The cap is now visible to an operator in the file they already edit, and the refusal happens where a
  configuration mistake belongs: at load, with the field, the value and the minimum in the message.
- `apply` gained a second parameter and is the one place the value is resolved; `retireMember` and
  `spawnMember` take it as a request field with the documented default so the unit tests and any future
  caller stay honest. A retirement started by `spawn_member { replace }` runs at the same cap as a
  direct `retire_member`, because both take it from the same place.
- The plugin still declares no Config, so `include:team-roster` keeps reporting `status: "absent"`. That
  is a statement about the *schema projection*, not about configurability: the field is read, validated
  and enforced. The README pair and `docs/architecture-en.md` say both, so the next reader does not
  mistake `absent` for "not configurable".
- A lower cap prunes sooner and a higher one keeps more recoverable artifacts; both are the operator's
  call, and the default is unchanged for every profile that says nothing.

## Revisit when

The Harness lets a plugin's Config be something other than a native Schemastery schema — for example by
projecting a Standard Schema, or by giving a linked bundle a resolution map for `@deepseek-ai/*` (the
ADR 0002 revisit trigger). At that point the field can carry a real `Config` schema and this ADR's
point 5 can be dropped.
