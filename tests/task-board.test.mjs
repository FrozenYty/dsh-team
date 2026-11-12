import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  handoffPrompt,
  listMembers,
  restoreMember,
  retireMember,
  spawnMember,
  taskBoard,
} from '../actions.js'
import {
  PHASE,
  ROSTER_SPEC,
  TASK_LIMIT,
  TASK_STATUS,
  TASK_TITLE_MAX,
  checkTaskTitle,
  findAnyTarget,
  openTasksOf,
  planTask,
  readRoster,
  tasksOf,
  updateRoster,
} from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * The same fakes the handoff suite uses: what spawn, retire, restore and the sweep read.
 * `failStartFrom` makes the n-th start fail; `live` decides which children the live registry reports.
 */
function fakeCtx({ failStartFrom = Number.POSITIVE_INFINITY, live = () => false } = {}) {
  const started = []
  const drained = []
  let starts = 0
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (request) => {
        starts += 1
        if (starts >= failStartFrom) throw new Error('the capacity limit was reached')
        started.push(request)
        return { childId: request.childId }
      },
      drainChildren: async (caller, childIds) => { drained.push(...childIds) },
      sendMessage: async () => 'message-1',
      interrupt: () => {},
    },
    agents: { get: (id) => (live(id) ? { id, status: 'idle' } : undefined) },
    get: () => undefined,
    started,
    drained,
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
const board = (table, extra = {}) => taskBoard({ table, leadSessionId: 'lead-1', ...extra })
const tasksNow = (table) => tasksOf(readRoster(table, 'lead-1'))
const taskById = (table, id) => tasksNow(table).find((task) => task.id === id)

/** A member with an open task and a done task, owned by that member. */
async function memberWithWork(ctx, table, { name = 'reviewer', ephemeral = false } = {}) {
  await spawnMember(call(ctx, table, {
    name,
    label: 'Check the diff',
    prompt: 'Start on the parser.',
    assignment: 'Finish the parser unit tests.',
    ephemeral,
  }))
  const open = (await board(table, { action: 'create', title: 'Finish the parser tests', owner: name })).task
  const done = (await board(table, { action: 'create', title: 'Read the cache design', owner: name })).task
  await board(table, { action: 'update', task_id: done.id, status: 'done' })
  return { open, done }
}

test('a task is created with an id, owner and timestamps, and carries no priority or dependency', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start.' }))

  const created = await board(table, { action: 'create', title: '  Finish the parser tests  ', owner: 'reviewer' })
  assert.equal(created.task.title, 'Finish the parser tests', 'the title is trimmed')
  assert.equal(created.task.status, TASK_STATUS.open)
  assert.equal(created.task.owner, 'reviewer')
  assert.match(created.task.id, /^[0-9a-f-]{36}$/)
  assert.equal(typeof created.task.created_at, 'string')
  assert.equal(created.task.updated_at, undefined, 'one timestamp until the task is written again')
  assert.deepEqual(JSON.parse(JSON.stringify(created)), created, 'the result stays lossless JSON')
  assert.deepEqual(
    Object.keys(created.task).sort(),
    ['created_at', 'id', 'owner', 'status', 'title'],
    'the shape is exactly id, title, status, owner and a timestamp: nothing else exists',
  )

  const listed = await board(table, { action: 'list' })
  assert.equal(listed.tasks.length, 1)
  assert.equal(listed.open, 1)
  assert.deepEqual(listed.tasks[0], created.task)
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed)
})

test('every task gets its own id', async () => {
  const table = memoryTable()
  const first = await board(table, { action: 'create', title: 'Write the parser tests' })
  const second = await board(table, { action: 'create', title: 'Write the cache tests' })
  assert.notEqual(first.task.id, second.task.id)
  assert.notEqual(first.task.id, undefined)
  assert.equal(first.task.owner, undefined, 'a task without an owner is simply unowned')
  assert.deepEqual(new Set(tasksNow(table).map((task) => task.id)).size, 2)
})

