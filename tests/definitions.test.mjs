import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { spawnMember } from '../actions.js'
import { DEFINITION_DIR, DEFINITION_FILE_MAX, DEFINITION_LIMIT, parseDefinition } from '../definitions.js'
import { apply } from '../index.js'
import { readRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A context fake carrying what a definition spawn reads, plus the `workingDirectory` service the
 * definition layer resolves the `team/` directory from. `cwd` is the directory the service answers;
 * omitting it is a profile that mounts no such service, which is the typed refusal.
 */
function fakeCtx({ cwd, ensureFails = false } = {}) {
  const started = []
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => {
        started.push(spec.request)
        return { childId: spec.childId }
      },
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
    },
    agents: { get: () => undefined },
    get: (name) => {
      if (name !== 'workingDirectory' || cwd === undefined) return undefined
      return {
        ensure: async () => {
          if (ensureFails) throw new Error('the directory does not resolve')
          return cwd
        },
      }
    },
    started,
  }
}

const lead = { id: 'lead-1', status: 'idle', session: { id: 'lead-1', header: {} } }

const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

const call = (ctx, table, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: '/tmp/dsh-team-test',
  hooks: hooks(),
  ...extra,
})

/** A fresh working directory holding a `team/` directory, and one writer for it. */
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-team-definitions-'))
  const dir = join(cwd, DEFINITION_DIR)
  await mkdir(dir, { recursive: true })
  const write = async (file, text) => {
    await writeFile(join(dir, file), text, 'utf8')
  }
  return { cwd, dir, write }
}

/**
 * A Host context that lets `apply` register the tools, so the refusal can be checked through the same
 * wrapper the model calls (the layer the direct `actions.js` tests never enter).
 */
function toolHarness(ctx = fakeCtx()) {
  const tools = new Map()
  const scoped = {
    ...lead,
    ctx: {
      tools: {
        register: (definition) => {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    },
  }
  const host = {
    ...ctx,
    agents: { list: () => [scoped], get: () => scoped },
    agentTeams: { tryMembership: () => undefined, listMembers: () => [] },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 0, contextWindow: 0 }) },
    storageDomain: { open: async () => ({ table: () => memoryTable(), close: async () => {} }) },
    on: () => () => {},
    effect: (install) => {
      const dispose = install()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { warn() {} },
  }
  host.get = (name) => ctx.get(name)
  apply(host, undefined)
  return { tools, spawn: tools.get('spawn_member'), scoped }
}

/** A complete definition: the two required fields, every optional one, and a body. */
const REVIEWER = `---
name: reviewer
label: Check the diff
assignment: Keep the parser green
ephemeral: true
provider: cheap-provider
model: cheap-model
max_tokens: 4096
agent_preset: reader
---
Review the diff and report only findings that change behaviour.
`

test('a definition supplies the label, the prompt, the assignment and the start options', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', REVIEWER)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()

  const born = await spawnMember(call(ctx, table, { definition: 'reviewer' }))

  assert.equal(born.target, 'reviewer', 'the name comes from the file')
  assert.equal(born.label, 'Check the diff')
  assert.equal(born.assignment, 'Keep the parser green')
  assert.equal(born.ephemeral, true)
  assert.equal(born.phase, 'active')
  // The body is the prompt, and the request carries exactly it.
  assert.equal(ctx.started[0].prompt[0].text, 'Review the diff and report only findings that change behaviour.')
  assert.deepEqual(ctx.started[0].agentOptions, { provider: 'cheap-provider', model: 'cheap-model', maxTokens: 4096 })
  assert.equal(ctx.started[0].agentPreset, 'reader')
  // What the result says about the file: everything came from it, nothing was overridden.
  assert.equal(born.definition.name, 'reviewer')
  assert.ok(born.definition.path.endsWith(join(DEFINITION_DIR, 'reviewer.md')))
  assert.equal(born.definition.prompt, 'file')
  assert.deepEqual(born.definition.from_file, [
    'name', 'label', 'assignment', 'ephemeral', 'agent_preset', 'provider', 'model', 'max_tokens', 'prompt',
  ])
  assert.deepEqual(born.definition.overridden, [])
  assert.equal(born.definition.problems, undefined)
  // The record is the roster's, exactly as an inline spawn would write it.
  const stored = readRoster(table, 'lead-1').members.find((member) => member.name === 'reviewer')
  assert.equal(stored.label, 'Check the diff')
  assert.equal(stored.assignment, 'Keep the parser green')
})

