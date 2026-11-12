import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { WAIT_TIMEOUT_MAX } from '../actions.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A minimal Host context that lets `apply` install the Lead-scoped tools, plus the tool definitions it
 * registered per agent. This is the layer the unit tests never entered: `actions.js` is called
 * directly by the other suites, so an authority or validation mistake that lives only in `index.js`
 * reaches the model and nothing else.
 *
 * `cwd` mounts the `workingDirectory` service, which is what a `definition` spawn resolves the `team/`
 * directory from; omitting it is a profile without that service.
 */
function harness({ tryMembership = () => undefined, listMembers = () => [], config, capture = false, cwd } = {}) {
  const table = memoryTable()
  const tools = new Map()
  const childTools = new Map()
  const disposers = []
  const requests = []
  const lead = {
    id: 'lead-1',
    status: 'idle',
    session: { id: 'lead-1', header: {} },
    ctx: {
      tools: {
        register: (definition) => {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    },
  }
  const child = {
    id: 'child-1',
    status: 'idle',
    session: { id: 'child-1', header: { parentSession: 'lead-1' } },
    ctx: {
      tools: {
        register: (definition) => {
          childTools.set(definition.name, definition)
          return () => childTools.delete(definition.name)
        },
      },
    },
  }
  const ctx = {
    agents: {
      list: () => [lead, child],
      get: (id) => (id === lead.id ? lead : id === child.id ? child : undefined),
    },
    agentTeams: { tryMembership, listMembers },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => {
        requests.push(spec.request)
        return { childId: spec.childId }
      },
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
    },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 0, contextWindow: 0 }) },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    get: (name) => (name === 'workingDirectory' && cwd !== undefined ? { ensure: async () => cwd } : undefined),
    on: () => () => {},
    effect: (install) => {
      const dispose = install()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { warn() {} },
  }
  if (capture) {
    // A refused load must be observable together with what it did (or did not) register.
    try {
      apply(ctx, config)
      return { tools, childTools, table, lead, child, requests, error: undefined }
    } catch (error) {
      return { tools, childTools, table, lead, child, requests, error }
    }
  }
  apply(ctx, config)
  return { tools, childTools, table, lead, child, requests }
}

test('a Lead whose Team projection cannot be read still receives and can call the roster tools', async () => {
  // `tryMembership` swallows a Team-projection failure and answers undefined. Before this fix, the
  // shipped permanent-failure state meant no tools were installed, and an earlier install refused
  // every call with "available to the Team Lead only" — disabling the retirement that repairs it.
  const { tools, childTools, lead } = harness({ tryMembership: () => undefined })
  assert.ok(tools.has('list_members'), 'a live root agent is treated as the Lead')
  assert.ok(tools.has('retire_member'))
  assert.equal(childTools.size, 0, 'a member with a parent Session is not a root')

  const listed = await tools.get('list_members').execute({}, { agent: lead })
  assert.deepEqual(listed, { members: [] })
})

test('a readable membership that says teammate still wins over the root fallback', async () => {
  const { tools, childTools } = harness({ tryMembership: (agent) => ({ role: agent.id === 'child-1' ? 'teammate' : 'lead' }) })
  assert.ok(tools.has('list_members'))
  assert.equal(childTools.size, 0)
})

test('spawn_member refuses a blank label, prompt or name', async () => {
  const { tools, lead } = harness()
  const spawn = tools.get('spawn_member')
  const exec = { agent: lead }
  await assert.rejects(
    () => spawn.execute({ label: '   ', prompt: 'Do the work.' }, exec),
    /label must be a non-empty string/,
  )
  await assert.rejects(
    () => spawn.execute({ label: 'Reviewer', prompt: '\t\n' }, exec),
    /prompt must be a non-empty string/,
  )
  await assert.rejects(
    () => spawn.execute({ name: '  ', label: 'Reviewer', prompt: 'Do the work.' }, exec),
    /name must be a non-empty string/,
  )
})

