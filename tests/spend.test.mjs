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
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listMembers, retireMember, spendTokensOf } from '../actions.js'
import { ARCHIVE_FILE_NAME, PHASE, planMember, readRoster } from '../roster.js'
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

// ── the other two sources: an unloaded member, and a tombstone (ADR 0038) ───────────────────────────────

const counters = (counters) => ({ values: { tokenUsage: counters } })

/** One valid stored record. */
const record = (overrides) => ({
  memberId: 'member-1',
  name: 'member-1',
  generation: 1,
  childId: 'child-1',
  phase: PHASE.active,
  label: 'Seeded member',
  createdAt: new Date(0).toISOString(),
  ...overrides,
})

/**
 * A context where no member is attached, so the spend has to come from the Host's own cache or not at all.
 * The call counters are the assertion for the two rules that are about cost rather than value: the listing
 * happens once per call, and a fold happens only at retirement.
 */
function sourcesCtx({ projections, query, cache } = {}) {
  const calls = { listing: 0, fold: 0, cached: 0 }
  return {
    calls,
    ctx: {
      agents: { list: () => [lead], get: () => undefined },
      agentTeams: { tryMembership: () => undefined, listMembers: () => [] },
      subagents: { listDescendants: async () => [], drainChildren: async () => {}, interrupt: () => {} },
      tokenMeter: { contextPressure: () => ({ pressureTokens: 0, contextWindow: 0 }) },
      get: (name) => {
        if (name === 'sessionProjections') return projections
        if (name === 'sessionQuery' && query !== undefined) {
          return {
            listSessions: async () => { calls.listing += 1; return query.listing },
            readSession: async () => { calls.fold += 1; return query.folded },
          }
        }
        if (name === 'sessionProjectionCache' && cache !== undefined) {
          return { cachedSnapshot: (header) => { calls.cached += 1; return cache(header) } }
        }
        return undefined
      },
    },
  }
}

test('an unloaded member is read from the listing header plus the cached row, and the listing runs once', async () => {
  const table = memoryTable()
  await table.put('lead-1', {
    leadSessionId: 'lead-1',
    members: [record({ memberId: 'member-a', name: 'first', childId: 'child-a' }), record({ memberId: 'member-b', name: 'second', childId: 'child-b' })],
  })
  const { ctx, calls } = sourcesCtx({
    query: { listing: [{ id: 'child-a' }, { id: 'child-b' }] },
    cache: (header) => (header.id === 'child-a'
      ? counters({ uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
      : counters({ uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 })),
  })
  const listed = await listMembers(call(ctx, table))
  const rows = Object.fromEntries(listed.members.map((row) => [row.target, row]))
  assert.equal(rows.first.spend_tokens, 10, 'the header found the cached row and the four counters were summed')
  assert.equal(rows.second.spend_tokens, 4)
  assert.equal(calls.listing, 1, 'one listing for the whole call, never one per row')
  assert.equal(calls.cached, 2, 'and one cached read per member')
  assert.equal(calls.fold, 0, 'a listing never folds a log')
})

test('a retired member shows the number its tombstone froze, with the query service unable to see it', async () => {
  const table = memoryTable()
  await table.put('lead-1', {
    leadSessionId: 'lead-1',
    members: [record({ name: 'gone', childId: 'child-gone', phase: PHASE.retired, retiredAt: new Date(0).toISOString(), spendTokens: 4321 })],
  })
  // The artifact is not in the listing at all: nothing but the record can answer.
  const { ctx, calls } = sourcesCtx({ query: { listing: [] } })
  const listed = await listMembers(call(ctx, table))
  assert.equal(listed.members[0].spend_tokens, 4321)
  assert.equal(calls.listing, 0, 'a tombstone needs no listing: its number is on the record')
  assert.equal(listed.members[0].resident, false)
})

test('a tombstone written before this version has no number, and nothing is invented', async () => {
  const table = memoryTable()
  await table.put('lead-1', {
    leadSessionId: 'lead-1',
    members: [record({ name: 'old', childId: 'child-old', phase: PHASE.retired, retiredAt: new Date(0).toISOString() })],
  })
  const { ctx } = sourcesCtx({ query: { listing: [{ id: 'child-old' }] }, cache: () => counters({ uncachedInputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 }) })
  const listed = await listMembers(call(ctx, table))
  assert.equal('spend_tokens' in listed.members[0], false, 'the cache could have answered, but a tombstone is not re-measured')
})

test('no source at all leaves the field absent rather than zero', async () => {
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [record()] })
  const { ctx } = sourcesCtx()
  const listed = await listMembers(call(ctx, table))
  assert.equal('spend_tokens' in listed.members[0], false)
})

