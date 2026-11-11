import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A minimal Host context that lets `apply` install the Lead-scoped tools, plus the tool definitions it
 * registered per agent. This is the layer the unit tests never entered: `actions.js` is called
 * directly by the other suites, so an authority or validation mistake that lives only in `index.js`
 * reaches the model and nothing else.
 */
function harness({ tryMembership = () => undefined, listMembers = () => [], config, capture = false } = {}) {
  const table = memoryTable()
  const tools = new Map()
  const childTools = new Map()
  const disposers = []
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
      startActivation: async (request) => ({ childId: request.childId }),
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
    },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 0, contextWindow: 0 }) },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    get: () => undefined,
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
      return { tools, childTools, table, lead, child, error: undefined }
    } catch (error) {
      return { tools, childTools, table, lead, child, error }
    }
  }
  apply(ctx, config)
  return { tools, childTools, table, lead, child }
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
