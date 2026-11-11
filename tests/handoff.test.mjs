import assert from 'node:assert/strict'
import { test } from 'node:test'

import { handoffPrompt, messageMember, retireMember, spawnMember } from '../actions.js'
import { ASSIGNMENT_MAX, PHASE, ROSTER_SPEC, checkAssignment, readRoster } from '../roster.js'

/** A roster table with the two methods the lifecycle uses. */
function memoryTable({ failRetirement = false } = {}) {
  const rows = new Map()
  return {
    get: (key) => rows.get(key),
    put: async (key, value) => {
      if (failRetirement && value.members.some((member) => member.phase === PHASE.retired)) {
        throw new Error('the storage domain refused the tombstone')
      }
      rows.set(key, value)
    },
  }
}

/**
 * A context fake carrying what spawn, retire and message read. `failStartFrom` makes the n-th child
 * start fail, so a failed start can be exercised without failing the first spawn.
 */
function fakeCtx({ failStartFrom = Number.POSITIVE_INFINITY } = {}) {
  const started = []
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
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
    },
    agents: { get: () => undefined },
    get: () => undefined,
    started,
  }
}

const lead = { session: { id: 'lead-1' } }

/** The host-side effects a retirement refreshes. */
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

/** The arguments every roster operation takes. */
const call = (ctx, table, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: '/tmp/team-roster-test',
  hooks: hooks(),
  ...extra,
})

const firstReviewer = (ctx, table) => spawnMember(call(ctx, table, {
  name: 'reviewer',
  label: 'Check the diff',
  prompt: 'Start on the parser.',
  assignment: 'Finish the parser unit tests.',
}))

const memberNamed = (table, name, generation) => readRoster(table, 'lead-1').members
  .find((member) => member.name === name && member.generation === generation)

test('an assignment is stored on the record and capped', () => {
  assert.equal(checkAssignment('  keep the parser green  '), 'keep the parser green')
  assert.throws(() => checkAssignment(42), /must be a string/)
  assert.throws(() => checkAssignment('   '), /must not be empty/)
  assert.throws(
    () => checkAssignment('x'.repeat(ASSIGNMENT_MAX + 1), 'test'),
    new RegExp(`cap is ${ASSIGNMENT_MAX}`),
  )

  // The durable record refuses an assignment past the cap, so an old store cannot grow without limit.
  const record = {
    leadSessionId: 'lead-1',
    members: [{
      memberId: 'member-1',
      childId: 'child-1',
      name: 'reviewer',
      generation: 1,
      phase: PHASE.active,
      label: 'Check the diff',
      assignment: 'y'.repeat(ASSIGNMENT_MAX),
    }],
  }
  const parse = ROSTER_SPEC.tables.rosters.valueSchema.parse
  assert.equal(parse(record), record)
  record.members[0].assignment = 'y'.repeat(ASSIGNMENT_MAX + 1)
  assert.throws(() => parse(record), /exceeds/)
})

test('spawn_member stores the assignment and message_member replaces it', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'reviewer',
    label: 'Check the diff',
    prompt: 'Start on the parser.',
    assignment: 'Finish the parser unit tests.',
  }))
  assert.equal(born.assignment, 'Finish the parser unit tests.')
  assert.equal(memberNamed(table, 'reviewer', 1).assignment, 'Finish the parser unit tests.')

  const messaged = await messageMember(call(ctx, table, {
    target: 'reviewer',
    message: 'The parser is done; review the cache change next.',
    assignment: 'Review the cache change.',
  }))
  assert.equal(messaged.sent, true)
  assert.equal(messaged.assignment, 'Review the cache change.')
  assert.equal(memberNamed(table, 'reviewer', 1).assignment, 'Review the cache change.')

  await assert.rejects(
    () => messageMember(call(ctx, table, {
      target: 'reviewer',
      message: 'x',
      assignment: 'z'.repeat(ASSIGNMENT_MAX + 1),
    })),
    /cap is 1000/,
  )
  assert.equal(memberNamed(table, 'reviewer', 1).assignment, 'Review the cache change.', 'a refused update changes nothing')
})

test('the handoff prompt carries what the predecessor was doing and that it is gone', () => {
  const prompt = handoffPrompt({
    successor: 'reviewer-g2',
    predecessor: {
      name: 'reviewer',
      generation: 1,
      label: 'Check the diff',
      assignment: 'Finish the parser unit tests.',
    },
    prompt: 'Continue with the cache change.',
  })
  assert.match(prompt, /You are reviewer-g2, the successor of reviewer/)
  assert.match(prompt, /has been retired and is gone/)
  assert.match(prompt, /Check the diff/)
  assert.match(prompt, /Finish the parser unit tests\./)
  assert.match(prompt, /shared team task board under the name "reviewer"/)
  assert.match(prompt, /Continue with the cache change\./)
  assert.ok(prompt.length < 800, 'the brief stays short enough for a cold child')
  assert.equal(prompt.split('\n').length, 5, 'five lines, not a wall of prose')
})