test('an explicit argument overrides the definition, and the result says which one won', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', REVIEWER)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()

  const born = await spawnMember(call(ctx, table, {
    definition: 'reviewer',
    name: 'auditor',
    label: 'Audit the release',
    prompt: 'Start with the changelog.',
    ephemeral: false,
    agentOptions: { model: 'large-model' },
  }))

  // Precedence: the call wins, field by field.
  assert.equal(born.target, 'auditor')
  assert.equal(born.label, 'Audit the release')
  assert.equal(born.ephemeral, undefined, 'the call turned the file\'s one-shot member into a normal one')
  assert.deepEqual(ctx.started[0].agentOptions, { provider: 'cheap-provider', model: 'large-model', maxTokens: 4096 })
  // The body is never dropped: the call's prompt is appended after the definition's own prompt.
  assert.equal(
    ctx.started[0].prompt[0].text,
    'Review the diff and report only findings that change behaviour.\n\nStart with the changelog.',
  )
  assert.equal(born.definition.prompt, 'file+call')
  assert.deepEqual(born.definition.from_file, ['assignment', 'agent_preset', 'provider', 'max_tokens', 'prompt'])
  assert.deepEqual(born.definition.overridden.sort(), ['ephemeral', 'label', 'model', 'name'])
})

test('a nested, anchored or duplicated frontmatter is refused with the line, and starts nothing', async () => {
  const cases = [
    ['nested.md', 'nested', '---\nname: nested\nlabel: Check\nmodel:\n  provider: x\n---\nbody\n', 4],
    ['anchored.md', 'anchored', '---\nname: anchored\nlabel: &shared Check\n---\nbody\n', 3],
    ['twice.md', 'twice', '---\nname: twice\nlabel: Check\nlabel: Check again\n---\nbody\n', 4],
  ]
  for (const [file, name, text, line] of cases) {
    const { cwd, write } = await workspace()
    await write(file, text)
    const ctx = fakeCtx({ cwd })
    const table = memoryTable()
    const result = await spawnMember(call(ctx, table, { definition: name }))
    assert.equal(result.started, false, `${file}: the spawn is refused, not thrown`)
    assert.equal(result.reason, 'definition-invalid', `${file}: the directory holds a refused file`)
    assert.equal(result.problems[0].line, line, `${file}: the refusal names the line`)
    assert.ok(result.problems[0].path.endsWith(file), `${file}: the refusal names the file`)
    assert.equal(ctx.started.length, 0, `${file}: nothing was started`)
    assert.equal(table.get('lead-1'), undefined, `${file}: no member was reserved`)
  }

  // The parser is the same answer without a spawn, so the line arithmetic is checked directly too.
  const nested = parseDefinition('---\nname: nested\nlabel: Check\nmodel:\n  provider: x\n---\nbody\n', 'nested.md')
  assert.equal(nested.problem.line, 4)
  assert.match(nested.problem.problem, /indented/)
  const duplicate = parseDefinition('---\nname: twice\nlabel: A\nlabel: B\n---\nbody\n', 'twice.md')
  assert.match(duplicate.problem.problem, /"label" is declared twice/)
  assert.match(duplicate.problem.problem, /line 3/)
  const block = parseDefinition('---\nname: blocked\nlabel: Check\nassignment: |\n  two lines\n---\nbody\n', 'blocked.md')
  assert.equal(block.problem.line, 4)
  assert.match(block.problem.problem, /block scalar/)
  const anchored = parseDefinition('---\nname: anchored\nlabel: &shared Check\n---\nbody\n', 'anchored.md')
  assert.equal(anchored.problem.line, 3)
  assert.match(anchored.problem.problem, /anchor/)
})

