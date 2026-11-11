# 0002 — The bundle entry imports nothing

- **Status:** Accepted
- **Date:** 2026-11-11
- **Supersedes:** —

## Context

The first version of `index.js` imported two Harness packages the obvious way:

```js
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
```

`install_bundle` reported the package as installed and then the Host refused to activate it:

```
team-control (@local/team-control): failed to import:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
imported from <repository>/index.js
```

The mechanism is structural, not a missing dependency. A bundle installed from an absolute path becomes
a `link:` dependency in the profile. The profile uses `nodeLinker: hoisted` with `autoInstallPeers:
false`, so pnpm installs neither that package's dependencies nor its peers into the linked directory.
Node resolves bare specifiers from the bundle's own real path, and neither the profile's `node_modules`
nor the dsh installation is an ancestor of it. Declaring the packages as dependencies does not help:
nothing installs them next to a linked directory.

## Decision

The Host half imports no `@deepseek-ai/*` package. It uses only `node:` builtins, relative imports, and
Cordis services reached through `ctx`. Tool definitions are written as plain canonical JSON Schema
objects — the shape `ctx.tools.register` consumes:

```js
{
  name, description, parameters,
  output: { schema, render(args, value) },
  execute(args, exec),
}
```

Plugin configuration is not declared, because a `Config` schema requires `schemastery`. When a tunable
value is needed it is either a constant in the entry or a plain field in the bundle patch.

## Rationale

- It is the only arrangement that works for a profile-linked bundle today.
- The installed first-party market plugin follows the same rule: its `lib/index.js` imports only
  `node:path` and its own relative files, despite declaring `@deepseek-ai` peers for types.
- Losing `defineTool` costs argument validation at call time; the tools validate their own inputs
  explicitly, which is what a plain-JavaScript plugin should do anyway.

## Consequences

- No `Config` schema: the plugin exposes no user-editable settings row. A value that must be tunable
  goes into the bundle patch as config on a shipped row, or becomes a constant here.
- No Harness type definitions. Every service call is dynamic, so a Harness rename fails at runtime
  rather than at build time. This is why `docs/architecture-en.md` lists the exact Services used.
- The entry must stay one self-contained file unless relative imports are added; those do resolve.

## Revisit when

The Harness changes how profile bundles resolve their dependencies — for example by giving linked
packages a resolution map, or by shipping `@deepseek-ai/*` in a location Node can reach from a linked
bundle.