test('a predecessor without an assignment still yields a usable brief', () => {
  const prompt = handoffPrompt({
    successor: 'probe-g2',
    predecessor: { name: 'probe', generation: 1, label: 'Audit the theme tokens' },
    prompt: 'Take over.',
  })
  assert.match(prompt, /Its role was: Audit the theme tokens\./)
  assert.match(prompt, /not recorded; take it from the shared team task board/)
})

test('one spawn_member call retires the predecessor and starts its successor', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)

  const replaced = await spawnMember(call(ctx, table, {
    replace: 'reviewer',
    label: 'Check the diff',
    prompt: 'Continue the parser work.',
  }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.generation, 2)
  assert.equal(replaced.phase, PHASE.active)
  assert.equal(replaced.replaced, 'reviewer')
  assert.equal(replaced.predecessor_retired, true)
  assert.match(replaced.message, /handoff brief/)
  assert.deepEqual(JSON.parse(JSON.stringify(replaced)), replaced, 'the result stays lossless JSON')

  const predecessor = memberNamed(table, 'reviewer', 1)
  const successor = memberNamed(table, 'reviewer', 2)
  assert.equal(predecessor.phase, PHASE.retired, 'the predecessor is retired in the same call')
  assert.equal(predecessor.assignment, 'Finish the parser unit tests.', 'the tombstone keeps the assignment')
  assert.equal(successor.phase, PHASE.active)
  assert.equal(successor.predecessor, predecessor.memberId, 'the successor records what it replaced')
  assert.equal(successor.assignment, 'Finish the parser unit tests.', 'the work is inherited unless re-recorded')

  // The child was started from the brief, not from the predecessor's transcript.
  const text = ctx.started.at(-1).request.prompt[0].text
  assert.match(text, /You are reviewer-g2, the successor of reviewer/)
  assert.match(text, /Finish the parser unit tests\./)
  assert.match(text, /Continue the parser work\./)
})

test('a replacement keeps the name generation unless the model names it', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue.' }))
  const third = await spawnMember(call(ctx, table, { replace: 'reviewer-g2', label: 'Check the diff', prompt: 'Continue again.' }))
  assert.equal(third.target, 'reviewer-g3')

  const named = await spawnMember(call(ctx, table, {
    replace: 'reviewer-g3',
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start the probe.',
  }))
  assert.equal(named.target, 'probe')
  assert.equal(named.generation, 1, 'an explicitly named successor starts its own generation')
  assert.equal(memberNamed(table, 'reviewer', 3).phase, PHASE.retired)
})

test('a retirement that fails after the successor started is reported as that half', async () => {
  const table = memoryTable({ failRetirement: true })
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)

  const replaced = await spawnMember(call(ctx, table, {
    replace: 'reviewer',
    label: 'Check the diff',
    prompt: 'Continue.',
  }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.phase, PHASE.active)
  assert.equal(replaced.predecessor_retired, false, 'the half that did not happen is reported')
  assert.match(replaced.message, /could NOT be retired/)
  assert.match(replaced.message, /still live/)
  assert.equal(memberNamed(table, 'reviewer', 1).phase, PHASE.active, 'the predecessor was left live')
  assert.equal(memberNamed(table, 'reviewer', 2).phase, PHASE.active)
})

test('a successor that cannot start leaves the predecessor untouched and says so', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({ failStartFrom: 2 })
  await firstReviewer(ctx, table)

  await assert.rejects(
    () => spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue.' })),
    /was NOT retired and is still live/,
  )
  assert.equal(memberNamed(table, 'reviewer', 1).phase, PHASE.active, 'the predecessor is untouched')
  assert.equal(memberNamed(table, 'reviewer', 2).phase, PHASE.failed, 'the failed reservation is visible')
})

test('a retired predecessor can still be replaced from its tombstone', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  const retirement = await retireMember(call(ctx, table, { target: 'reviewer', reason: 'Moving on' }))
  assert.equal(retirement.retired, true)

  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.predecessor_retired, true)
  assert.match(replaced.message, /already retired/)
  assert.equal(memberNamed(table, 'reviewer', 2).assignment, 'Finish the parser unit tests.')
  assert.match(ctx.started.at(-1).request.prompt[0].text, /Finish the parser unit tests\./)
})
