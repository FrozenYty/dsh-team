import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listMembers, messageMember, spawnMember } from '../actions.js'
import { PHASE, ROSTER_SPEC, planMember, readRoster, updateRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A context fake with a mutable live registry. A spawned child is resident until `ctx.finish(childId)`
 * says its turn ended and the Harness unloaded it — which is exactly the observation the lazy sweep is
 * allowed to act on. The registry is the local `ctx.agents.get`, not the subagent registry: the latter
 * reports `activity: 'inactive'` for a child that never started as well (ADR 0013).
 */
function fakeCtx() {
  const liveIds = new Set()
  const started = []
  const drained = []
  const sent = []
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (request) => {
        started.push(request)
        liveIds.add(request.childId)
        return { childId: request.childId }
      },
      drainChildren: async (caller, childIds) => { drained.push(...childIds) },
      sendMessage: async (caller, childId, messages) => {
        sent.push({ childId, text: messages[0]?.text })
        liveIds.add(childId)
        return 'message-1'
      },
      interrupt: () => {},
    },
    agents: { get: (id) => (liveIds.has(id) ? { id, status: 'running' } : undefined) },
    get: () => undefined,
    /** The child's turn ended and the Harness unloaded it: the only "stopped" evidence the sweep uses. */
    finish(childId) {
      liveIds.delete(childId)
    },
    started,
    drained,
    sent,
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
  dataDir: '/tmp/dsh-team-test',
  hooks: hooks(),
  ...extra,
})

/** Spawn one member, with the one-shot flag by default. */
const spawn = (ctx, table, { name = 'probe', ephemeral = true, ...extra } = {}) => spawnMember(call(ctx, table, {
  name,
  label: 'Probe the cache',
  prompt: 'Start on the probe.',
  ephemeral,
  ...extra,
}))

const memberNamed = (table, name, generation = 1) => readRoster(table, 'lead-1').members
  .find((member) => member.name === name && member.generation === generation)

test('an ephemeral member is stored and reported, and a read sweeps it once it stopped', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawn(ctx, table)
  assert.equal(born.ephemeral, true, 'the spawn row says the member will leave on its own')
  const record = memberNamed(table, 'probe')
  assert.equal(record.phase, PHASE.active)
  assert.equal(record.ephemeral, true)
  assert.equal(typeof record.startedAt, 'string', 'the start is the positive evidence a sweep requires')

  ctx.finish(born.child_id)
  const listed = await listMembers(call(ctx, table))
  assert.equal(listed.swept, 1)
  assert.deepEqual(listed.swept_targets, ['probe'], 'the result names what it retired')
  assert.equal(listed.members[0].phase, PHASE.retired, 'the same read already reports the sweep')
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed, 'the result stays lossless JSON')

  // It went through the normal retirement path: drained, tombstoned, with a reason saying why.
  const tombstone = memberNamed(table, 'probe')
  assert.equal(tombstone.phase, PHASE.retired)
  assert.equal(tombstone.retireReason, 'ephemeral member: its turn ended')
  assert.equal(typeof tombstone.retiredAt, 'string')
  assert.deepEqual(ctx.drained, [born.child_id], 'the sweep drained the child through the normal path')
})

test('a member that never ran is never swept', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()

  // A reservation that never published: the sweep has no `startedAt` to act on. The read-time
  // reconciliation moves it to `failed`, which is a different operation and is visible as such.
  const reserved = planMember({ leadSessionId: 'lead-1', members: [] }, 'probe', 'Probe', undefined, true)
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [reserved] }))
  const afterReservation = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(afterReservation, 'swept'), false)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.failed)
  assert.match(memberNamed(table, 'probe').note, /never published/)

  // An active ephemeral record with no start evidence is left alone too: the flag alone is not proof.
  const unstarted = { ...planMember({ leadSessionId: 'lead-1', members: [] }, 'watcher', 'Watch', undefined, true), phase: PHASE.active }
  await updateRoster(table, 'lead-1', (current) => ({ ...current, members: [...current.members, unstarted] }))
  const listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false)
  assert.equal(memberNamed(table, 'watcher').phase, PHASE.active)
})