test('a task title is refused past its cap rather than truncated', async () => {
  assert.equal(checkTaskTitle('  keep the parser green  '), 'keep the parser green')
  assert.throws(() => checkTaskTitle(42), /must be a string/)
  assert.throws(() => checkTaskTitle('   '), /must be a non-empty string/)
  assert.throws(
    () => checkTaskTitle('x'.repeat(TASK_TITLE_MAX + 1), 'test'),
    new RegExp(`cap is ${TASK_TITLE_MAX}`),
  )

  const table = memoryTable()
  await assert.rejects(
    () => board(table, { action: 'create', title: 'y'.repeat(TASK_TITLE_MAX + 1) }),
    new RegExp(`cap is ${TASK_TITLE_MAX}`),
  )
  assert.equal(tasksNow(table).length, 0, 'a refused title stores nothing')
  const bounded = await board(table, { action: 'create', title: 'y'.repeat(TASK_TITLE_MAX) })
  assert.equal(bounded.task.title.length, TASK_TITLE_MAX, 'the boundary itself is accepted')
})

test('the per-Lead task cap refuses the next create instead of dropping or truncating it', async () => {
  const roster = { leadSessionId: 'lead-1', members: [], tasks: [] }
  for (let index = 0; index < TASK_LIMIT; index += 1) {
    roster.tasks.push({ id: `task-${index}`, title: `Task ${index}`, status: TASK_STATUS.open, created_at: 'x' })
  }
  assert.equal(tasksOf(roster).length, TASK_LIMIT)
  assert.throws(() => planTask(roster, { title: 'one too many' }, 'test'), new RegExp(`cap is ${TASK_LIMIT}`))

  // The same through the tool, so the refusal is the model's answer and not an internal throw.
  const table = memoryTable()
  await updateRoster(table, 'lead-1', () => roster)
  await assert.rejects(
    () => board(table, { action: 'create', title: 'one too many' }),
    new RegExp(`cap is ${TASK_LIMIT}`),
  )
  assert.equal(tasksNow(table).length, TASK_LIMIT, 'nothing was dropped to make room')
  // Deleting one makes room again: the cap is on the stored list, not a lifetime count.
  const deleted = await board(table, { action: 'delete', task_id: 'task-0' })
  assert.equal(deleted.deleted, 'task-0')
  assert.equal((await board(table, { action: 'create', title: 'now it fits' })).task.title, 'now it fits')
})

test('a done task is finished work: it stops being inherited and can be set back', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start.' }))
  const task = (await board(table, { action: 'create', title: 'Finish the parser tests', owner: 'reviewer' })).task

  const closed = await board(table, { action: 'update', task_id: task.id, status: 'done' })
  assert.equal(closed.changed, true)
  assert.equal(closed.task.status, TASK_STATUS.done)
  assert.equal(typeof closed.task.updated_at, 'string', 'a second write stamps updated_at')
  assert.equal(closed.open, 0)
  assert.deepEqual(openTasksOf(readRoster(table, 'lead-1'), 'reviewer'), [], 'done work is not handed over')

  const reopened = await board(table, { action: 'update', task_id: task.id, status: 'open' })
  assert.equal(reopened.task.status, TASK_STATUS.open)
  assert.equal(reopened.open, 1)

  const repeat = await board(table, { action: 'update', task_id: task.id, status: 'open' })
  assert.equal(repeat.changed, false, 'a repeat write is visible as one')
  assert.match(repeat.message, /already has that status/)
})

