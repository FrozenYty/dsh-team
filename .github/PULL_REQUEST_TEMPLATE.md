## What changed

<!-- One or two sentences. If it needs "and", it is probably two PRs. -->

## How it was verified

<!-- Commands run, tools called, numbers observed. Not "tested locally". -->

## Affected modules

<!-- plugin / bundle / roster / ui / docs / ci -->

## Effect on a running profile

<!-- Does installing this change behaviour outside the plugin's own tools? Enabling or disabling a
     shipped row does. Say which row and what it now does. If nothing, write "none". -->

## Documents touched

<!-- Which of these did you have to change? Tick, or write "none". The list is in docs/INDEX-en.md §4. -->
- [ ] a tool name, parameter or result field → `docs/architecture-en.md`, README pair
- [ ] a roster phase or transition → the state matrix, and an ADR if the model changed
- [ ] a bundle config key or patch row → README pair, `docs/architecture-en.md` §1
- [ ] the durable record shape → `docs/architecture-en.md` §4.2 and a new ADR
- [ ] a document added, renamed or removed → `docs/INDEX-en.md` and `INDEX-zh.md`

## Checklist

- [ ] `node --check index.js` passes
- [ ] `node scripts/check.mjs` passes
- [ ] Bilingual pairs updated in this same PR
- [ ] `PLAN.md` task box ticked only for work actually delivered
- [ ] A `PROGRESS.md` entry added if behaviour changed (append-only, never rewrite an older entry)
- [ ] No machine-specific path in any shared document
- [ ] If installed for testing: the exact commands run and their result are in "How it was verified"
