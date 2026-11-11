import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureAdopted, listMembers, memberRow, retireMember } from '../actions.js'
import { PHASE, findAnyTarget, planMember, readRoster, updateRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/** A subagent-registry row, as `ctx.subagents.listDescendants` answers for one child. */
function descendant(id, overrides = {}) {
  return {
    kind: 'child',
    id,
    mode: 'one-shot',
    parentId: 'lead-1',
    depth: 1,
    activity: 'inactive',
    hasChildren: false,
    ...overrides,
  }
}

/** A context fake carrying only what adoption reads. */
function fakeCtx({ shipped = [], descendants = [] } = {}) {
  return {
    agentTeams: { listMembers: () => shipped },
    subagents: { listDescendants: async () => descendants, drainChildren: async () => {} },
    agents: { get: () => undefined },
    get: () => undefined,
  }
}

const caller = { session: { id: 'lead-1' } }

/** The host-side effects a retirement refreshes. */
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

test('an unknown descendant is adopted once and only once', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({ descendants: [descendant('child-1')] })

  const first = await ensureAdopted(ctx, caller, table, 'lead-1')
  assert.equal(first.members.length, 1)
  assert.equal(first.members[0].childId, 'child-1')
  assert.equal(first.members[0].phase, PHASE.active)
  assert.equal(first.members[0].name, 'subagent-child-1')

  const second = await ensureAdopted(ctx, caller, table, 'lead-1')
  assert.equal(second.members.length, 1, 'a second read does not adopt the same child again')
  assert.equal(second.members[0].generation, 1)
  assert.equal(readRoster(table, 'lead-1').members.length, 1)
})

test('a shipped-roster member is still adopted', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({
    shipped: [{ role: 'teammate', id: 'child-9', name: 'Reviewer One', description: 'Shipped', status: 'active' }],
  })

  const roster = await ensureAdopted(ctx, caller, table, 'lead-1')
  assert.equal(roster.members.length, 1)
  assert.equal(roster.members[0].memberId, 'child-9')
  assert.equal(roster.members[0].childId, 'child-9')
  assert.equal(roster.members[0].name, 'reviewer-one')
})

test('a child reported by both the shipped roster and the registry is adopted once', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({
    shipped: [{ role: 'teammate', id: 'child-1', name: 'Reviewer', description: 'Shipped', status: 'active' }],
    descendants: [descendant('child-1')],
  })

  const roster = await ensureAdopted(ctx, caller, table, 'lead-1')
  assert.equal(roster.members.length, 1)
  assert.equal(roster.members[0].name, 'reviewer', 'the shipped name wins')
  assert.equal(roster.members[0].generation, 1, 'the same child does not consume a second generation')
})

test('a diagnostic row is ignored and a tombstone blocks re-adoption', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({
    descendants: [
      { kind: 'diagnostic', id: 'child-x', parentId: 'lead-1', depth: 2, reason: 'unavailable' },
      descendant('child-1'),
    ],
  })

  const first = await ensureAdopted(ctx, caller, table, 'lead-1')
  assert.equal(first.members.length, 1)

  await table.put('lead-1', {
    ...readRoster(table, 'lead-1'),
    members: readRoster(table, 'lead-1').members.map((member) => ({ ...member, phase: PHASE.retired })),
  })
  const second = await ensureAdopted(ctx, caller, table, 'lead-1')
  assert.equal(second.members.length, 1, 'a retired child is not adopted a second time')
  assert.equal(second.members[0].phase, PHASE.retired)
})

test('every listed row carries the child id and stays lossless JSON', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({ descendants: [descendant('child-1'), descendant('child-2', { mode: 'continuable', label: 'Probe' })] })

  const result = await listMembers({ ctx, table, leadSessionId: 'lead-1', leadAgent: caller })
  assert.equal(result.members.length, 2)
  for (const row of result.members) {
    assert.equal(typeof row.child_id, 'string')
    assert.ok(row.child_id.length > 0)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'no row carries an undefined value')
})