test('an unknown field is refused by name, with the accepted field set', async () => {
  const { cwd, write } = await workspace()
  await write('typo.md', '---\nname: typo\nlabel: Check\ndescripton: a misspelling\n---\nbody\n')
  const ctx = fakeCtx({ cwd })

  const result = await spawnMember(call(ctx, memoryTable(), { definition: 'typo' }))
  assert.equal(result.started, false)
  assert.equal(result.reason, 'definition-invalid')
  assert.equal(result.problems[0].line, 4)
  assert.match(result.problems[0].problem, /unknown field "descripton"/)
  // The accepted set is listed, so the author does not have to read the parser.
  assert.match(
    result.problems[0].problem,
    /name, label, assignment, ephemeral, cwd, provider, model, reasoning_effort, max_tokens, agent_preset/,
  )
  assert.equal(ctx.started.length, 0)
})

test('two files declaring one name are refused naming both, so neither is used', async () => {
  const { cwd, write } = await workspace()
  await write('a-first.md', '---\nname: reviewer\nlabel: First\n---\nfirst body\n')
  await write('b-second.md', '---\nname: reviewer\nlabel: Second\n---\nsecond body\n')
  const ctx = fakeCtx({ cwd })

  const result = await spawnMember(call(ctx, memoryTable(), { definition: 'reviewer' }))
  assert.equal(result.started, false)
  assert.equal(result.reason, 'definition-invalid')
  const duplicate = result.problems.find((problem) => problem.problem.includes('also declared'))
  assert.ok(duplicate, 'the duplicate is reported')
  assert.ok(duplicate.path.endsWith('b-second.md'))
  assert.match(duplicate.problem, /a-first\.md:2/)
  assert.equal(duplicate.line, 2)
  assert.deepEqual(result.available, [], 'a name two files claim is usable from neither')
  assert.equal(ctx.started.length, 0, 'nothing is started from an ambiguous name')
})

test('a malformed file does not stop a valid one, and is still reported', async () => {
  const { cwd, write } = await workspace()
  await write('good.md', '---\nname: reviewer\nlabel: Check the diff\n---\nReview.\n')
  await write('bad.md', '---\nname: broken\nlabel: Check\nprovider:\n  model: nested\n---\nbody\n')
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()

  const born = await spawnMember(call(ctx, table, { definition: 'reviewer' }))
  assert.equal(born.target, 'reviewer', 'the valid definition still starts a member')
  assert.equal(born.phase, 'active')
  assert.ok(born.definition.path.endsWith('good.md'))
  assert.equal(born.definition.problems.length, 1, 'the refused file is reported on the successful result')
  assert.ok(born.definition.problems[0].path.endsWith('bad.md'))
  assert.equal(born.definition.problems[0].line, 4)
})

test('the file-size and file-count caps refuse rather than truncate', async () => {
  // One oversized file: it is refused, and a valid definition beside it still works — the cap is per
  // file, so it cannot hide the rest.
  const sized = await workspace()
  await sized.write('huge.md', `---\nname: huge\nlabel: Check\n---\n${'x'.repeat(DEFINITION_FILE_MAX)}\n`)
  await sized.write('small.md', '---\nname: small\nlabel: Check\n---\nSmall.\n')
  const sizedCtx = fakeCtx({ cwd: sized.cwd })
  const born = await spawnMember(call(sizedCtx, memoryTable(), { definition: 'small' }))
  assert.equal(born.target, 'small')
  const oversize = born.definition.problems[0]
  assert.ok(oversize.path.endsWith('huge.md'))
  assert.match(oversize.problem, new RegExp(`cap is ${DEFINITION_FILE_MAX}`))
  assert.match(oversize.problem, /refused rather than truncated/)
  // The oversized definition is never half-read: asking for it by name finds nothing usable.
  const refused = await spawnMember(call(sizedCtx, memoryTable(), { definition: 'huge' }))
  assert.equal(refused.started, false)
  assert.deepEqual(refused.available, ['small'])

  // The count cap is on the directory: a partial set is never served, so the whole scan is refused.
  const crowded = await workspace()
  for (let index = 0; index <= DEFINITION_LIMIT; index += 1) {
    await crowded.write(`member-${index}.md`, `---\nname: member-${index}\nlabel: Check\n---\nBody.\n`)
  }
  const crowdedCtx = fakeCtx({ cwd: crowded.cwd })
  const over = await spawnMember(call(crowdedCtx, memoryTable(), { definition: 'member-0' }))
  assert.equal(over.started, false)
  assert.equal(over.reason, 'definitions-over-limit')
  assert.match(over.message, new RegExp(`${DEFINITION_LIMIT + 1} markdown files`))
  assert.match(over.message, new RegExp(`at most ${DEFINITION_LIMIT}`))
  assert.equal(crowdedCtx.started.length, 0)
})