test('message_member refuses a blank message and a non-Lead caller', async () => {
  const { tools, child, lead } = harness()
  await assert.rejects(
    () => tools.get('message_member').execute({ target: 'reviewer', message: '   ' }, { agent: lead }),
    /message must be a non-empty string/,
  )
  await assert.rejects(
    () => tools.get('message_member').execute({ target: 'reviewer', message: 'hello' }, { agent: child }),
    /available to the Team Lead only/,
  )
})

test('spawn_member validates spawn_options and forwards it to the activation request', async () => {
  const refused = [
    [{ cwd: 42 }, /cwd must be a non-empty string/],
    [{ cwd: '   ' }, /cwd must be a non-empty string/],
    [{ agent_options: 'cheap' }, /agent_options must be an object/],
    [{ agent_options: { model: '' } }, /model must be a non-empty string/],
    [{ agent_options: { max_tokens: 1.5 } }, /max_tokens must be a positive integer/],
    [{ agent_options: { effort: 'high' } }, /agent_options has an unknown field "effort"/],
    [{ agent_preset: 7 }, /agent_preset must be a non-empty string/],
    [{ preset: 'reader' }, /spawn_options has an unknown field "preset"/],
  ]
  for (const [spawnOptions, message] of refused) {
    const { tools, lead } = harness()
    await assert.rejects(
      () => tools.get('spawn_member').execute(
        { name: 'reviewer', label: 'Reviewer', prompt: 'Do the work.', spawn_options: spawnOptions },
        { agent: lead },
      ),
      message,
    )
  }

  // The wrapper hands the tool's fields to the operation, which composes the request and reports back
  // what was applied: this is the layer the unit tests on actions.js never enter.
  const { tools, lead, table, requests } = harness()
  const born = await tools.get('spawn_member').execute({
    name: 'reviewer',
    label: 'Reviewer',
    prompt: 'Do the work.',
    spawn_options: {
      cwd: 'packages/api',
      agent_options: { model: 'cheap-model', max_tokens: 4096 },
      agent_preset: 'reader',
    },
  }, { agent: lead })
  assert.deepEqual(requests[0].cwd, 'packages/api')
  assert.deepEqual(requests[0].agentOptions, { model: 'cheap-model', maxTokens: 4096 })
  assert.equal(requests[0].agentPreset, 'reader')
  assert.deepEqual(born.started_with, {
    cwd: 'packages/api',
    agent_options: { model: 'cheap-model', max_tokens: 4096 },
    agent_preset: 'reader',
  })
  assert.equal(table.get('lead-1').members[0].phase, 'active')
})

test('task_board validates its action surface and forwards it to the operation', async () => {
  const { tools, lead, table } = harness()
  const board = tools.get('task_board')
  assert.ok(board, 'the board is registered on the Lead context')

  await assert.rejects(() => board.execute({}, { agent: lead }), /action must be a non-empty string/)
  await assert.rejects(() => board.execute({ action: 'open' }, { agent: lead }), /action must be one of/)
  await assert.rejects(() => board.execute({ action: 'update' }, { agent: lead }), /update requires task_id/)
  await assert.rejects(() => board.execute({ action: 'delete' }, { agent: lead }), /delete requires task_id/)
  await assert.rejects(() => board.execute({ action: 'create' }, { agent: lead }), /create requires a non-empty title/)
  await assert.rejects(
    () => board.execute({ action: 'create', title: 'x', owner: 7 }, { agent: lead }),
    /owner must be a member target or null/,
  )
  await assert.rejects(
    () => board.execute({ action: 'create', title: 'x', status: 'later' }, { agent: lead }),
    /status must be "open" or "done"/,
  )

  const created = await board.execute({ action: 'create', title: 'Finish the parser tests' }, { agent: lead })
  assert.equal(created.action, 'create')
  assert.equal(created.task.status, 'open')
  assert.equal(table.get('lead-1').tasks.length, 1, 'the wrapper writes through to the roster record')
  const listed = await board.execute({ action: 'list' }, { agent: lead })
  assert.deepEqual(listed.tasks, [created.task])
  const closed = await board.execute({ action: 'update', task_id: created.task.id, status: 'done' }, { agent: lead })
  assert.equal(closed.task.status, 'done')
  const removed = await board.execute({ action: 'delete', task_id: created.task.id }, { agent: lead })
  assert.equal(removed.deleted, created.task.id)
  assert.equal(table.get('lead-1').tasks.length, 0)
})

