import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRetiredCache, installProjectionFilter, installRosterFilter, installSlotCredit, mergeLiveMembers, stripRetiredMembers } from '../host-hooks.js'
import { livePanelMembers } from '../index.js'

const payload = () => ({
  sessions: [
    {
      id: 'lead-1',
      subagentCatalog: [{ id: 'keep' }, { id: 'gone' }],
      agentTeam: { members: [{ id: 'lead-1' }, { id: 'gone' }] },
    },
  ],
})

test('the projection strip removes retired ids from both catalog shapes', () => {
  const value = stripRetiredMembers(payload(), new Set(['gone']))
  assert.deepEqual(value.sessions[0].subagentCatalog.map((entry) => entry.id), ['keep'])
  assert.deepEqual(value.sessions[0].agentTeam.members.map((entry) => entry.id), ['lead-1'])
})

test('the projection strip also handles streamed frames', () => {
  const frame = { key: 'agentTeam', value: { members: [{ id: 'gone' }] } }
  stripRetiredMembers(frame, new Set(['gone']))
  assert.deepEqual(frame.value.members, [])

  const catalogFrame = { key: 'subagentCatalog', value: [{ id: 'gone' }, { id: 'keep' }] }
  stripRetiredMembers(catalogFrame, new Set(['gone']))
  assert.deepEqual(catalogFrame.value.map((entry) => entry.id), ['keep'])
})

test('an empty tombstone set leaves the payload untouched', () => {
  const value = payload()
  assert.equal(stripRetiredMembers(value, new Set()), value)
  assert.equal(value.sessions[0].subagentCatalog.length, 2)
})

test('the filter wraps the host exits and restores them on dispose', async () => {
  const service = {
    list: async () => payload(),
    projections: async () => payload(),
    async *control() { yield payload() },
    async *follow() { yield payload() },
  }
  const ctx = { get: (name) => (name === 'sessionController' ? service : undefined) }
  const originalList = service.list
  const installed = installProjectionFilter(ctx, { readRetired: async () => new Set(['gone']) })
  assert.equal(installed.installed, true)

  const listed = await service.list()
  assert.deepEqual(listed.sessions[0].subagentCatalog.map((entry) => entry.id), ['keep'])

  for await (const frame of service.control()) {
    assert.deepEqual(frame.sessions[0].agentTeam.members.map((entry) => entry.id), ['lead-1'])
  }

  installed.dispose()
  assert.equal(service.list, originalList, 'dispose restores the host method')
})

test('a host without sessionController is skipped, not fatal', () => {
  const installed = installProjectionFilter({ get: () => undefined }, { readRetired: async () => new Set() })
  assert.equal(installed.installed, false)
  installed.dispose()
})

// The overlay's exits, in the shapes the installed `sessionController` serves: the `projections`
// baseline, a `list` row, the `control` baseline map, a `control` change frame and a `follow` snapshot.
const leadRow = { id: 'lead-1', name: 'lead', role: 'lead', phase: 'active' }
const liveByLead = (lead) => (lead === 'lead-1' ? [{ id: 'child-live', name: 'reviewer-g2' }] : [])
const teamView = (...extra) => ({ members: [leadRow, ...extra], tasks: [] })
const projectionsBaseline = (...extra) => ({ kind: 'sequenced', asOfSeq: 7, values: { agentTeam: teamView(...extra) } })
const listBlock = (...extra) => ({
  items: [{ sessionId: 'lead-1', projections: { kind: 'sequenced', asOfSeq: 7, values: { agentTeam: teamView(...extra) } } }],
})
const controlBaseline = (...extra) => ({
  type: 'baseline',
  value: { projections: { 'lead-1': { asOfSeq: 7, values: { agentTeam: teamView(...extra) } } } },
})
const controlChange = (...extra) => ({
  type: 'projection',
  sessionId: 'lead-1',
  seq: 8,
  changes: [{ key: 'agentTeam', val: teamView(...extra) }],
})
const followSnapshot = (...extra) => ({
  type: 'snapshot',
  header: { id: 'lead-1' },
  projections: { asOfSeq: 7, values: { agentTeam: teamView(...extra) } },
  cursor: 7,
})
const shapes = [
  ['projections baseline', projectionsBaseline],
  ['list block', listBlock],
  ['control baseline', controlBaseline],
  ['control change frame', controlChange],
  ['follow snapshot', followSnapshot],
]
const membersOf = (value) => {
  if (Array.isArray(value.items)) return value.items[0].projections.values.agentTeam.members
  if (value.type === 'baseline') return value.value.projections['lead-1'].values.agentTeam.members
  if (value.type === 'projection') return value.changes[0].val.members
  if (value.type === 'snapshot') return value.projections.values.agentTeam.members
  return value.values.agentTeam.members
}