test('a broken shipped-roster projection does not block adoption', async () => {
  // The shipped roster is a projection over the Lead's append-only Team log; a rejected transition
  // leaves it in a permanent failure state and `listMembers` throws. Discovery must degrade to the
  // subagent registry, not disable the roster tools.
  const table = memoryTable()
  const ctx = {
    agentTeams: { listMembers: () => { throw new Error('the Team projection is in a permanent failure state') } },
    subagents: { listDescendants: async () => [descendant('child-1')], drainChildren: async () => {} },
    agents: { get: () => undefined },
    get: () => undefined,
  }
  const roster = await ensureAdopted(ctx, caller, table, 'lead-1')
  assert.equal(roster.members.length, 1)
  assert.equal(roster.members[0].childId, 'child-1')
})

test('a stranded provisioning reservation is reconciled on read', async () => {
  const table = memoryTable()
  const planned = planMember({ leadSessionId: 'lead-1', members: [] }, 'probe', 'Probe the cache')
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [planned] }))

  const stranded = await ensureAdopted(fakeCtx(), caller, table, 'lead-1')
  assert.equal(stranded.members[0].phase, PHASE.failed, 'a reservation that published nothing is retirable')
  assert.match(stranded.members[0].note, /never published/)

  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [planned] }))
  const publishedCtx = {
    ...fakeCtx(),
    agents: { get: (id) => (id === planned.childId ? { id } : undefined) },
  }
  const published = await ensureAdopted(publishedCtx, caller, table, 'lead-1')
  assert.equal(published.members[0].phase, PHASE.active, 'a child that did publish is reconciled to active')
})

test('a mutation suspended across the discovery await cannot resurrect a tombstone', async () => {
  const table = memoryTable()
  const planned = planMember({ leadSessionId: 'lead-1', members: [] }, 'reviewer', 'Check the diff')
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [{ ...planned, phase: PHASE.active }],
  }))

  let releaseDiscovery
  const gate = new Promise((resolve) => { releaseDiscovery = resolve })
  let discoveryStarted
  const started = new Promise((resolve) => { discoveryStarted = resolve })
  let calls = 0
  const ctx = {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => {
        calls += 1
        if (calls === 1) {
          discoveryStarted()
          await gate
          return [descendant('child-2')]
        }
        return []
      },
      drainChildren: async () => {},
    },
    agents: { get: () => undefined },
    get: () => undefined,
  }

  // The adoption reads the roster, then suspends inside the subagent-registry walk.
  const suspended = ensureAdopted(ctx, caller, table, 'lead-1')
  await started
  // A retirement commits while that read is still suspended.
  const retirement = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: caller,
    dataDir: '/tmp/team-relay-test',
    hooks: hooks(),
    target: 'reviewer',
  })
  assert.equal(retirement.retired, true)
  releaseDiscovery()
  await suspended

  const roster = readRoster(table, 'lead-1')
  const reviewer = findAnyTarget(roster, 'reviewer')
  assert.equal(reviewer.phase, PHASE.retired, 'the tombstone survives the adoption write that was suspended')
  assert.equal(reviewer.trashState, 'none')
  assert.ok(roster.members.some((member) => member.childId === 'child-2'), 'the discovery result is still adopted')
})

test('a NaN pressure ratio is omitted instead of failing the tool result', () => {
  const ctx = {
    agents: { get: () => ({ status: 'idle' }) },
    tokenMeter: { contextPressure: () => ({ pressureTokens: Number.NaN, contextWindow: 1024 }) },
    get: () => undefined,
  }
  const member = {
    memberId: 'member-1',
    childId: 'child-1',
    name: 'reviewer',
    generation: 1,
    phase: PHASE.active,
    label: 'Check the diff',
  }
  const row = memberRow(ctx, member)
  assert.equal(Object.hasOwn(row, 'usage_ratio'), false, 'a NaN ratio is not lossless JSON')
  assert.equal(Object.hasOwn(row, 'pressure_tokens'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row)
})