test('wait_members validates its timeout and refuses a non-Lead caller', async () => {
  const { tools, child, lead } = harness()
  const wait = tools.get('wait_members')
  assert.ok(wait, 'the wait is registered on the Lead context')

  for (const timeout_ms of [0, -1, 1.5, '100', WAIT_TIMEOUT_MAX + 1]) {
    await assert.rejects(
      () => wait.execute({ timeout_ms }, { agent: lead }),
      /timeout_ms must be an integer from 1 through/,
    )
  }
  await assert.rejects(() => wait.execute({}, { agent: child }), /available to the Team Lead only/)

  // An empty roster can produce no change: the wait says so at once instead of blocking for its bound.
  const result = await wait.execute({}, { agent: lead })
  assert.equal(result.no_progress, true)
  assert.equal(result.timed_out, false)
})

test('the loader path reads the trash cap from the config and refuses a bad one before registering anything', () => {
  // No config at all, and an empty config row: both are the documented default, not a failure.
  for (const config of [undefined, {}]) {
    const { tools, error } = harness({ config, capture: true })
    assert.equal(error, undefined)
    assert.ok(tools.has('retire_member'), 'the tools install when the config sets no cap')
  }
  const configured = harness({ config: { trashLimit: 3 } })
  assert.ok(configured.tools.has('retire_member'), 'a configured cap installs the same tools')

  // Every out-of-range value is refused at load — this is the layer the retirement never reaches.
  const refused = [[0, '0'], [-1, '-1'], [1.5, '1.5'], ['20', '"20"'], [Number.NaN, 'NaN'], [null, 'null']]
  for (const [value, seen] of refused) {
    const { error, tools, childTools } = harness({ config: { trashLimit: value }, capture: true })
    assert.ok(error instanceof TypeError, `trashLimit: ${String(value)} must fail the load`)
    assert.match(error.message, /trashLimit/)
    assert.match(error.message, /minimum 1/)
    assert.ok(error.message.includes(seen), `the refusal names the value it saw (${seen})`)
    assert.equal(tools.size, 0, 'nothing is registered when the load is refused')
    assert.equal(childTools.size, 0)
  }
})

/**
 * Validate a tool result against the schema that tool declares for it.
 *
 * The host validates a result when the tool returns, and a property the operation produces but the
 * schema does not declare is rejected *after* the side effect has already happened. v0.13.0 shipped
 * exactly that: `spawn_member` answered with `transferred`, `MEMBER_ROW` did not declare it, and a
 * replacement moved the predecessor's work while the model was told the call failed. Every unit test
 * stayed green because they call `actions.js` directly and never go through a declared schema.
 *
 * Implements the subset the host accepts, which is also the subset `scripts/check.mjs` enforces.
 */
