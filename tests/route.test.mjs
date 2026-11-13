import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listMembers, spawnMember } from '../actions.js'
import { PHASE, ROUTE_SOURCE, readRoster, updateRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * The route the whole suite treats as the Lead's current one: the relay the owner switched to. The other
 * route is the official API the stragglers in the measured profile were still billed to.
 */
const RELAY = { provider: 'do', model: 'DeepSeek-V4.1-Flash' }
const OFFICIAL = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** A `requestHeader()` that answers what the Harness logged for the Lead's latest request. */
const headerOf = (route) => (route === null ? undefined : { config: route })

/**
 * A context fake with the two things a route touches: the Lead Session's own request header — the source
 * the Harness resolves inheritance from — and the spawn provider's capability table.
 *
 * `route: null` models a Session whose accessor exists but answers nothing (no request logged yet);
 * `headerless` models a Session object with no accessor at all. Both are fallbacks this feature must
 * survive, and they are different failures.
 */
function fakeCtx({ route = RELAY, headerless = false, agentOptionsCapability = true, shippedRoster = [], failStart } = {}) {
  const requests = []
  const lead = headerless
    ? { session: { id: 'lead-1' } }
    : { session: { id: 'lead-1', requestHeader: () => headerOf(route) } }
  const ctx = {
    agentTeams: { listMembers: () => shippedRoster },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => {
        requests.push(spec.request)
        const failure = failStart?.(spec.request)
        if (failure !== undefined) throw failure
        return { childId: spec.childId }
      },
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
      getProvider: (name) => (name === 'spawn'
        ? { name, capabilities: { agentOptions: agentOptionsCapability, agentPreset: true } }
        : undefined),
    },
    agents: { get: () => undefined },
    get: () => undefined,
  }
  return { ctx, lead, requests }
}

/** The host-side effects a retirement refreshes. */
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

/** The arguments every roster operation takes. */
const call = (ctx, table, lead, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: '/tmp/dsh-team-test',
  hooks: hooks(),
  ...extra,
})

/** Spawn one member with the defaults the other assertions share. */
const spawn = (ctx, table, lead, extra = {}) => spawnMember(call(ctx, table, lead, {
  name: 'probe',
  label: 'Probe the cache',
  prompt: 'Start.',
  ...extra,
}))

const members = (table) => readRoster(table, 'lead-1').members

test('a spawn with no agent_options forwards the Lead\'s current route and records it', async () => {
  const table = memoryTable()
  const { ctx, lead, requests } = fakeCtx()
  const born = await spawn(ctx, table, lead)

  // The same two fields the Harness would have resolved, from the same place, now sent explicitly.
  assert.deepEqual(requests[0].agentOptions, { provider: RELAY.provider, model: RELAY.model })
  assert.deepEqual(born.route, { source: 'plugin', provider: RELAY.provider, model: RELAY.model })
  assert.equal(born.started_with.route_source, 'plugin')
  assert.deepEqual(members(table)[0].route, born.route, 'the record carries the same route the row reports')
  assert.equal(Object.hasOwn(born, 'route_stale'), false, 'a member just started on the Lead\'s route is not stale')
})

test('an explicit caller route wins, and the result says the route came from the call', async () => {
  const table = memoryTable()
  const { ctx, lead, requests } = fakeCtx()
  const born = await spawn(ctx, table, lead, {
    agentOptions: { provider: OFFICIAL.provider, model: OFFICIAL.model },
  })

  assert.deepEqual(requests[0].agentOptions, { provider: OFFICIAL.provider, model: OFFICIAL.model })
  assert.equal(born.started_with.route_source, 'caller')
  assert.deepEqual(born.route, { source: 'caller', provider: OFFICIAL.provider, model: OFFICIAL.model })
  assert.equal(Object.hasOwn(born, 'route_stale'), false, 'a spawn answer describes the member, not the roster')
})

test('a caller route named partially is completed from the Lead\'s route, and stays the caller\'s', async () => {
  const table = memoryTable()
  const { ctx, lead, requests } = fakeCtx()
  const born = await spawn(ctx, table, lead, { agentOptions: { model: 'other-model' } })

  // The Harness merges the request over the parent, so the child runs on the Lead's provider with the
  // caller's model; the record says the whole route rather than half of it.
  assert.deepEqual(requests[0].agentOptions, { model: 'other-model' })
  assert.deepEqual(born.route, { source: 'caller', provider: RELAY.provider, model: 'other-model' })
  assert.equal(born.started_with.route_source, 'caller')
})