test('an owner no member holds is refused, and release clears an owner without closing the task', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start.' }))
  const task = (await board(table, { action: 'create', title: 'Finish the parser tests', owner: 'reviewer' })).task

  await assert.rejects(
    () => board(table, { action: 'create', title: 'Ghost work', owner: 'ghost' }),
    /no member named "ghost"/,
  )
  await assert.rejects(
    () => board(table, { action: 'update', task_id: task.id, owner: 'ghost' }),
    /no member named "ghost"/,
  )

  const released = await board(table, { action: 'release', task_id: task.id })
  assert.equal(released.changed, true)
  assert.equal(released.task.owner, undefined)
  assert.equal(released.task.status, TASK_STATUS.open, 'release is not done')
  assert.equal(taskById(table, task.id).owner, undefined)

  const again = await board(table, { action: 'release', task_id: task.id })
  assert.equal(again.changed, false)

  // The same clear through update, and a re-assignment to another generation of the name.
  const assigned = await board(table, { action: 'update', task_id: task.id, owner: 'reviewer' })
  assert.equal(assigned.task.owner, 'reviewer')
  const cleared = await board(table, { action: 'update', task_id: task.id, owner: null })
  assert.equal(cleared.task.owner, undefined)
})

test('a task_board call refuses what it cannot act on instead of guessing', async () => {
  const table = memoryTable()
  await assert.rejects(() => board(table, { action: 'update' }), /task_id must be a non-empty string/)
  await assert.rejects(() => board(table, { action: 'delete', task_id: 'ghost' }), /no task with the id "ghost"/)
  await assert.rejects(() => board(table, { action: 'update', task_id: 'ghost' }), /no task with the id "ghost"/)
  await assert.rejects(() => board(table, { action: 'create' }), /title must be a string/)
  await assert.rejects(() => board(table, { action: 'create', title: 'x', status: 'later' }), /status must be "open" or "done"/)
  const created = await board(table, { action: 'create', title: 'x' })
  await assert.rejects(
    () => board(table, { action: 'update', task_id: created.task.id }),
    /nothing to change/,
  )
})

test('a stored task that no longer passes the read rules is reported, and never hides the roster', () => {
  const parse = ROSTER_SPEC.tables.rosters.valueSchema.parse
  const oversized = { id: 't1', title: 'z'.repeat(TASK_TITLE_MAX + 40), status: TASK_STATUS.open }
  const record = { leadSessionId: 'lead-1', members: [], tasks: [oversized] }
  // The storage facility validates every record when it opens the domain, so a content rule here would
  // let one Lead's long title hide every roster in the profile (ADR 0017). The record loads.
  assert.equal(parse(record), record)

  // Structure is refused, because a roster that cannot represent a task cannot answer for it.
  const bad = [
    [{ leadSessionId: 'lead-1', members: [], tasks: 'nope' }, /roster.tasks must be an array/],
    [{ leadSessionId: 'lead-1', members: [], tasks: [null] }, /roster task must be an object/],
    [{ leadSessionId: 'lead-1', members: [], tasks: [{}] }, /roster task needs an id/],
    [{ leadSessionId: 'lead-1', members: [], tasks: [{ id: 't1' }] }, /status "undefined" is unknown/],
    [{ leadSessionId: 'lead-1', members: [], tasks: [{ id: 't1', status: 'later' }] }, /status "later" is unknown/],
    [{ leadSessionId: 'lead-1', members: [], tasks: [{ id: 't1', status: 'open', owner: '' }] }, /owner must be a non-empty string/],
    [{ leadSessionId: 'lead-1', members: [], tasks: [{ id: 't1', status: 'open' }, { id: 't1', status: 'done' }] }, /appears twice/],
  ]
  for (const [value, message] of bad) assert.throws(() => parse(value), message)
})

test('the read form reports why a stored task cannot be rendered, rather than dropping it', async () => {
  const table = memoryTable()
  await board(table, { action: 'create', title: 'Finish the parser tests' })
  // Hand-edited past the cap, the way `handoffTemplate` set the precedent for.
  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    tasks: current.tasks.map((task) => ({ ...task, title: 'q'.repeat(TASK_TITLE_MAX + 5) })),
  }))
  const listed = await board(table, { action: 'list' })
  assert.equal(listed.tasks.length, 1, 'the task is still served')
  assert.match(listed.tasks[0].problem, new RegExp(`cap is ${TASK_TITLE_MAX}`))
  const roster = await updateRoster(table, 'lead-1', (current) => current)
  assert.equal(tasksOf(roster).length, 1, 'the stored value is kept, not silently cleared')
})