test('the overlay adds one live member on every exit shape it wraps', () => {
  for (const [label, build] of shapes) {
    const value = build()
    // A `projections` baseline carries no Session id of its own; the wrapped unary method supplies it
    // from the request, exactly as `installProjectionFilter` does. The other shapes carry theirs.
    const hint = label === 'projections baseline' ? 'lead-1' : undefined
    const result = mergeLiveMembers(value, liveByLead, hint)
    assert.equal(result, value, `${label}: the payload reference is kept`)
    assert.deepEqual(membersOf(value).map((member) => member.id), ['lead-1', 'child-live'], label)
    assert.deepEqual(membersOf(value).at(-1), {
      id: 'child-live',
      name: 'reviewer-g2',
      role: 'teammate',
      phase: 'active',
    }, `${label}: only the four fields the wire schema requires`)
  }
})

test('a member the value already carries is neither duplicated nor renamed', () => {
  const shipped = { id: 'child-live', name: 'shipped-name', role: 'lead', phase: 'failed' }
  for (const [label, build] of shapes) {
    const value = build(shipped)
    mergeLiveMembers(value, liveByLead, label === 'projections baseline' ? 'lead-1' : undefined)
    const members = membersOf(value)
    assert.equal(members.length, 2, label)
    assert.deepEqual(members[1], shipped, `${label}: the existing row is left exactly as it is`)
  }
})

test('the filter still strips a retired member from every exit and still merges the live one', async () => {
  const gone = { id: 'gone', name: 'retired-member', role: 'teammate', phase: 'active' }
  const service = {
    list: async () => listBlock(gone),
    projections: async (request) => projectionsBaseline(gone),
    async *control() { yield controlBaseline(gone); yield controlChange(gone) },
    async *follow() { yield followSnapshot(gone) },
  }
  const ctx = { get: () => service }
  const installed = installProjectionFilter(ctx, {
    readRetired: async () => new Set(['gone']),
    readLive: liveByLead,
  })
  assert.equal(installed.installed, true)

  const frames = [await service.list(), await service.projections({ sessionId: 'lead-1' })]
  for await (const frame of service.control()) frames.push(frame)
  for await (const frame of service.follow()) frames.push(frame)
  assert.equal(frames.length, 5)
  for (const frame of frames) {
    assert.deepEqual(membersOf(frame).map((member) => member.id), ['lead-1', 'child-live'])
  }

  installed.dispose()
})

test('nothing to merge leaves the outgoing value untouched', async () => {
  const value = projectionsBaseline()
  const team = value.values.agentTeam
  const members = team.members
  assert.equal(mergeLiveMembers(value, () => []), value)
  assert.equal(value.values.agentTeam, team)
  assert.equal(team.members, members)
  assert.deepEqual(members.map((member) => member.id), ['lead-1'])

  // Every candidate already present is the other empty case: the same array reference, not a copy.
  assert.equal(mergeLiveMembers(value, () => [{ id: 'lead-1', name: 'lead' }]).values.agentTeam.members, members)
})

