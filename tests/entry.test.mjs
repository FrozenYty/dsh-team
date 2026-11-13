import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { WAIT_TIMEOUT_MAX } from '../actions.js'
import { ROSTER_FILE_NAME } from '../roster.js'
import { TEAM_DIR } from '../trash.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A minimal Host context that lets `apply` install the Lead-scoped tools, plus the tool definitions it
 * registered per agent. This is the layer the unit tests never entered: `actions.js` is called
 * directly by the other suites, so an authority or validation mistake that lives only in `index.js`
 * reaches the model and nothing else.
 *
 * `cwd` mounts the `workingDirectory` service, which is what a `definition` spawn resolves the `team/`
 * directory from; omitting it is a profile without that service. `route` mounts the Lead Session's
 * `requestHeader()` — the source a member's route is resolved from (ADR 0024); omitting it is a Session
 * whose header cannot be read, which is the inherit path.
 */
/**
 * The roster file, addressed the way these tests used to address the storage domain's table.
 *
 * The store writes a file now (`roster.json` under the Lead's root) instead of the domain, so a test that
 * seeds a record, or reads back what a tool wrote, has to look where the bytes are. `get` is synchronous
 * like the table it replaces — the assertions that use it are not async — and `put` writes a whole record
 * the way the store's own table does, with a bumped serial so the store notices a second writer.
 * @param {string} workspace - the Lead's temporary working directory.
 * @returns {{get: Function, entries: Function, put: Function}} a table-shaped view of the file.
 */
function rosterFile(workspace) {
  const file = join(workspace, TEAM_DIR, ROSTER_FILE_NAME)
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, serial: 0, rosters: {} })
  return {
    get: (leadSessionId) => load().rosters[leadSessionId],
    entries: () => Object.entries(load().rosters),
    async put(leadSessionId, value) {
      const current = load()
      await mkdir(join(workspace, TEAM_DIR), { recursive: true })
      await writeFile(file, `${JSON.stringify({ ...current, serial: current.serial + 1, rosters: { ...current.rosters, [leadSessionId]: value } }, null, 2)}\n`, 'utf8')
    },
  }
}

function harness({ tryMembership = () => undefined, listMembers = () => [], config, capture = false, cwd, route } = {}) {
  const tools = new Map()
  const childTools = new Map()
  const disposers = []
  const requests = []
  // Every Lead is bound to a root now, so a session with no working directory would write its roster under
  // the real home directory — which a test must never touch. A production session always has one; here it
  // is a fresh temporary workspace per harness, so two tests never share a roster file either.
  const workspace = join(tmpdir(), `dsh-team-entry-${randomUUID()}`)
  const table = rosterFile(workspace)
  const domain = memoryTable()
  const leadSession = route === undefined
    ? { id: 'lead-1', header: { cwd: workspace } }
    : { id: 'lead-1', header: { cwd: workspace }, requestHeader: () => ({ config: route }) }
  const lead = {
    id: 'lead-1',
    status: 'idle',
    session: leadSession,
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
      // The spawn provider's capability table: forwarding agentOptions requires it, so the probe the
      // plugin uses has to be mounted here for the route path to run at all (ADR 0024).
      getProvider: (name) => (name === 'spawn'
        ? { name, capabilities: { agentOptions: true, agentPreset: true } }
        : undefined),
    },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 0, contextWindow: 0 }) },
    storageDomain: { open: async () => ({ table: () => domain, close: async () => {} }) },
    get: (name) => {
      if (name === 'workingDirectory' && cwd !== undefined) return { ensure: async () => cwd }
      // The service the plugin already declares as a hard dependency. `sessionController` is
      // deliberately absent: it is the one a Web profile publishes later, which is the load-order
      // defect this harness now lets the tests model (ADR 0025).
      if (name === 'agentTeams') return { tryMembership, listMembers }
      return undefined
    },
    // Cordis's dependency gate: a service present when the plugin loads runs the callback at once, and
    // one that never appears leaves it pending, which is what `host_hooks` reports as absent. Cordis
    // activates the real fiber a microtask later; nothing here observes that difference.
    inject: (names, callback) => {
      if (names.every((name) => ctx.get(name) !== undefined)) callback()
      return { then: () => {} }
    },
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
  assert.equal(tools.has('list_my_tasks'), false, 'the member read is not a Lead tool')
  assert.deepEqual([...childTools.keys()], ['list_my_tasks'], 'a member with a parent Session gets the member read')

  const listed = await tools.get('list_members').execute({}, { agent: lead })
  assert.deepEqual(listed.members, [])
  // The host-hook report is part of the answer now, and this harness models the load-order defect: no
  // `sessionController`, so the panel filter is absent and says why (ADR 0025).
  assert.equal(listed.host_hooks.panel_filter, 'absent')
  assert.equal(listed.host_hooks.roster_filter, 'installed')
  assert.equal(listed.host_hooks.slot_credit, 'absent')
  assert.equal(listed.host_hooks.stripped_ids, 0)
  assert.equal(listed.host_hooks.tombstone_read_failed, false)
  assert.match(listed.host_hooks.message, /sessionController/)
  assert.match(listed.host_hooks.message, /agentTeams\.roster/)
})