test('a member that is still running is never swept', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawn(ctx, table)

  // No `ctx.finish`: the child is still resident, so it has not stopped.
  const listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.active, 'a running one-shot member is left for the next sweep')
  assert.deepEqual(ctx.drained, [])
})

test('messaging an ephemeral member clears the flag, and it is never swept after that', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawn(ctx, table)

  const messaged = await messageMember(call(ctx, table, { target: 'probe', message: 'One more round.' }))
  assert.equal(messaged.sent, true)
  assert.equal(messaged.ephemeral, false, 'the result says the one-shot flag was cleared')
  assert.equal(memberNamed(table, 'probe').ephemeral, undefined)

  ctx.finish(born.child_id)
  const listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false, 'a messaged member is not swept')
  assert.equal(memberNamed(table, 'probe').phase, PHASE.active)
  assert.deepEqual(ctx.drained, [])
})

test('a profile that sets no ephemeral member is untouched', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawn(ctx, table, { ephemeral: false })
  assert.equal(Object.hasOwn(born, 'ephemeral'), false, 'the row reports nothing it did not ask for')
  const record = memberNamed(table, 'probe')
  assert.equal(Object.hasOwn(record, 'startedAt'), false, 'a normal member record is what it was before v0.9')

  ctx.finish(born.child_id)
  const listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false)
  assert.equal(Object.hasOwn(listed, 'swept_targets'), false)
  assert.equal(listed.members[0].phase, PHASE.active, 'no member is retired by a read it did not ask for')
  assert.deepEqual(ctx.drained, [])
})

test('the sweep is idempotent, and spawn_member is the other trigger and reports it', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const first = await spawn(ctx, table, { name: 'probe' })
  const second = await spawn(ctx, table, { name: 'audit' })
  ctx.finish(first.child_id)
  ctx.finish(second.child_id)

  const listed = await listMembers(call(ctx, table))
  assert.equal(listed.swept, 2)
  assert.deepEqual(listed.swept_targets.sort(), ['audit', 'probe'])
  const retiredAt = memberNamed(table, 'probe').retiredAt

  // A second read finds nothing to do and leaves the tombstones exactly as they were.
  const again = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(again, 'swept'), false)
  assert.equal(memberNamed(table, 'probe').retiredAt, retiredAt)
  assert.equal(ctx.drained.length, 2, 'nothing was drained twice')

  // The fan-out call is a trigger too: it reports what it freed before starting the next member.
  const third = await spawn(ctx, table, { name: 'reviewer', ephemeral: true })
  const fourth = await spawn(ctx, table, { name: 'scribe' })
  ctx.finish(third.child_id)
  const started = await spawn(ctx, table, { name: 'watcher' })
  assert.equal(started.swept, 1)
  assert.deepEqual(started.swept_targets, ['reviewer'])
  assert.equal(memberNamed(table, 'reviewer').phase, PHASE.retired)
  assert.equal(fourth.target, 'scribe')
})

test('the two new record fields are validated when a record is loaded', () => {
  const parse = ROSTER_SPEC.tables.rosters.valueSchema.parse
  const record = { leadSessionId: 'lead-1', members: [] }
  assert.equal(parse(record), record, 'a record written before v0.9 loads unchanged')
  for (const [field, value, message] of [
    ['ephemeral', 'yes', /ephemeral must be a boolean/],
    ['startedAt', '', /startedAt must be a non-empty string/],
  ]) {
    const broken = {
      leadSessionId: 'lead-1',
      members: [{ memberId: 'm-1', childId: 'c-1', name: 'probe', generation: 1, phase: PHASE.active, label: 'x', [field]: value }],
    }
    assert.throws(() => parse(broken), message)
  }
})