test('a route that cannot be resolved inherits exactly as before and says so', async () => {
  for (const [label, options, expectedReason] of [
    ['no accessor on the Session', { headerless: true }, 'no-session-route'],
    ['no request logged yet', { route: null }, 'no-session-route'],
    ['a header whose config names no complete route', { route: { provider: 'do' } }, 'no-session-route'],
  ]) {
    const table = memoryTable()
    const { ctx, lead, requests } = fakeCtx(options)
    const born = await spawn(ctx, table, lead)

    assert.deepEqual(requests[0], { prompt: [{ type: 'text', text: 'Start.' }], parent: lead }, `${label}: no route is sent`)
    assert.equal(born.started_with.route_source, 'inherited', `${label}: the result says which path ran`)
    assert.equal(born.route.source, 'inherited')
    assert.equal(born.route.select_reason, expectedReason)
    assert.equal(Object.hasOwn(born.route, 'provider'), false, `${label}: nothing unknown is recorded as known`)
    assert.equal(Object.hasOwn(born.route, 'model'), false)
    assert.equal(members(table)[0].phase, PHASE.active, `${label}: the spawn still happens`)
  }
})

test('a provider that advertises no agentOptions capability inherits and says so', async () => {
  const table = memoryTable()
  const { ctx, lead, requests } = fakeCtx({ agentOptionsCapability: false })
  const born = await spawn(ctx, table, lead)

  // Forwarding one would make the seam reject the start with UNSUPPORTED_CAPABILITY, which is a broken
  // spawn caused by a step the caller never asked for.
  assert.deepEqual(requests[0], { prompt: [{ type: 'text', text: 'Start.' }], parent: lead })
  assert.equal(born.started_with.route_source, 'inherited')
  assert.deepEqual(born.route, {
    source: 'inherited',
    provider: RELAY.provider,
    model: RELAY.model,
    select_reason: 'capability-absent',
  }, 'the route is known, so it is recorded; only the forwarding did not happen')
  assert.equal(members(table)[0].phase, PHASE.active)
})

test('reasoning_effort is never forwarded, however the route was resolved', async () => {
  // A Session whose own request header carries an effort: the Lead's effort survives the Harness merge on
  // its own, and forwarding an effort the caller never named is what fails a child's first request.
  const table = memoryTable()
  const { ctx, lead, requests } = fakeCtx({ route: { ...RELAY, reasoningEffort: 'high' } })
  await spawn(ctx, table, lead)
  assert.deepEqual(Object.keys(requests[0].agentOptions).sort(), ['model', 'provider'])
  assert.equal(Object.hasOwn(requests[0].agentOptions, 'reasoningEffort'), false)

  // A caller who names one still gets it, because that is the caller's own field and ADR 0016 forwards it;
  // the plugin's resolved route joins it rather than replacing it.
  const named = memoryTable()
  const second = fakeCtx()
  await spawn(second.ctx, named, second.lead, { agentOptions: { reasoning_effort: 'low' } })
  assert.deepEqual(second.requests[0].agentOptions, {
    provider: RELAY.provider,
    model: RELAY.model,
    reasoningEffort: 'low',
  })
})

test('a member whose route differs from the Lead\'s is flagged, and one that matches is not', async () => {
  const table = memoryTable()
  const { ctx, lead } = fakeCtx()
  const stale = await spawn(ctx, table, lead, { name: 'stale', agentOptions: OFFICIAL })
  const current = await spawn(ctx, table, lead, { name: 'current' })

  const listed = await listMembers(call(ctx, table, lead))
  const byTarget = new Map(listed.members.map((row) => [row.target, row]))
  const staleRow = byTarget.get('stale')
  const currentRow = byTarget.get('current')

  assert.equal(staleRow.route_stale, true)
  assert.match(staleRow.route_note, /deepseek-official\/deepseek-flash/)
  assert.match(staleRow.route_note, /do\/DeepSeek-V4\.1-Flash/, 'the sentence names both routes')
  assert.match(staleRow.route_note, /spawn_member \{ replace: "stale"/, 'and the one call that clears it')
  assert.deepEqual(staleRow.route, { source: 'caller', provider: OFFICIAL.provider, model: OFFICIAL.model })
  assert.equal(Object.hasOwn(currentRow, 'route_stale'), false)
  assert.deepEqual(currentRow.route, { source: 'plugin', provider: RELAY.provider, model: RELAY.model })
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed, 'the read stays lossless JSON')

  // The flag is a read-time fact, not a stored one: the record of the stale member is untouched.
  assert.equal(Object.hasOwn(members(table).find((member) => member.name === 'stale'), 'route_stale'), false)
  assert.equal(stale.target, 'stale')
  assert.equal(current.target, 'current')
})