test('dispose restores every wrapped exit, not only list', async () => {
  const service = {
    list: async () => listBlock(),
    projections: async () => projectionsBaseline(),
    async *control() { yield controlBaseline() },
    async *follow() { yield followSnapshot() },
  }
  const originals = {
    list: service.list,
    projections: service.projections,
    control: service.control,
    follow: service.follow,
  }
  const installed = installProjectionFilter({ get: () => service }, {
    readRetired: async () => new Set(),
    readLive: liveByLead,
  })
  assert.equal(installed.installed, true)
  assert.equal((await service.projections({ sessionId: 'lead-1' })).values.agentTeam.members.length, 2)

  installed.dispose()
  for (const method of Object.keys(originals)) {
    assert.equal(service[method], originals[method], `dispose restores ${method}`)
  }
})

test('a roster row with no recorded child id is not offered to the panel', () => {
  const rows = livePanelMembers({
    members: [
      { memberId: 'm1', name: 'reviewer', generation: 1, childId: 'child-ready', phase: 'active' },
      { memberId: 'm2', name: 'writer', generation: 2, childId: 'child-successor', phase: 'active' },
      { memberId: 'm3', name: 'reserved', generation: 1, childId: '', phase: 'active' },
      { memberId: 'm4', name: 'nameless', generation: 1, phase: 'active' },
      { memberId: 'm5', name: 'starting', generation: 1, childId: 'child-starting', phase: 'provisioning' },
      { memberId: 'm6', name: 'gone', generation: 1, childId: 'child-gone', phase: 'retired' },
    ],
  })
  assert.deepEqual(rows, [
    { id: 'child-ready', name: 'reviewer' },
    { id: 'child-successor', name: 'writer-g2' },
  ])
})

test('slot credit raises the shipped limit only for the spawning Lead', async () => {
  const roster = {
    maxMembers: 2,
    membership: (caller) => ({ root: { id: caller.leadId } }),
    async spawn(caller) {
      return { visibleMax: this.maxMembers, leadId: caller.leadId }
    },
  }
  const service = { roster }
  const ctx = { get: (name) => (name === 'agentTeams' ? service : undefined) }
  const installed = installSlotCredit(ctx, {
    readRetiredByTeam: async () => new Map([['lead-1', 3]]),
  })
  assert.equal(installed.installed, true)
  await installed.refresh()

  assert.equal(roster.maxMembers, 2, 'outside a spawn the limit is the configured one')
  assert.deepEqual(await roster.spawn({ leadId: 'lead-1' }), { visibleMax: 5, leadId: 'lead-1' })
  assert.deepEqual(await roster.spawn({ leadId: 'lead-2' }), { visibleMax: 2, leadId: 'lead-2' })
  assert.equal(roster.maxMembers, 2, 'credit is not left behind after a spawn')

  installed.dispose()
  assert.equal(roster.maxMembers, 2)
})

test('a nested spawn keeps the outer Lead credit after the inner one finishes', async () => {
  // `live.current` is one process-wide field and the effective limit is read later, inside the real
  // spawn's transact. Resetting it to zero in the inner `finally` would silently drop the outer
  // Lead's credit for the rest of that spawn.
  const roster = {
    maxMembers: 2,
    membership: (caller) => ({ root: { id: caller.leadId } }),
    async spawn(caller) {
      const before = this.maxMembers
      const nested = caller.nested === undefined ? undefined : await this.spawn(caller.nested)
      return { before, after: this.maxMembers, nested, leadId: caller.leadId }
    },
  }
  const service = { roster }
  const ctx = { get: (name) => (name === 'agentTeams' ? service : undefined) }
  const installed = installSlotCredit(ctx, {
    readRetiredByTeam: async () => new Map([['lead-1', 3]]),
  })
  assert.equal(installed.installed, true)
  await installed.refresh()

  const outer = await roster.spawn({ leadId: 'lead-1', nested: { leadId: 'lead-2' } })
  assert.equal(outer.before, 5, 'the spawning Lead sees its own credit')
  assert.equal(outer.nested.after, 2, 'the nested spawn sees only its own Lead credit')
  assert.equal(outer.after, 5, 'the outer credit is restored, not zeroed')
  assert.equal(roster.maxMembers, 2)

  installed.dispose()
  assert.equal(roster.maxMembers, 2)
})