function assertMatchesSchema(value, schema, at = 'value') {
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter((option) => {
      try {
        assertMatchesSchema(value, option, at)
        return true
      } catch {
        return false
      }
    })
    assert.equal(matched.length, 1, `${at}: expected exactly one oneOf branch, matched ${matched.length}`)
    return
  }
  const types = {
    object: () => value !== null && typeof value === 'object' && !Array.isArray(value),
    array: () => Array.isArray(value),
    string: () => typeof value === 'string',
    integer: () => Number.isInteger(value),
    number: () => typeof value === 'number' && Number.isFinite(value),
    boolean: () => typeof value === 'boolean',
    null: () => value === null,
  }
  assert.ok(types[schema.type]?.(value), `${at}: expected ${schema.type}, saw ${JSON.stringify(value)}`)
  if (schema.enum !== undefined) assert.ok(schema.enum.includes(value), `${at}: ${JSON.stringify(value)} is not in the enum`)
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${at}: const`)
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) assert.ok(key in value, `${at}: missing required "${key}"`)
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      const declared = schema.properties?.[key]
      if (declared === undefined) {
        assert.notEqual(schema.additionalProperties, false, `${at}.${key}: not declared in the output schema`)
        continue
      }
      assertMatchesSchema(child, declared, `${at}.${key}`)
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => assertMatchesSchema(item, schema.items, `${at}[${index}]`))
  }
}

test('every answer conforms to the output schema its own tool declares', async () => {
  const { tools, lead } = harness()
  const exec = { agent: lead }
  const answer = async (name, args) => {
    const definition = tools.get(name)
    assert.ok(definition, `${name} is registered`)
    const result = await definition.execute(args, exec)
    assertMatchesSchema(result, definition.output.schema, name)
    return result
  }

  const born = await answer('spawn_member', { name: 'reviewer', label: 'Reviewer', prompt: 'Review the parser.' })
  assert.equal(born.target, 'reviewer')
  const task = await answer('task_board', { action: 'create', title: 'Recheck the curve', owner: 'reviewer' })
  await answer('list_members', {})
  const waited = await answer('wait_members', {})
  assert.equal(waited.no_progress, true, 'no member is live in this harness, so the wait reports it')

  // The exact shape v0.13.0 lost: a replacement that moves work answers with the transfer.
  const successor = await answer('spawn_member', { replace: 'reviewer', label: 'Reviewer II', prompt: 'Take over.' })
  assert.deepEqual(successor.transferred_tasks, [task.task.id])
  assert.equal(successor.transferred, 1)
  assert.equal(successor.predecessor_retired, true)

  await answer('task_board', { action: 'list' })
  await answer('task_board', { action: 'update', task_id: task.task.id, status: 'done' })
  await answer('handoff_template', {})

  // The definition layer is a second branch of this one result schema, so both answers it can give are
  // checked against the declared schema: a member started from a file, and the typed refusal (ADR 0018).
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-team-entry-'))
  await mkdir(join(cwd, 'team'), { recursive: true })
  await writeFile(join(cwd, 'team', 'reviewer.md'), '---\nname: reviewer\nlabel: Check the diff\n---\nReview.\n')
  const defined = harness({ cwd })
  const spawnDefined = defined.tools.get('spawn_member')
  const fromFile = await spawnDefined.execute({ definition: 'reviewer' }, { agent: defined.lead })
  assertMatchesSchema(fromFile, spawnDefined.output.schema, 'spawn_member')
  assert.equal(fromFile.target, 'reviewer')
  assert.deepEqual(fromFile.definition.from_file, ['name', 'label', 'prompt'])
  assert.deepEqual(defined.table.get('lead-1').members.map((member) => member.name), ['reviewer'])

  const refused = await spawnDefined.execute({ definition: 'missing' }, { agent: defined.lead })
  assertMatchesSchema(refused, spawnDefined.output.schema, 'spawn_member')
  assert.equal(refused.started, false)
  assert.equal(refused.reason, 'definition-not-found')
  assert.equal(defined.table.get('lead-1').members.length, 1, 'a refusal reserves no member')

  // A profile without the service: the working-directory refusal is the other branch of the same answer.
  const unserviceable = harness()
  const noService = await unserviceable.tools.get('spawn_member')
    .execute({ definition: 'reviewer' }, { agent: unserviceable.lead })
  assertMatchesSchema(noService, unserviceable.tools.get('spawn_member').output.schema, 'spawn_member')
  assert.equal(noService.reason, 'working-directory-unavailable')
})