test('a route that later matches clears the flag', async () => {
  const table = memoryTable()
  const { ctx, lead } = fakeCtx()
  await spawn(ctx, table, lead, { name: 'straggler', agentOptions: OFFICIAL })

  const before = await listMembers(call(ctx, table, lead))
  assert.equal(before.members[0].route_stale, true)

  // The Lead moves back to the route the member is still on: the same record, the same row, no flag.
  const moved = fakeCtx({ route: OFFICIAL })
  const after = await listMembers(call(moved.ctx, table, moved.lead))
  assert.equal(after.members[0].status, 'unloaded')
  assert.equal(Object.hasOwn(after.members[0], 'route_stale'), false)
  assert.equal(Object.hasOwn(after.members[0], 'route_note'), false)
  assert.deepEqual(after.members[0].route, { source: 'caller', provider: OFFICIAL.provider, model: OFFICIAL.model })
})

test('a read whose own route cannot be resolved flags nobody', async () => {
  const table = memoryTable()
  const { ctx, lead } = fakeCtx()
  await spawn(ctx, table, lead, { name: 'known', agentOptions: OFFICIAL })

  // A Lead with no readable route is not evidence that every member is a straggler.
  const blind = fakeCtx({ headerless: true })
  const listed = await listMembers(call(blind.ctx, table, blind.lead))
  assert.equal(Object.hasOwn(listed.members[0], 'route_stale'), false)
  assert.deepEqual(listed.members[0].route, { source: 'caller', provider: OFFICIAL.provider, model: OFFICIAL.model })
})

test('a record written before this release has no route and is neither flagged nor guessed at', async () => {
  const table = memoryTable()
  const { ctx, lead } = fakeCtx()
  const born = await spawn(ctx, table, lead)
  // Simulate an older profile's record: a tombstone-era shape with no `route` field at all.
  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    members: current.members.map((member) => {
      const { route: _route, ...legacy } = member
      return legacy
    }),
  }))

  const listed = await listMembers(call(ctx, table, lead))
  assert.equal(typeof born.route, 'object', 'the spawn itself recorded one')
  assert.equal(Object.hasOwn(listed.members[0], 'route'), false, 'an old record is not retro-filled')
  assert.equal(Object.hasOwn(listed.members[0], 'route_stale'), false, 'and is not called stale by default')
})

test('an adopted member keeps the record it had, because adoption is not a spawn', async () => {
  const table = memoryTable()
  const { ctx, lead } = fakeCtx()
  const listed = await listMembers(call(ctx, table, lead))
  assert.deepEqual({ members: listed.members, archived_records: listed.archived_records }, { members: [], archived_records: 0 }, 'an empty roster gains no route field anywhere')

  // A discovery row this plugin did not spawn has no route to know, and is reported as it was adopted.
  const shipped = fakeCtx({
    shippedRoster: [{ id: 'shipped-child', name: 'shipped', description: 'From the shipped roster', role: 'teammate', status: 'active' }],
  })
  const adopted = await listMembers(call(shipped.ctx, table, shipped.lead))
  assert.equal(adopted.members.length, 1)
  assert.equal(Object.hasOwn(adopted.members[0], 'route'), false)
  assert.equal(Object.hasOwn(adopted.members[0], 'route_stale'), false)
})

test('the route source covers all three paths', () => {
  // A guard on the vocabulary itself: the record and the row both carry one of these three, and the schema
  // and the record validation are what stop a fourth from being written (ADR 0024).
  assert.deepEqual(Object.values(ROUTE_SOURCE), ['caller', 'plugin', 'inherited'])
})
