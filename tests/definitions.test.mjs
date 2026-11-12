import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listMembers, messageMember, spawnMember, taskBoard } from '../actions.js'
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

/**
 * A definition whose `assignment` is the role's standing sentence — true of the job, not of what any one
 * incumbent is doing. On a replacement it is the value that must lose to the predecessor's recorded
 * assignment: a file that silently replaced it would brief each successor with the job instead of the
 * work, which is the defect v0.17.0 fixes (ADR 0019).
 */
const STANDING_ASSIGNMENT = `---
name: reviewer
label: Check the diff
assignment: Keep the parser green
---
Review the diff and report only findings that change behaviour.
`

/** The same role, declared one-shot: the file's `ephemeral` applies on a replace too (ADR 0019). */
const ONE_SHOT = `---
name: reviewer
label: Check the diff
assignment: Keep the parser green
ephemeral: true
---
Review the diff and report only findings that change behaviour.
`

/** The definition's other start options: cwd, model route and preset, all of them the role's. */
const ROLE_OPTIONS = `---
name: reviewer
label: Check the diff
cwd: packages/adapter
provider: cheap-provider
model: cheap-model
max_tokens: 4096
agent_preset: reader
---
Review the diff and report only findings that change behaviour.
`

/** One definition-backed spawn's record, by base name and generation. */
const recordNamed = (table, name, generation) => readRoster(table, 'lead-1').members
  .find((member) => member.name === name && member.generation === generation)

/** Start the predecessor every replacement test works from: a recorded assignment, no definition. */
const recordedPredecessor = (ctx, table) => spawnMember(call(ctx, table, {
  name: 'reviewer',
  label: 'Check the diff',
  prompt: 'Start on the parser.',
  assignment: 'Finish the parser unit tests.',
}))

test('a replacement inherits the recorded assignment, not the definition\'s standing sentence', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', STANDING_ASSIGNMENT)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()
  await recordedPredecessor(ctx, table)

  const successor = await spawnMember(call(ctx, table, { replace: 'reviewer', definition: 'reviewer' }))

  assert.equal(successor.target, 'reviewer-g2')
  // ADR 0009's inheritance, which the file's standing sentence must not defeat: the successor is
  // briefed with what the predecessor was doing, not with the role the file describes.
  assert.equal(successor.assignment, 'Finish the parser unit tests.')
  assert.equal(successor.definition.assignment, 'predecessor', 'the answer says which assignment won and where it came from')
  assert.ok(!successor.definition.from_file.includes('assignment'), 'the file supplied none of the winner')
  const brief = ctx.started.at(-1).prompt[0].text
  assert.match(brief, /Finish the parser unit tests\./)
  assert.ok(!brief.includes('Keep the parser green'), 'the standing sentence never reaches a successor')
  assert.equal(recordNamed(table, 'reviewer', 2).assignment, 'Finish the parser unit tests.', 'the record carries it too')
  assert.equal(recordNamed(table, 'reviewer', 1).assignment, 'Finish the parser unit tests.', 'the tombstone keeps what it was doing')
})

test('an assignment on the replace call wins over both the record and the definition', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', STANDING_ASSIGNMENT)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()
  await recordedPredecessor(ctx, table)

  const successor = await spawnMember(call(ctx, table, {
    replace: 'reviewer',
    definition: 'reviewer',
    assignment: 'Rewrite the parser for the new grammar.',
  }))

  assert.equal(successor.assignment, 'Rewrite the parser for the new grammar.')
  assert.equal(successor.definition.assignment, 'call')
  assert.ok(successor.definition.overridden.includes('assignment'), 'the file declared one and the call replaced it')
  assert.ok(!successor.definition.from_file.includes('assignment'))
  assert.equal(recordNamed(table, 'reviewer', 2).assignment, 'Rewrite the parser for the new grammar.')
  // The brief describes the predecessor, so its assignment line is still the predecessor's record — and
  // the call's assignment is what a *later* successor of this member will be briefed with.
  const brief = ctx.started.at(-1).prompt[0].text
  assert.match(brief, /What it was doing: Finish the parser unit tests\./)
  assert.ok(!brief.includes('Keep the parser green'))
})

test('a definition assignment applies when the predecessor recorded none', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', STANDING_ASSIGNMENT)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()
  await spawnMember(call(ctx, table, {
    name: 'reviewer',
    label: 'Check the diff',
    prompt: 'Start on the parser.',
  }))

  const successor = await spawnMember(call(ctx, table, { replace: 'reviewer', definition: 'reviewer' }))

  assert.equal(successor.assignment, 'Keep the parser green', 'nothing to inherit, so the file describes the work')
  assert.equal(successor.definition.assignment, 'file')
  assert.ok(successor.definition.from_file.includes('assignment'))
  // The brief describes the predecessor, which recorded nothing, so its fallback sentence is honest —
  // the successor's own assignment is the file's standing one, held on its record.
  assert.match(ctx.started.at(-1).prompt[0].text, /not recorded; take it from this Lead's task board with list_my_tasks/)
  assert.equal(recordNamed(table, 'reviewer', 2).assignment, 'Keep the parser green')
})

test('a fresh spawn from a definition still takes the file\'s assignment, and reports it', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', STANDING_ASSIGNMENT)
  const ctx = fakeCtx({ cwd })

  const born = await spawnMember(call(ctx, memoryTable(), { definition: 'reviewer' }))

  assert.equal(born.assignment, 'Keep the parser green', 'no replace, so nothing changed for a fresh spawn')
  assert.equal(born.definition.assignment, 'file')
  assert.ok(born.definition.from_file.includes('assignment'))
})

