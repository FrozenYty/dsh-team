/**
 * What a member has spent, which is a different question from how full its context is.
 *
 * `pressure_tokens` and `usage_ratio` answer "how full is this member?" — a level, read from `tokenMeter`.
 * Neither answers "who is expensive?", which is what a Lead running five standing roles needs, so a row
 * carries `spend_tokens`: the four counters of the member's durable log summed, read from the projections
 * registry rather than from `tokenMeter`, whose `tokenUsage` handle is registered and discarded and whose
 * `measure()` reports pressure (ADR 0037).
 *
 * The two rules that shape every test here are the ones a careless version gets wrong: the number is the
 * **sum of the four counters** and nothing else, and it is **omitted** rather than reported as `0` when the
 * projection cannot be read, because "nothing measured" and "nothing spent" are different claims.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listMembers, spendTokensOf } from '../actions.js'
import { PHASE, planMember } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })
const lead = { session: { id: 'lead-1' } }

/** The four counters of one Session, as the registry reports them. */
const usageOf = (counters) => ({
  snapshot: (_session, units) => (units.includes('tokenUsage') ? { values: { tokenUsage: counters } } : { values: {} }),
})

/**
 * A context whose member is attached, with whatever registry the caller supplies. `projections` is omitted
 * entirely by default, which is a profile where the registry is absent — the case `inject` deliberately does
 * not gate on.
 */
function fakeCtx({ childId = 'child-1', projections } = {}) {
  const caller = { id: 'lead-1', status: 'idle', session: { id: 'lead-1' } }
  const member = { id: childId, status: 'idle', session: { id: childId } }
  return {
    agents: { list: () => [caller, member], get: (id) => (id === caller.id ? caller : id === member.id ? member : undefined) },
    agentTeams: { tryMembership: () => undefined, listMembers: () => [] },
    subagents: { listDescendants: async () => [], drainChildren: async () => {}, interrupt: () => {} },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 12, contextWindow: 100 }) },
    get: (name) => (name === 'sessionProjections' ? projections : undefined),
  }
}

const call = (ctx, table, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: extra.dataDir,
  hooks: hooks(),
  ...extra,
})

/** One live member of this Lead, whose recorded child id the context above answers for. */
const member = (fields = {}) => ({
  ...planMember({ leadSessionId: 'lead-1', members: [] }, fields.name ?? 'reviewer', 'Check the diff'),
  childId: 'child-1',
  ...fields,
})

test('a measurable member carries the sum of the four counters, and nothing else', async () => {
  const counters = { uncachedInputTokens: 1200, outputTokens: 300, cacheReadTokens: 40_000, cacheWriteTokens: 5000 }
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })

  const listed = await listMembers(call(fakeCtx({ projections: usageOf(counters) }), table))
  const row = listed.members[0]
  assert.equal(row.spend_tokens, 1200 + 300 + 40_000 + 5000, 'the four counters and nothing else')
  // The pressure fields are a different measurement and are still there, side by side.
  assert.equal(row.pressure_tokens, 12)
  assert.equal(row.usage_ratio, 0.12)

  // A different set of counters moves the number by exactly that set, so the field cannot be a constant that
  // happens to look plausible.
  const other = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 2 }
  const second = await listMembers(call(fakeCtx({ projections: usageOf(other) }), table))
  assert.equal(second.members[0].spend_tokens, 3)
})

test('an unreadable projection omits the field rather than reporting zero', async () => {
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })
  const absent = [
    ['no registry at all', undefined],
    ['a registry with no snapshot', {}],
    ['a snapshot with no tokenUsage unit', { snapshot: () => ({ values: {} }) }],
    ['a session the registry has forgotten', { snapshot: () => undefined }],
    ['a damaged counter', usageOf({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: null })],
    ['a snapshot that throws', { snapshot: () => { throw new Error('the Session is gone') } }],
  ]
  for (const [label, projections] of absent) {
    const listed = await listMembers(call(fakeCtx({ projections }), table))
    assert.equal('spend_tokens' in listed.members[0], false, `${label}: the field is absent, not zero`)
    assert.equal(listed.members[0].pressure_tokens, 12, `${label}: and the rest of the row is intact`)
  }
})

test('a retired member whose Session is no longer attached builds a row without throwing', async () => {
  // The case the research could not settle: the roster still holds the tombstone, the child is gone, and
  // there is no Agent to ask. The row must be built anyway, with the field absent — not with a zero and not
  // with an exception.
  const table = memoryTable()
  await table.put('lead-1', {
    leadSessionId: 'lead-1',
    members: [{ ...member({ name: 'gone' }), childId: 'child-absent', phase: PHASE.retired, retiredAt: new Date(0).toISOString() }],
  })
  const ctx = fakeCtx({ childId: 'child-1', projections: usageOf({ uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 5 }) })
  const listed = await listMembers(call(ctx, table))
  assert.equal(listed.members.length, 1)
  assert.equal(listed.members[0].target, 'gone')
  assert.equal(listed.members[0].resident, false)
  assert.equal('spend_tokens' in listed.members[0], false, 'no Agent, no projection, no field')
  assert.equal('pressure_tokens' in listed.members[0], false, 'and the same is true of pressure')

  // And the reader itself never throws on a missing Agent, whatever the registry would have said.
  assert.equal(spendTokensOf(ctx, undefined), undefined)
})

test('a member whose Session is gone but whose Agent is held omits the field, and does not throw', async () => {
  // The middle case: the Agent object is still here (an unloaded child, or a projection read racing a
  // detach) but the registry cannot answer for its Session. The row is built, the field is absent.
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })
  const listed = await listMembers(call(fakeCtx({ projections: { snapshot: () => { throw new Error('detached mid-read') } } }), table))
  assert.equal('spend_tokens' in listed.members[0], false)
})