test('replace succeeds: the predecessor retires and its open tasks move to the successor', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const { open, done } = await memberWithWork(ctx, table)

  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.predecessor_retired, true)
  assert.equal(replaced.transferred, 1)
  assert.deepEqual(replaced.transferred_tasks, [open.id])
  assert.equal(replaced.unowned, undefined, 'a handover leaves nothing unowned')
  assert.deepEqual(JSON.parse(JSON.stringify(replaced)), replaced)

  assert.equal(taskById(table, open.id).owner, 'reviewer-g2', 'the open task is the successor\'s')
  assert.equal(taskById(table, done.id).owner, 'reviewer', 'finished work stays with the record that finished it')
  assert.equal(taskById(table, done.id).status, TASK_STATUS.done)
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer').phase, PHASE.retired)
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer-g2').phase, PHASE.active)

  // The brief the successor actually received names the work by id and title.
  const text = ctx.started.at(-1).request.prompt[0].text
  assert.match(text, new RegExp(`Open tasks it still owned: ${open.id} "Finish the parser tests"`))
  assert.ok(!text.includes(done.id), 'a done task is not in the inherited list')
})

test('replace on an already-retired predecessor still hands its work over', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const { open } = await memberWithWork(ctx, table)
  const retired = await retireMember(call(ctx, table, { target: 'reviewer', reason: 'Moving on' }))
  assert.equal(retired.unowned, 1, 'the retirement with no successor left the task unowned')
  assert.equal(taskById(table, open.id).owner, undefined)

  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.predecessor_retired, true)
  assert.equal(replaced.transferred, 1)
  assert.deepEqual(replaced.transferred_tasks, [open.id])
  assert.equal(taskById(table, open.id).owner, 'reviewer-g2')
})

test('a failed successor start moves no work and leaves its predecessor live', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({ failStartFrom: 2 })
  const { open } = await memberWithWork(ctx, table)

  await assert.rejects(
    () => spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' })),
    /was NOT retired and is still live/,
  )
  assert.equal(taskById(table, open.id).owner, 'reviewer', 'nothing moved')
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer').phase, PHASE.active)
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer-g2').phase, PHASE.failed)
})

test('a retirement that fails behind a started successor is reported, and the work is still handed over', async () => {
  const table = memoryTable({ failRetirement: true })
  const ctx = fakeCtx()
  const { open } = await memberWithWork(ctx, table)

  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(replaced.predecessor_retired, false, 'the half that did not happen is reported')
  assert.match(replaced.message, /could NOT be retired/)
  assert.equal(taskById(table, open.id).owner, 'reviewer-g2', 'the successor carries the work it was started for')
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer').phase, PHASE.active, 'the predecessor is still live')
})

test('a retirement whose tombstone write fails has already handed the work over, so it is not lost', async () => {
  const table = memoryTable({ failRetirement: true })
  const ctx = fakeCtx()
  const { open, done } = await memberWithWork(ctx, table)
  // The failure above: the tombstone write is refused, and the handover write before it already landed.
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(taskById(table, open.id).owner, 'reviewer-g2')
  assert.equal(taskById(table, done.id).owner, 'reviewer')
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer').phase, PHASE.active, 'the record was not retired')
  // A second replacement reports no new handover: the successor already owns everything it started with.
  const again = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(again.predecessor_retired, false)
  assert.equal(again.transferred, undefined)
  assert.match(again.message, /could NOT be retired/)
  assert.equal(taskById(table, open.id).owner, 'reviewer-g2', 'the work stays with the successor that took it')
})

