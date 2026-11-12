import assert from 'node:assert/strict'
import { test } from 'node:test'

import { spawnMember, taskBoard } from '../actions.js'
import {
  PHASE,
  ROSTER_SPEC,
  TASK_BODY_MAX,
  TASK_STATUS,
  checkTaskBody,
  readRoster,
  reownerTasks,
  tasksOf,
  updateRoster,
} from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * The same fakes the handoff suite uses, for the one test that runs a real replacement.
 * `live` decides which children the live registry reports.
 */
function fakeCtx() {
  const started = []
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (request) => {
        started.push(request)
        return { childId: request.childId }
      },
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
    },
    agents: { get: () => undefined },
    get: () => undefined,
    started,
  }
}

const lead = { session: { id: 'lead-1' } }
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

/**
 * A board with one open task owned by the predecessor, seeded without a member record.
 *
 * The three race tests below never resolve an owner, so the member row is not what they are about;
 * what they are about is the write, and the table's serialized `update` is where that is decided.
 */
async function seeded(extra = {}) {
  const table = memoryTable()
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [{
      memberId: 'member-1',
      name: 'reviewer',
      generation: 1,
      phase: PHASE.active,
      childId: 'child-1',
      label: 'Check the diff',
      createdAt: '2026-11-12T00:00:00.000Z',
    }],
    tasks: [{
      id: 'task-1',
      title: 'Finish the parser tests',
      status: TASK_STATUS.open,
      owner: 'reviewer',
      created_at: '2026-11-12T00:00:00.000Z',
      ...extra,
    }],
  }))
  return table
}

const board = (table, extra = {}) => taskBoard({ table, leadSessionId: 'lead-1', ...extra })
const taskById = (table, id) => tasksOf(readRoster(table, 'lead-1')).find((task) => task.id === id)
const taskNow = (table) => taskById(table, 'task-1')

/**
 * Let a competing write land between this call's read and its write.
 *
 * `taskBoard` reads the roster synchronously and writes through the table's serialized `update`, so
 * wrapping that one method is exactly the interleaving a real replacement produces when it reaches the
 * front of the write chain first. The handover is the same `reownerTasks` mutation a replacement runs.
 */
function interleaved(table, handover) {
  let injected = false
  const original = table.update
  table.update = async (key, mutate) => {
    if (!injected) {
      injected = true
      await original(key, handover)
    }
    return await original(key, mutate)
  }
  table.__injected = () => injected
  return table
}

const successorTakesIt = (current) => reownerTasks(current, 'reviewer', 'reviewer-g2').roster

test('an update computed before a handover keeps the successor\'s owner', async () => {
  const table = interleaved(await seeded(), successorTakesIt)
  const result = await board(table, { action: 'update', task_id: 'task-1', status: 'done' })

  assert.equal(result.changed, true, 'the status change the call asked for still happens')
  assert.equal(result.task.owner, 'reviewer-g2', 'the row the call read is not written back')
  assert.equal(taskNow(table).owner, 'reviewer-g2', 'the successor keeps the work the handover gave it')
  assert.equal(taskNow(table).status, TASK_STATUS.done)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the result stays lossless JSON')
})

test('a release computed before a handover does not un-own the successor\'s work', async () => {
  const table = interleaved(await seeded(), successorTakesIt)
  const result = await board(table, { action: 'release', task_id: 'task-1' })

  assert.equal(result.changed, false, 'a release whose owner moved on is a no-op, not a write')
  assert.equal(result.task.owner, 'reviewer-g2', 'the answer reports the row as it is now')
  assert.match(result.message, /reviewer-g2/, 'the answer names the owner that took it')
  assert.equal(taskNow(table).owner, 'reviewer-g2', 'the successor owns the task after the release')
  assert.equal(taskNow(table).status, TASK_STATUS.open, 'and it is still owed')
})

test('a delete computed before a handover does not remove the successor\'s work', async () => {
  const table = interleaved(await seeded(), successorTakesIt)
  const result = await board(table, { action: 'delete', task_id: 'task-1' })

  assert.equal(result.changed, false, 'a delete whose row moved on is a no-op, not a write')
  assert.equal(result.deleted, undefined, 'nothing was deleted')
  assert.equal(result.task.owner, 'reviewer-g2', 'the answer reports the row that was kept')
  assert.match(result.message, /reviewer-g2/)
  assert.ok(taskNow(table), 'the row survives')
  assert.equal(taskNow(table).owner, 'reviewer-g2', 'and still belongs to the successor')
})

test('an update that names an owner is the caller\'s decision, even against a fresh handover', async () => {
  const table = interleaved(await seeded(), successorTakesIt)
  const result = await board(table, { action: 'update', task_id: 'task-1', owner: 'reviewer' })

  assert.equal(result.changed, true)
  assert.equal(taskNow(table).owner, 'reviewer', 'a named owner is written, not merged away')
})

test('a board with no interleaving still deletes, releases and updates as it did', async () => {
  const table = await seeded()
  const released = await board(table, { action: 'release', task_id: 'task-1' })
  assert.equal(released.changed, true)
  assert.equal(taskNow(table).owner, undefined)

  const updated = await board(table, { action: 'update', task_id: 'task-1', owner: 'reviewer' })
  assert.equal(updated.task.owner, 'reviewer')

  const removed = await board(table, { action: 'delete', task_id: 'task-1' })
  assert.equal(removed.deleted, 'task-1')
  assert.equal(removed.changed, true)
  assert.equal(taskNow(table), undefined)
})