test('the file\'s ephemeral applies on a replace, and the sweep then orphans the work it inherited', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', ONE_SHOT)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()
  await recordedPredecessor(ctx, table)
  const task = await taskBoard({
    table,
    leadSessionId: 'lead-1',
    action: 'create',
    title: 'Recheck the curve',
    owner: 'reviewer',
  })

  const successor = await spawnMember(call(ctx, table, { replace: 'reviewer', definition: 'reviewer' }))

  // The file describes the role, so a replace starts the role — including its one-shot nature.
  assert.equal(successor.target, 'reviewer-g2')
  assert.equal(successor.ephemeral, true)
  assert.equal(successor.assignment, 'Finish the parser unit tests.', 'the inheritance still wins the assignment')
  assert.equal(successor.transferred, 1, 'the predecessor\'s work moved to the successor first')
  assert.equal(typeof recordNamed(table, 'reviewer', 2).startedAt, 'string', 'the sweep has its evidence')

  // The consequence the matrix states plainly: a one-shot successor retires itself once its turn ends,
  // and the work it just inherited loses its owner (ADR 0017) unless the Lead messages it first.
  const after = await listMembers(call(ctx, table))
  assert.equal(after.swept, 1)
  assert.deepEqual(after.swept_targets, ['reviewer-g2'])
  assert.equal(after.unowned, 1)
  assert.deepEqual(after.unowned_tasks, [task.task.id])
  assert.equal(recordNamed(table, 'reviewer', 2).phase, 'retired')
  const board = await taskBoard({ table, leadSessionId: 'lead-1', action: 'list' })
  assert.equal(board.tasks.find((row) => row.id === task.task.id).owner, undefined)
})

test('the file\'s cwd and model fields apply on a replace; the predecessor\'s start options are not inherited', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', ROLE_OPTIONS)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()
  await spawnMember(call(ctx, table, {
    name: 'reviewer',
    label: 'Check the diff',
    prompt: 'Start on the parser.',
    assignment: 'Finish the parser unit tests.',
    cwd: 'packages/legacy',
    agentOptions: { model: 'predecessor-model' },
  }))

  await spawnMember(call(ctx, table, { replace: 'reviewer', definition: 'reviewer' }))

  // The file describes the role's environment; the predecessor's own start options are not on its
  // record, so they cannot be inherited and the file is what supplies these fields.
  assert.equal(ctx.started.at(-1).cwd, 'packages/adapter')
  assert.deepEqual(ctx.started.at(-1).agentOptions, {
    provider: 'cheap-provider',
    model: 'cheap-model',
    maxTokens: 4096,
  })
  assert.equal(ctx.started.at(-1).agentPreset, 'reader')

  // ... and every one of them is still the call's to override, field by field.
  const overridden = await spawnMember(call(ctx, table, {
    replace: 'reviewer-g2',
    definition: 'reviewer',
    cwd: 'packages/call',
    agentOptions: { model: 'call-model' },
  }))
  assert.equal(ctx.started.at(-1).cwd, 'packages/call')
  assert.deepEqual(ctx.started.at(-1).agentOptions, {
    provider: 'cheap-provider',
    model: 'call-model',
    maxTokens: 4096,
  })
  assert.equal(ctx.started.at(-1).agentPreset, 'reader')
  assert.ok(overridden.definition.overridden.includes('cwd'))
  assert.ok(overridden.definition.overridden.includes('model'))
  assert.deepEqual(overridden.started_with, {
    cwd: 'packages/call',
    agent_options: { provider: 'cheap-provider', model: 'call-model', max_tokens: 4096 },
    agent_preset: 'reader',
    // The provider came from the file and the model from the call; either way the route is the caller's,
    // so the plugin forwarded it rather than resolving one (ADR 0024).
    route_source: 'caller',
  })
})

test('a message replaces the assignment and clears the ephemeral flag a definition set', async () => {
  const { cwd, write } = await workspace()
  await write('reviewer.md', ONE_SHOT)
  const ctx = fakeCtx({ cwd })
  const table = memoryTable()
  await recordedPredecessor(ctx, table)
  const successor = await spawnMember(call(ctx, table, { replace: 'reviewer', definition: 'reviewer' }))
  assert.equal(successor.ephemeral, true)

  // A message is where the definition stops speaking: it is not read again, and the two fields it
  // owned — the assignment and the one-shot flag — are the call's from here on (ADR 0013, ADR 0019).
  const messaged = await messageMember(call(ctx, table, {
    target: 'reviewer-g2',
    message: 'The parser moved on; take the cache change.',
    assignment: 'Review the cache change.',
  }))
  assert.equal(messaged.sent, true)
  assert.equal(messaged.ephemeral, false)
  assert.equal(messaged.assignment, 'Review the cache change.')
  const record = recordNamed(table, 'reviewer', 2)
  assert.equal(record.ephemeral, undefined)
  assert.equal(record.assignment, 'Review the cache change.')

  const listed = await listMembers(call(ctx, table))
  assert.equal(listed.swept, undefined, 'the message declared it is not one-shot')
  assert.equal(listed.members.find((member) => member.target === 'reviewer-g2').phase, 'active')
})