test('retiring without a successor leaves open work unowned, names it, and keeps done work on the tombstone', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const { open, done } = await memberWithWork(ctx, table)

  const retired = await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(retired.retired, true)
  assert.equal(retired.unowned, 1)
  assert.deepEqual(retired.unowned_tasks, [open.id])
  assert.equal(retired.transferred, undefined)
  assert.match(retired.message, /now unowned/)
  assert.deepEqual(JSON.parse(JSON.stringify(retired)), retired)

  assert.equal(taskById(table, open.id).owner, undefined, 'the work is still owed and nobody carries it')
  assert.equal(taskById(table, open.id).status, TASK_STATUS.open)
  assert.equal(taskById(table, done.id).owner, 'reviewer', 'done work stays on the record that finished it')
  assert.equal(taskById(table, done.id).status, TASK_STATUS.done)

  // A retirement that owned nothing adds neither field, so the old result shape is untouched.
  await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe the cache', prompt: 'Start.' }))
  const empty = await retireMember(call(ctx, table, { target: 'probe' }))
  assert.equal(empty.retired, true)
  assert.equal(empty.unowned, undefined)
  assert.equal(empty.transferred, undefined)
})

test('a restore changes no owner and reports the work still waiting for one', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const { open, done } = await memberWithWork(ctx, table)
  await retireMember(call(ctx, table, { target: 'reviewer' }))

  const restored = await restoreMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(restored.restored, true)
  assert.equal(restored.unowned, 1, 'the restore says how much work nobody carries')
  assert.deepEqual(restored.unowned_tasks, [open.id])
  assert.equal(taskById(table, open.id).owner, undefined, 'the restore assigns nothing')
  assert.equal(taskById(table, done.id).owner, 'reviewer')

  // Restoring a member whose work a successor took over does not claw it back.
  await board(table, { action: 'update', task_id: open.id, owner: 'reviewer' })
  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(replaced.transferred, 1)
  await restoreMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(taskById(table, open.id).owner, 'reviewer-g2', 'the successor keeps what it was handed')
  assert.equal(taskById(table, done.id).owner, 'reviewer')
})

test('the ephemeral sweep reports the work its member left unowned', async () => {
  const table = memoryTable()
  let residentId
  const ctx = fakeCtx({ live: (id) => id === residentId })
  await memberWithWork(ctx, table, { name: 'probe', ephemeral: true })
  const open = tasksNow(table).find((task) => task.status === TASK_STATUS.open)
  const member = readRoster(table, 'lead-1').members.find((candidate) => candidate.name === 'probe')
  assert.equal(member.phase, PHASE.active)
  assert.equal(typeof member.startedAt, 'string', 'the sweep needs the plugin\'s own start evidence')
  // The member ran and then stopped: the live registry no longer holds its child.
  residentId = undefined

  const listed = await listMembers(call(ctx, table))
  assert.equal(listed.swept, 1)
  assert.deepEqual(listed.swept_targets, ['probe'])
  assert.equal(listed.unowned, 1)
  assert.deepEqual(listed.unowned_tasks, [open.id])
  assert.equal(listed.members.find((row) => row.target === 'probe').phase, PHASE.retired)
  assert.equal(taskById(table, open.id).owner, undefined)
})

test('work follows the target, so a reused base name starts a different generation of owner', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const { open } = await memberWithWork(ctx, table)
  await retireMember(call(ctx, table, { target: 'reviewer' }))

  // The base name is reused: generation 2 is a different member with a different target.
  const reborn = await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start again.' }))
  assert.equal(reborn.target, 'reviewer-g2')
  assert.equal(taskById(table, open.id).owner, undefined, 'the new generation inherits nothing by name alone')

  await board(table, { action: 'update', task_id: open.id, owner: 'reviewer-g2' })
  assert.equal(taskById(table, open.id).owner, 'reviewer-g2')
  // Generation 1 is retired and unreachable for delivery, but it is still a valid owner handle.
  const assigned = await board(table, { action: 'update', task_id: open.id, owner: 'reviewer' })
  assert.equal(assigned.task.owner, 'reviewer')
})