test('a readable membership that says teammate still wins over the root fallback', async () => {
  const { tools, childTools } = harness({ tryMembership: (agent) => ({ role: agent.id === 'child-1' ? 'teammate' : 'lead' }) })
  assert.ok(tools.has('list_members'))
  assert.deepEqual([...childTools.keys()], ['list_my_tasks'])
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
    // The call named a model, so the route is the caller's and the plugin resolved no second one: this
    // Lead's Session exposes no `requestHeader()` in the harness fake either way (ADR 0024).
    route_source: 'caller',
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
    () => board.execute({ action: 'create', title: 'x', body: 7 }, { agent: lead }),
    /body must be a string or null/,
  )
  await assert.rejects(
    () => board.execute({ action: 'create', title: 'x', status: 'later' }, { agent: lead }),
    /status must be "open" or "done"/,
  )

  const created = await board.execute({
    action: 'create',
    title: 'Finish the parser tests',
    body: 'Done when the parser suite is green.',
  }, { agent: lead })
  assert.equal(created.action, 'create')
  assert.equal(created.task.status, 'open')
  assert.equal(table.get('lead-1').tasks[0].body, 'Done when the parser suite is green.', 'the wrapper writes the body through')
  const listed = await board.execute({ action: 'list' }, { agent: lead })
  assert.deepEqual(listed.tasks, [created.task])
  const closed = await board.execute({ action: 'update', task_id: created.task.id, status: 'done' }, { agent: lead })
  assert.equal(closed.task.status, 'done')
  assert.equal(closed.task.body, 'Done when the parser suite is green.', 'a write that names no body keeps it')
  const removed = await board.execute({ action: 'delete', task_id: created.task.id }, { agent: lead })
  assert.equal(removed.deleted, created.task.id)
  assert.equal(table.get('lead-1').tasks.length, 0)
})

