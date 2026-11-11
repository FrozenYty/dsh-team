import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureAdopted, listMembers } from '../actions.js'
import { PHASE, readRoster } from '../roster.js'

/** A roster table with the two methods the lifecycle uses. */
function memoryTable() {
  const rows = new Map()
  return {
    get: (key) => rows.get(key),
    put: async (key, value) => {
      rows.set(key, value)
    },
  }
}

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
    subagents: { listDescendants: async () => descendants },
    agents: { get: () => undefined },
    get: () => undefined,
  }
}

const caller = { session: { id: 'lead-1' } }

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