test('a task carries a bounded body, and update amends and clears it', async () => {
  assert.equal(checkTaskBody('  Done when the parser suite is green.  '), 'Done when the parser suite is green.')
  assert.throws(() => checkTaskBody(42), /body must be a string/)
  assert.throws(() => checkTaskBody('   '), /body must not be empty/)

  const table = memoryTable()
  const body = 'Done when: the parser suite is green. Stopped at: the cache fixture needs a rewrite.'
  const created = await board(table, { action: 'create', title: 'Finish the parser tests', body: `  ${body}  ` })
  assert.equal(created.task.body, body, 'the body is trimmed, like a title')
  assert.deepEqual(JSON.parse(JSON.stringify(created)), created, 'the result stays lossless JSON')

  const listed = await board(table, { action: 'list' })
  assert.equal(listed.tasks[0].body, body, 'list returns the body: it is what a successor reads')
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed)

  const amended = await board(table, { action: 'update', task_id: created.task.id, body: 'Done when: the parser suite is green.' })
  assert.equal(amended.changed, true)
  assert.equal(amended.task.body, 'Done when: the parser suite is green.')
  assert.equal(typeof amended.task.updated_at, 'string', 'a second write stamps updated_at')

  const repeat = await board(table, { action: 'update', task_id: created.task.id, body: amended.task.body })
  assert.equal(repeat.changed, false, 're-sending the same body is a no-op')
  assert.match(repeat.message, /already has that status, owner and body/)

  const cleared = await board(table, { action: 'update', task_id: created.task.id, body: null })
  assert.equal(cleared.changed, true)
  assert.equal(cleared.task.body, undefined, 'null clears the field rather than storing empty text')
  assert.equal(taskById(table, created.task.id).body, undefined)
  assert.equal((await board(table, { action: 'list' })).tasks[0].body, undefined)
})

test('a task body is refused past its cap rather than truncated', async () => {
  const table = memoryTable()
  await assert.rejects(
    () => board(table, { action: 'create', title: 'Finish the parser tests', body: 'y'.repeat(TASK_BODY_MAX + 1) }),
    new RegExp(`cap is ${TASK_BODY_MAX}`),
  )
  assert.equal(tasksOf(readRoster(table, 'lead-1')).length, 0, 'a refused body stores nothing')
  await assert.rejects(
    () => board(table, { action: 'create', title: 'Finish the parser tests', body: null }),
    /body must be a string or omitted/,
  )

  const bounded = await board(table, { action: 'create', title: 'Finish the parser tests', body: 'y'.repeat(TASK_BODY_MAX) })
  assert.equal(bounded.task.body.length, TASK_BODY_MAX, 'the boundary itself is accepted')

  await assert.rejects(
    () => board(table, { action: 'update', task_id: bounded.task.id, body: 'z'.repeat(TASK_BODY_MAX + 1) }),
    new RegExp(`cap is ${TASK_BODY_MAX}`),
  )
  const stored = taskById(table, bounded.task.id).body
  assert.equal(stored.length, TASK_BODY_MAX, 'the stored body is not trimmed to fit')
  assert.equal(stored, 'y'.repeat(TASK_BODY_MAX), 'and it is the text the model wrote, character for character')
})

test('a stored body that no longer passes the read rules is reported and still served', async () => {
  const table = memoryTable()
  const created = await board(table, { action: 'create', title: 'Finish the parser tests', body: 'Done when green.' })

  // Hand-edited past the cap, the way the title and `handoffTemplate` set the precedent.
  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    tasks: current.tasks.map((task) => ({ ...task, body: 'q'.repeat(TASK_BODY_MAX + 5) })),
  }))
  const record = readRoster(table, 'lead-1')
  assert.equal(
    ROSTER_SPEC.tables.rosters.valueSchema.parse(record),
    record,
    'the cap is a read rule, not a load rule: one Lead\'s long body still loads',
  )

  const listed = await board(table, { action: 'list' })
  assert.equal(listed.tasks[0].body.length, TASK_BODY_MAX + 5, 'the stored text is served, not dropped')
  assert.match(listed.tasks[0].problem, new RegExp(`body is ${TASK_BODY_MAX + 5} characters; the cap is ${TASK_BODY_MAX}`))

  // An empty stored body is the same kind of stored value: the write path never produces one.
  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    tasks: current.tasks.map((task) => ({ ...task, body: '   ' })),
  }))
  assert.match((await board(table, { action: 'list' })).tasks[0].problem, /body is not a non-empty string/)
  assert.equal(taskById(table, created.task.id).body, '   ', 'and it is kept, not silently cleared')
})

test('a handover carries the body with the row, and the brief never quotes it', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, {
    name: 'reviewer',
    label: 'Check the diff',
    prompt: 'Start on the parser.',
    assignment: 'Finish the parser unit tests.',
  }))
  const body = 'b'.repeat(TASK_BODY_MAX)
  const task = (await board(table, {
    action: 'create',
    title: 'Finish the parser tests',
    owner: 'reviewer',
    body,
  })).task

  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(replaced.transferred, 1)
  assert.equal(taskById(table, task.id).body, body, 'the body travels with the row it belongs to')

  const text = ctx.started.at(-1).request.prompt[0].text
  assert.match(text, new RegExp(`${task.id} "Finish the parser tests"`), 'the brief names the id and the title')
  assert.ok(!text.includes('bbbbbbbbbb'), 'the brief carries no body text')
  assert.equal(text.split('\n').length, 6, 'a maximal body does not grow the brief past its line')
})