test('a member reads only its own rows, and the member read cannot show the whole board', async () => {
  const { tools, childTools, table, lead, child } = harness()
  const now = new Date().toISOString()
  await table.put('lead-1', {
    leadSessionId: 'lead-1',
    members: [
      { memberId: 'child-1', name: 'reviewer', generation: 1, childId: 'child-1', phase: 'active', label: 'Reviewer', createdAt: now },
      { memberId: 'child-2', name: 'auditor', generation: 1, childId: 'child-2', phase: 'active', label: 'Auditor', createdAt: now },
      { memberId: 'child-3', name: 'scribe', generation: 1, childId: 'child-3', phase: 'active', label: 'Scribe', createdAt: now },
    ],
    tasks: [
      { id: 'mine-open', title: 'Mine, still owed', body: 'Done when the parser suite is green.', status: 'open', owner: 'reviewer', created_at: now },
      { id: 'mine-done', title: 'Mine, finished', status: 'done', owner: 'reviewer', created_at: now },
      { id: 'theirs', title: 'Another member\'s work', status: 'open', owner: 'auditor', created_at: now },
      { id: 'nobody', title: 'Unowned work', status: 'open', created_at: now },
    ],
  })

  assert.equal(tools.has('list_my_tasks'), false, 'the Lead\'s tool set did not gain the member read')
  const myTasks = childTools.get('list_my_tasks')
  assert.ok(myTasks, 'the member read is registered on the member context')

  const answer = await myTasks.execute({}, { agent: child })
  assertMatchesSchema(answer, myTasks.output.schema, 'list_my_tasks')
  assert.equal(answer.target, 'reviewer')
  assert.deepEqual(answer.tasks.map((task) => task.id), ['mine-open', 'mine-done'])
  assert.equal(answer.open, 1)
  assert.equal(answer.tasks[0].body, 'Done when the parser suite is green.', 'the body the brief omits is readable here')
  assert.ok(!answer.tasks.some((task) => task.owner !== 'reviewer'), 'no other member\'s row and no unowned row')

  // The Lead still sees the whole board through its own tool, unchanged and complete.
  const board = await tools.get('task_board').execute({ action: 'list' }, { agent: lead })
  assert.equal(board.tasks.length, 4)

  // A member that owns nothing gets an empty list and a sentence, not an error.
  const idle = await myTasks.execute({}, { agent: { session: { id: 'child-3' } } })
  assertMatchesSchema(idle, myTasks.output.schema, 'list_my_tasks empty')
  assert.equal(idle.target, 'scribe')
  assert.deepEqual(idle.tasks, [])
  assert.equal(idle.open, 0)

  // A caller the roster cannot place is refused, and the Lead is told which tool it has instead.
  await assert.rejects(
    () => myTasks.execute({}, { agent: { session: { id: 'stranger' } } }),
    /available to a Team member only/,
  )
  await assert.rejects(
    () => myTasks.execute({}, { agent: lead }),
    /available to a Team member only[\s\S]*task_board/,
  )
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
  const { tools, childTools, table, lead, child } = harness()
  const exec = { agent: lead }
  const answer = async (name, args) => {
    const definition = tools.get(name)
    assert.ok(definition, `${name} is registered`)
    const result = await definition.execute(args, exec)
    assertMatchesSchema(result, definition.output.schema, name)
    return result
  }

  const born = await answer('spawn_member', { name: 'reviewer', label: 'Reviewer', prompt: 'Review the parser.' })
  // The member-scoped read is a second declared shape: point the spawned row's child id at the harness's
  // member Agent, so a real answer goes through the wrapper and its own output schema (ADR 0022). This is a
  // second writer touching the file, so it goes in before the next store write, which is the point the
  // store merges a change it did not write (T2) — a plain read serves what this process loaded.
  const spawned = table.get('lead-1')
  await table.put('lead-1', {
    ...spawned,
    members: spawned.members.map((member) => (member.name === 'reviewer' ? { ...member, childId: 'child-1' } : member)),
  })
  const task = await answer('task_board', {
    action: 'create',
    title: 'Recheck the curve',
    owner: 'reviewer',
    body: 'Done when the curve is rechecked against the shipped build. Stopped at the fixture.',
  })
  assert.equal(task.task.body, 'Done when the curve is rechecked against the shipped build. Stopped at the fixture.')
  const myTasks = childTools.get('list_my_tasks')
  assert.ok(myTasks, 'the member read is registered on the member context')
  const mine = await myTasks.execute({}, { agent: child })
  assertMatchesSchema(mine, myTasks.output.schema, 'list_my_tasks')
  assert.deepEqual(mine.tasks.map((row) => row.id), [task.task.id], 'the member reads the work it was given')
  assert.equal(mine.tasks[0].body, task.task.body)
  await answer('list_members', {})
  // The message result changed shape in v0.25.0 (`lifetime` and `reopened` replaced the cleared flag), so
  // an accepted message is validated against the schema the tool declares — a field the host does not see
  // declared is dropped after the delivery already happened (ADR 0026).
  const sent = await answer('message_member', { target: 'reviewer', message: 'Carry on with the review.' })
  assert.equal(sent.sent, true)
  assert.equal(sent.lifetime, 'standing')
  assert.equal(Object.hasOwn(sent, 'reopened'), false, 'only a one-shot member is re-opened by a message')
  const waited = await answer('wait_members', {})
  assert.equal(waited.no_progress, true, 'no member is live in this harness, so the wait reports it')

  // The exact shape v0.13.0 lost: a replacement that moves work answers with the transfer.
  const successor = await answer('spawn_member', { replace: 'reviewer', label: 'Reviewer II', prompt: 'Take over.' })
  assert.deepEqual(successor.transferred_tasks, [task.task.id])
  assert.equal(successor.transferred, 1)
  assert.equal(successor.predecessor_retired, true)

  // The durable succession link is the field this release adds, and it reaches the model through two
  // declared shapes: the successor's own answer carries `predecessor`, and the read serves both directions
  // on the rows it lists (ADR 0032). A field the operation produces but the schema does not declare is
  // rejected by the host *after* the replacement already happened, so both answers above and below go
  // through `assertMatchesSchema`.
  const replacedRecord = table.get('lead-1').members.find((member) => member.name === 'reviewer' && member.generation === 1)
  assert.deepEqual(successor.predecessor, { target: 'reviewer', member_id: replacedRecord.memberId })
  const linked = await answer('list_members', {})
  const retiredRow = linked.members.find((row) => row.target === 'reviewer')
  const liveRow = linked.members.find((row) => row.target === 'reviewer-g2')
  assert.deepEqual(retiredRow.successor, { target: 'reviewer-g2', member_id: liveRow.member_id })
  assert.deepEqual(liveRow.predecessor, { target: 'reviewer', member_id: retiredRow.member_id })
  assert.equal(retiredRow.predecessor, undefined, 'the first holder of the name inherited from nobody')
  assert.equal(liveRow.successor, undefined, 'and a live successor has handed nothing on yet')
  assert.deepEqual(JSON.parse(JSON.stringify(linked)), linked, 'the linked read stays lossless JSON')

  // A row carrying a body, a write that amends it and one that clears it: the field is declared by
  // TASK_ROW, so every one of these answers is checked against the schema the tool declares (ADR 0020).
  await answer('task_board', { action: 'list' })
  const amended = await answer('task_board', {
    action: 'update',
    task_id: task.task.id,
    body: 'Done when the curve is rechecked. Stopped at the fixture rewrite.',
  })
  assert.equal(amended.task.owner, 'reviewer-g2', 'the handover owner survives an unrelated write')
  assert.equal(amended.task.body, 'Done when the curve is rechecked. Stopped at the fixture rewrite.')
  const cleared = await answer('task_board', { action: 'update', task_id: task.task.id, body: null })
  assert.equal(cleared.task.body, undefined)
  await answer('task_board', { action: 'update', task_id: task.task.id, status: 'done' })
  const template = await answer('handoff_template', {})
  assert.equal(template.source, 'builtin', 'no file and no stored template means the built-in shape')

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

  // A replacement from a definition: the assignment it answers with is the predecessor's recorded one,
  // and the field that says where it came from is inside the declared schema (v0.17.0, ADR 0019).
  await writeFile(
    join(cwd, 'team', 'auditor.md'),
    '---\nname: auditor\nlabel: Audit the release\nassignment: Keep the audit log green\n---\nAudit.\n',
  )
  await spawnDefined.execute(
    { name: 'auditor', label: 'Audit the release', prompt: 'Start.', assignment: 'Recheck the curve.' },
    { agent: defined.lead },
  )
  const replacedFromFile = await spawnDefined.execute({ replace: 'auditor', definition: 'auditor' }, { agent: defined.lead })
  assertMatchesSchema(replacedFromFile, spawnDefined.output.schema, 'spawn_member')
  assert.equal(replacedFromFile.target, 'auditor-g2')
  assert.equal(replacedFromFile.assignment, 'Recheck the curve.')
  assert.equal(replacedFromFile.definition.assignment, 'predecessor')

  // The team file is a third source for the brief's shape, and its read answer declares `source` plus
  // the file it found (v0.19.0, ADR 0021). A store write while it exists is refused by the wrapper too.
  await writeFile(join(cwd, 'team', 'team.md'), '---\n---\nFrom the file: {predecessor} -> {successor}. {assignment}\n')
  const brief = await defined.tools.get('handoff_template').execute({}, { agent: defined.lead })
  assertMatchesSchema(brief, defined.tools.get('handoff_template').output.schema, 'handoff_template')
  assert.equal(brief.source, 'file')
  assert.ok(brief.file.endsWith(join('team', 'team.md')))
  await assert.rejects(
    () => defined.tools.get('handoff_template').execute({ template: 'Stored: {assignment}' }, { agent: defined.lead }),
    /handoff_template: the team file .*team\.md.*Edit that file/,
  )

  // A profile without the service: the working-directory refusal is the other branch of the same answer.
  const unserviceable = harness()
  const noService = await unserviceable.tools.get('spawn_member')
    .execute({ definition: 'reviewer' }, { agent: unserviceable.lead })
  assertMatchesSchema(noService, unserviceable.tools.get('spawn_member').output.schema, 'spawn_member')
  assert.equal(noService.reason, 'working-directory-unavailable')
})