test('a no-task member composes the brief byte for byte as before, and the list appears only with tasks', async () => {
  const predecessor = {
    name: 'reviewer',
    generation: 1,
    label: 'Check the diff',
    assignment: 'Finish the parser unit tests.',
  }
  const before = [
    'You are reviewer-g2, the successor of reviewer. reviewer has been retired and is gone; it cannot be messaged.',
    'Its role was: Check the diff.',
    'What it was doing: Finish the parser unit tests.',
    'Its unfinished work is still on the shared team task board under the name "reviewer": take those tasks over instead of redoing finished work, and ask the Lead for their ids if you cannot read the board.',
    'Your task: Continue with the cache change.',
  ].join('\n')
  const compose = (tasks) => handoffPrompt({
    successor: 'reviewer-g2',
    predecessor,
    prompt: 'Continue with the cache change.',
    tasks,
  })

  assert.equal(compose(undefined), before, 'omitting the tasks is the pre-P2-09 brief')
  assert.equal(compose([]), before, 'a member that owns nothing produces the same bytes')

  const withTasks = compose([{ id: 'task-1', title: 'Finish the parser tests' }])
  assert.equal(withTasks, before.replace(
    '\nYour task:',
    '\nOpen tasks it still owned: task-1 "Finish the parser tests"\nYour task:',
  ))
  assert.equal(withTasks.split('\n').length, 6, 'one extra line, not a wall of prose')

  // Bounded: five are named, the rest is a count, and a list that would stop fitting is dropped.
  const many = Array.from({ length: 7 }, (_, index) => ({ id: `task-${index}`, title: `Work ${index}` }))
  const bounded = compose(many)
  assert.match(bounded, /task-0 "Work 0"/)
  assert.match(bounded, /task-4 "Work 4"/)
  assert.ok(!bounded.includes('task-5'), 'the sixth is past the bound')
  assert.match(bounded, /and 2 more on the shared team task board/)

  const huge = Array.from({ length: 5 }, (_, index) => ({ id: `task-${index}`, title: 't'.repeat(TASK_TITLE_MAX) }))
  assert.equal(compose(huge), before, 'a list that would not stay short degrades to the pointer sentence')
})

test('a replacement on a member with no tasks composes the same brief it always did', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, {
    name: 'reviewer',
    label: 'Check the diff',
    prompt: 'Start on the parser.',
    assignment: 'Finish the parser unit tests.',
  }))
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue the parser work.' }))
  assert.equal(ctx.started.at(-1).request.prompt[0].text, [
    'You are reviewer-g2, the successor of reviewer. reviewer has been retired and is gone; it cannot be messaged.',
    'Its role was: Check the diff.',
    'What it was doing: Finish the parser unit tests.',
    'Its unfinished work is still on the shared team task board under the name "reviewer": take those tasks over instead of redoing finished work, and ask the Lead for their ids if you cannot read the board.',
    'Your task: Continue the parser work.',
  ].join('\n'))
})

test('the handover and the brief move in one write, so a reader never sees work pointing at a tombstone', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const { open } = await memberWithWork(ctx, table)
  let observed
  // Read the roster at the exact moment `startActivation` is entered: the predecessor is still live and
  // still owns its work, so the successor's brief and the handover agree.
  const inner = ctx.subagents.startActivation
  ctx.subagents.startActivation = async (request) => {
    observed = {
      owner: taskById(table, open.id).owner,
      phase: findAnyTarget(readRoster(table, 'lead-1'), 'reviewer').phase,
    }
    return await inner(request)
  }
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.deepEqual(observed, { owner: 'reviewer', phase: PHASE.active }, 'the start happens before the retirement')

  // And after it, both halves agree: a tombstone whose work names a live successor.
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer').phase, PHASE.retired)
  assert.equal(taskById(table, open.id).owner, 'reviewer-g2')
})