/**
 * A context a retirement can actually run in: the persistence fake reports the artifact so the plan can name
 * a trash directory, no Agent is attached, and the spend services are whatever the test supplies.
 */
function retirementCtx({ artifact, services = {} } = {}) {
  return {
    agentTeams: { listMembers: () => [] },
    subagents: { listDescendants: async () => [], drainChildren: async () => {} },
    agents: { get: () => undefined },
    get: (name) => (name === 'sessionPersistence'
      ? { stat: async () => (artifact === undefined ? undefined : { location: { path: artifact } }) }
      : services[name]),
  }
}

const retire = ({ ctx, table, root }) => retireMember({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: root,
  hooks: hooks(),
  target: 'member-1',
  reason: 'a test retires it',
})

test('the capture happens before the artifact moves, and the tombstone keeps the number', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-spend-'))
  const artifact = join(root, 'sessions', 'child-1')
  await mkdir(artifact, { recursive: true })
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [record()] })
  // The cache answers only while the artifact is still where the live store keeps it: that is the whole
  // property under test, and reversing the two operations makes this fixture answer nothing.
  const asked = []
  const ctx = retirementCtx({
    artifact,
    services: {
      sessionQuery: { listSessions: async () => [{ id: 'child-1' }], readSession: async () => { throw new Error('the fold must not run: the cache answered') } },
      sessionProjectionCache: {
        cachedSnapshot: () => {
          asked.push(existsSync(artifact))
          return counters({ uncachedInputTokens: 4000, outputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 22 })
        },
      },
    },
  })
  const retired = await retire({ ctx, table, root })
  assert.equal(retired.retired, true)
  const stored = readRoster(table, 'lead-1').members.find((candidate) => candidate.memberId === 'member-1')
  assert.equal(stored.spendTokens, 4242, 'the number the tombstone keeps')
  assert.equal(stored.phase, PHASE.retired)
  assert.deepEqual(asked, [true], 'the cache was read while the artifact was still in the live store')
  assert.equal(existsSync(artifact), false, 'and the artifact did move afterwards')
})

test('when the cache cannot answer at retirement, the fold runs exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-spend-'))
  const artifact = join(root, 'sessions', 'child-1')
  await mkdir(artifact, { recursive: true })
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [record()] })
  let folded = 0
  const ctx = retirementCtx({
    artifact,
    services: {
      sessionQuery: {
        listSessions: async () => [{ id: 'child-1' }],
        readSession: async () => { folded += 1; return { session: { id: 'child-1' }, events: [] } },
      },
      // The cache is mounted but has nothing for this row, which is what a stale stateVersion looks like
      // from here.
      sessionProjectionCache: { cachedSnapshot: () => undefined },
      sessionProjections: { snapshot: () => counters({ uncachedInputTokens: 900, outputTokens: 90, cacheReadTokens: 9, cacheWriteTokens: 0 }) },
    },
  })
  await retire({ ctx, table, root })
  const stored = readRoster(table, 'lead-1').members.find((candidate) => candidate.memberId === 'member-1')
  assert.equal(folded, 1, 'the fold is affordable here and nowhere else, so it happens once')
  assert.equal(stored.spendTokens, 999)
})

test('a retirement nothing can measure writes no number at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-spend-'))
  const artifact = join(root, 'sessions', 'child-1')
  await mkdir(artifact, { recursive: true })
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [record()] })
  // No query service, no cache, no registry: the profile is minimal and retirement still works.
  await retire({ ctx: retirementCtx({ artifact }), table, root })
  const stored = readRoster(table, 'lead-1').members.find((candidate) => candidate.memberId === 'member-1')
  assert.equal(stored.phase, PHASE.retired, 'the retirement happened')
  assert.equal('spendTokens' in stored, false, 'and nothing was invented for it')
})

test('the archived record keeps the frozen number', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-spend-'))
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [] })
  const archived = record({ name: 'archived-one', childId: 'child-archived', phase: PHASE.retired, retiredAt: '2026-07-01T00:00:00.000Z', spendTokens: 555, trashState: 'done' })
  await writeFile(
    join(root, ARCHIVE_FILE_NAME),
    `${JSON.stringify({ archivedAt: '2026-07-02T00:00:00.000Z', reason: 'beyond-trash-window', leadSessionId: 'lead-1', member: archived })}\n`,
    'utf8',
  )
  const { ctx } = sourcesCtx()
  const listed = await listMembers(call(ctx, table, { dataDir: root, archived: true }))
  const row = listed.members.find((candidate) => candidate.archived === true)
  assert.equal(row.spend_tokens, 555, 'the number rode into the archive with the record and came back with it')
})