/**
 * `lifetime` is **required** on a member row, so every row a real read can produce must carry it. Two
 * paths are the ones that could quietly not: a member adopted from the shipped roster, which this plugin
 * never spawned, and a stored record written before v0.25.0, which has no lifetime field at all. A required
 * field that one path omits is a result the host refuses *after* the side effect, which is the failure class
 * v0.13.0 already paid for.
 */
test('every row a read can produce carries a lifetime, adopted and legacy records included', async () => {
  const shipped = [{ role: 'teammate', id: 'child-legacy', name: 'Legacy One', description: 'Shipped before v0.25', status: 'active' }]
  const { tools, table, lead } = harness({ listMembers: () => shipped })
  const list = tools.get('list_members')

  // A record as an older release wrote it: no `ephemeral`, no counters, no `lifetime` — and no way to gain
  // one, because only a spawn writes the declaration.
  await table.put('lead-1', {
    leadSessionId: 'lead-1',
    members: [{
      memberId: 'm-legacy',
      childId: 'child-legacy-stored',
      name: 'older',
      generation: 1,
      phase: 'active',
      label: 'Written before v0.25.0',
      createdAt: '2026-11-01T00:00:00.000Z',
    }],
  })

  const listed = await list.execute({}, { agent: lead })
  assertMatchesSchema(listed, list.output.schema, 'list_members')

  const adopted = listed.members.find((row) => row.target === 'legacy-one')
  const stored = listed.members.find((row) => row.target === 'older')
  assert.ok(adopted, 'the shipped member is adopted on the first read')
  assert.ok(stored, 'the legacy record is served')
  assert.equal(adopted.lifetime, 'standing', 'a member this plugin never spawned reads as standing')
  assert.equal(Object.hasOwn(adopted, 'ephemeral'), false, 'and carries no one-shot flag to report')
  assert.equal(stored.lifetime, 'standing', 'a record with no lifetime field reads as standing')
  assert.equal(Object.hasOwn(stored, 'ephemeral'), false)
})