test('a Lead whose working directory cannot be resolved gets the typed refusal and nothing is reserved', async () => {
  const cases = [
    ['no service', fakeCtx(), /mounts no workingDirectory service/],
    ['unresolvable', fakeCtx({ cwd: 'ignored', ensureFails: true }), /could not be resolved/],
  ]
  for (const [label, ctx, message] of cases) {
    const table = memoryTable()
    const result = await spawnMember(call(ctx, table, { definition: 'reviewer' }))
    assert.equal(result.started, false, label)
    assert.equal(result.reason, 'working-directory-unavailable', label)
    assert.equal(result.definition, undefined, `${label}: no name can be looked up without a directory`)
    assert.match(result.message, message)
    assert.equal(ctx.started.length, 0, `${label}: nothing was started`)
    assert.equal(table.get('lead-1'), undefined, `${label}: no member was reserved`)
  }

  // The same refusal through the tool wrapper, which is the layer the direct calls never enter.
  const { spawn, scoped } = toolHarness()
  const answer = await spawn.execute({ definition: 'reviewer' }, { agent: scoped })
  assert.equal(answer.started, false)
  assert.equal(answer.reason, 'working-directory-unavailable')
})

test('a definition name is required to satisfy the same rule as an inline label and prompt', async () => {
  const { spawn, scoped } = toolHarness()
  await assert.rejects(() => spawn.execute({}, { agent: scoped }), /label is required unless definition is given/)
  await assert.rejects(
    () => spawn.execute({ label: 'Reviewer' }, { agent: scoped }),
    /prompt is required unless definition is given/,
  )
  await assert.rejects(
    () => spawn.execute({ definition: '   ' }, { agent: scoped }),
    /definition must be a non-empty string/,
  )
  await assert.rejects(
    () => spawn.execute({ definition: 'reviewer', label: '  ' }, { agent: scoped }),
    /label must be a non-empty string/,
  )
})

test('a definition that is not declared lists the names that are', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', REVIEWER)
  await write('auditor.md', '---\nname: auditor\nlabel: Audit\n---\nAudit.\n')
  const ctx = fakeCtx({ cwd })

  const result = await spawnMember(call(ctx, memoryTable(), { definition: 'reviewr' }))
  assert.equal(result.started, false)
  assert.equal(result.reason, 'definition-not-found')
  assert.equal(result.definition, 'reviewr')
  assert.deepEqual(result.available, ['auditor', 'reviewer'])
  assert.match(result.message, /No usable member definition named "reviewr"/)
  assert.equal(ctx.started.length, 0)

  // An absent team directory is the same answer rather than an error: a Lead that keeps no definitions.
  const bare = await mkdtemp(join(tmpdir(), 'dsh-team-definitions-empty-'))
  const missing = await spawnMember(call(fakeCtx({ cwd: bare }), memoryTable(), { definition: 'reviewer' }))
  assert.equal(missing.reason, 'definition-not-found')
  assert.deepEqual(missing.available, [])
})