test('slot credit is skipped when the roster shape is absent', () => {
  const installed = installSlotCredit({ get: () => ({ roster: {} }) }, { readRetiredByTeam: async () => new Map() })
  assert.equal(installed.installed, false)
})

// The shapes the owner reported from a live profile: the member panel counted 37 rows and the top
// subagent picker 36 entries, with retired members mixed in. Five tombstones are the population these
// tests carry; the exact count in a profile comes from its own roster store.
const many = (count, prefix, role = 'teammate') => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`,
  name: `${prefix}-${index}`,
  role,
  phase: 'active',
}))

test('a 37-row panel loses exactly the five tombstoned rows, keeping the lead and every live member', () => {
  const lead = { id: 'lead-1', name: 'lead', role: 'lead', phase: 'active' }
  const live = many(31, 'live')
  const gone = many(5, 'gone')
  const members = [lead, ...live, ...gone]
  assert.equal(members.length, 37)

  const value = { values: { agentTeam: { members, tasks: [] } } }
  stripRetiredMembers(value, new Set(gone.map((row) => row.id)))

  const kept = value.values.agentTeam.members
  assert.equal(kept.length, 32)
  assert.deepEqual(kept.map((row) => row.id), [lead, ...live].map((row) => row.id))
  assert.equal(kept[0], lead, 'the Session that is not a member tombstone is never stripped')
  for (const row of live) assert.ok(kept.includes(row), `${row.id} stays`)
})

test('a 36-entry catalog frame loses the same five tombstones and nothing else', () => {
  const live = many(30, 'live')
  const gone = many(5, 'gone')
  const lead = { id: 'lead-1', name: 'lead', role: 'lead', phase: 'active' }
  const frame = { key: 'subagentCatalog', value: [lead, ...live, ...gone] }
  assert.equal(frame.value.length, 36)

  stripRetiredMembers(frame, new Set(gone.map((row) => row.id)))

  assert.equal(frame.value.length, 31)
  assert.equal(frame.value[0].id, 'lead-1')
  assert.ok(frame.value.every((row) => !row.id.startsWith('gone-')))
})

test('a failed tombstone read is reported and keeps the last good set in force', async () => {
  const liked = { sessions: [{ id: 'lead-1', subagentCatalog: [{ id: 'gone' }, { id: 'keep' }] }] }
  const service = { list: async () => liked }
  let fail = false
  const logged = []
  const cache = createRetiredCache({
    readRetired: async () => {
      if (fail) throw new Error('storage domain unavailable')
      return new Set(['gone'])
    },
    log: (line) => logged.push(line),
    ttlMs: 0,
  })
  const installed = installProjectionFilter({ get: () => service }, { cache })
  assert.equal(installed.installed, true)

  await service.list()
  assert.equal((await cache.report()).ids, 1)
  assert.equal((await cache.report()).failed, false)

  // The read fails. The retired member must not come back — the last set stays in force — and the
  // failure is visible in the report instead of being absorbed by an empty set.
  fail = true
  cache.invalidate()
  const after = await service.list()
  assert.deepEqual(after.sessions[0].subagentCatalog.map((entry) => entry.id), ['keep'])
  assert.deepEqual(await cache.report(), { ids: 1, failed: true })
  assert.ok(logged.some((line) => /could not read tombstones/.test(line)))

  // A later successful read clears the flag, so a transient failure does not linger in the report.
  fail = false
  cache.invalidate()
  await service.list()
  assert.deepEqual(await cache.report(), { ids: 1, failed: false })
  // Two reads failed while `fail` was true: the frame read and the forced report read. The recovery
  // adds no line.
  assert.equal(logged.length, 2)
})

test('invalidate forces the next read, which is what a retirement relies on', async () => {
  let reads = 0
  const cache = createRetiredCache({
    readRetired: async () => { reads += 1; return new Set(['gone']) },
    ttlMs: 60_000,
  })
  await cache.ids()
  assert.equal(reads, 1)
  await cache.ids()
  assert.equal(reads, 1, 'inside the window the cached set is used')
  cache.invalidate()
  await cache.ids()
  assert.equal(reads, 2, 'invalidate makes the next frame re-read')
})