/**
 * The router path through the wrapper, which `actions.js` tests cannot reach: a Lead whose Session
 * exposes a current route gets a member started on that route, a result that says where the route came
 * from, and a read that flags the one member still on another API. Every answer goes through the
 * declared schema, which is what makes the new fields declared rather than merely present (ADR 0024).
 */
test('the wrapper forwards a resolvable route and the read flags the member left behind', async () => {
  const routed = harness({ route: { provider: 'do', model: 'DeepSeek-V4.1-Flash' } })
  const spawnTool = routed.tools.get('spawn_member')
  const onRelay = await spawnTool.execute({ name: 'relay', label: 'On the relay', prompt: 'Start.' }, { agent: routed.lead })
  assertMatchesSchema(onRelay, spawnTool.output.schema, 'spawn_member')
  assert.deepEqual(onRelay.route, { source: 'plugin', provider: 'do', model: 'DeepSeek-V4.1-Flash' })
  assert.equal(onRelay.started_with.route_source, 'plugin')
  assert.deepEqual(routed.requests[0].agentOptions, { provider: 'do', model: 'DeepSeek-V4.1-Flash' })

  const onOfficial = await spawnTool.execute({
    name: 'official',
    label: 'Still on the official API',
    prompt: 'Start.',
    spawn_options: { agent_options: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  }, { agent: routed.lead })
  assertMatchesSchema(onOfficial, spawnTool.output.schema, 'spawn_member')
  assert.equal(onOfficial.started_with.route_source, 'caller')
  assert.deepEqual(onOfficial.route, { source: 'caller', provider: 'deepseek-official', model: 'deepseek-flash' })

  const roster = await routed.tools.get('list_members').execute({}, { agent: routed.lead })
  assertMatchesSchema(roster, routed.tools.get('list_members').output.schema, 'list_members')
  const flagged = roster.members.filter((row) => row.route_stale === true)
  assert.deepEqual(flagged.map((row) => row.target), ['official'], 'the straggler is the member another API bills')
  assert.match(flagged[0].route_note, /spawn_member \{ replace: "official"/)
  assert.deepEqual(JSON.parse(JSON.stringify(roster)), roster, 'the read stays lossless JSON')

  // A profile whose Session exposes no readable route still starts members, and the answer says the
  // plugin inherited rather than resolved: the fallback is visible, not silent.
  const blind = harness()
  const inherited = await blind.tools.get('spawn_member')
    .execute({ name: 'inherited', label: 'No readable route', prompt: 'Start.' }, { agent: blind.lead })
  assertMatchesSchema(inherited, blind.tools.get('spawn_member').output.schema, 'spawn_member')
  assert.deepEqual(inherited.started_with, { route_source: 'inherited' })
  assert.deepEqual(inherited.route, { source: 'inherited', select_reason: 'no-session-route' })
  assert.deepEqual(blind.requests[0], { prompt: [{ type: 'text', text: 'Start.' }], parent: blind.lead })
})

/**
 * The consent gate on the tool the model actually calls.
 *
 * This is the wrapper layer the `actions.js` suites cannot reach: they pass `consentRequired` themselves,
 * so only a call made here proves the `retire_member` tool sets it. Without this, the gate would exist in
 * the operation and never fire in a real Session — which is exactly the class of defect ADR 0026 is about.
 */
test('the retire_member tool asks the person before ending a standing role', async () => {
  const { tools, table, lead } = harness()
  const exec = { agent: lead }
  const spawn = tools.get('spawn_member')
  const retire = tools.get('retire_member')
  assert.ok(retire, 'the retirement tool is registered')

  const born = await spawn.execute({ name: 'keeper', label: 'Hold the line', prompt: 'Stay.', assignment: 'Keep the release green' }, exec)
  assertMatchesSchema(born, spawn.output.schema, 'spawn_member')
  assert.equal(born.lifetime, 'standing', 'the default is the lifetime that is never retired automatically')
  const owned = await tools.get('task_board').execute({ action: 'create', title: 'Watch the release', owner: 'keeper' }, exec)

  const refused = await retire.execute({ target: 'keeper' }, exec)
  assertMatchesSchema(refused, retire.output.schema, 'retire_member')
  assert.equal(refused.retired, false)
  assert.equal(refused.reason, 'needs-confirmation')
  assert.equal(refused.lifetime, 'standing')
  assert.match(refused.question, /Retire the standing member "keeper"/)
  assert.deepEqual(refused.owns_tasks, [owned.task.id])
  assert.equal(table.get('lead-1').members.find((member) => member.name === 'keeper').phase, 'active', 'nothing was retired')

  // A boolean is not the person's words, and the wrapper refuses it before the operation runs.
  await assert.rejects(
    () => retire.execute({ target: 'keeper', confirmed: true }, exec),
    /confirmed must be a string carrying the person's words/,
  )

  const done = await retire.execute({ target: 'keeper', confirmed: 'Yes — the release is signed off, retire it.' }, exec)
  assertMatchesSchema(done, retire.output.schema, 'retire_member')
  assert.equal(done.retired, true)
  assert.match(done.message, /quoted back here: "Yes — the release is signed off, retire it\."/)
  assert.deepEqual(done.unowned_tasks, [owned.task.id], 'the work it owned is named, not silently orphaned')
  assert.equal(table.get('lead-1').members.find((member) => member.name === 'keeper').phase, 'retired')
})
