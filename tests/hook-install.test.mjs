/**
 * The host hooks are dependencies, not load-time side effects.
 *
 * The defect these tests pin: `apply` used to call both installers once, each installer read its
 * service with `ctx.get` and skipped silently when the service was not there yet. The bundle's patch row
 * can activate before the Web profile publishes `sessionController`, so the filter was lost for the life
 * of the process while the tools kept promising it. The fix defers each install through Cordis's own
 * dependency gate (`ctx.inject`), so these tests drive a fake of that gate: a service absent at load is
 * published later, a service that never appears leaves the hook absent, and a reload must not wrap twice
 * (ADR 0025).
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { restoreMember, retireMember } from '../actions.js'
import { installRosterFilter } from '../host-hooks.js'
import { PHASE, planMember, updateRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

const teamPayload = () => ({
  sessions: [{
    id: 'lead-1',
    subagentCatalog: [{ id: 'gone' }, { id: 'keep' }],
    agentTeam: { members: [{ id: 'lead-1', name: 'lead', role: 'lead' }, { id: 'gone', name: 'probe', role: 'teammate' }], tasks: [] },
  }],
})

/** One tombstoned member of this Lead, whose recorded child id is the one the payloads carry. */
function seededTable() {
  const table = memoryTable()
  const retired = {
    ...planMember({ leadSessionId: 'lead-1', members: [] }, 'probe', 'Probe'),
    childId: 'gone',
    phase: PHASE.retired,
    retiredAt: new Date(0).toISOString(),
    archived: false,
  }
  table.put('lead-1', { leadSessionId: 'lead-1', members: [retired] })
  return table
}

/**
 * A Host context with Cordis's dependency gate in it.
 *
 * `inject` mirrors the real contract: the callback runs when every named service is provided, and the
 * returned disposer runs when the gate unloads. It activates synchronously where Cordis activates a
 * microtask later — nothing observes that difference — so a test reads the result without a sleep.
 */
function fakeHost({ agentTeams, sessionController, table = seededTable() } = {}) {
  const services = new Map()
  const subscriptions = []
  const tools = new Map()
  const disposers = []
  const lead = {
    id: 'lead-1',
    status: 'idle',
    session: { id: 'lead-1', header: {} },
    ctx: { tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } },
  }
  const child = {
    id: 'child-1',
    status: 'idle',
    session: { id: 'child-1', header: { parentSession: 'lead-1' } },
    ctx: { tools: { register: () => () => {} } },
  }
  const start = (entry) => {
    if (entry.ran) return
    if (!entry.names.every((name) => services.has(name))) return
    entry.ran = true
    entry.dispose = entry.callback()
  }
  const ctx = {
    agents: { list: () => [lead, child], get: (id) => (id === lead.id ? lead : id === child.id ? child : undefined) },
    agentTeams,
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => ({ childId: spec.childId }),
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
      getProvider: (name) => ({ name, capabilities: { agentOptions: true, agentPreset: true } }),
    },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 0, contextWindow: 0 }) },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    get: (name) => services.get(name),
    inject: (names, callback) => {
      const entry = { names, callback, ran: false, dispose: undefined }
      subscriptions.push(entry)
      start(entry)
      return { then: () => {} }
    },
    on: () => () => {},
    effect: (install) => {
      const dispose = install()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { warn() {} },
  }
  if (sessionController !== undefined) services.set('sessionController', sessionController)
  // `agentTeams` is this plugin's own required injection, so it is always there when `apply` runs; these
  // tests vary its shape, not its presence. `sessionController` is the service that arrives later.
  services.set('agentTeams', agentTeams)
  const host = {
    ctx,
    table,
    tools,
    lead,
    child,
    publish(name, value) { services.set(name, value); for (const entry of subscriptions) start(entry) },
    unload() { for (const entry of subscriptions.splice(0)) if (typeof entry.dispose === 'function') entry.dispose() },
    list: async () => tools.get('list_members').execute({}, { agent: lead }),
  }
  return host
}

const shippedAgentTeams = (rows) => ({
  tryMembership: () => undefined,
  listMembers: () => rows,
  roster: {
    maxMembers: 2,
    membership: (caller) => ({ root: { id: caller.session.id } }),
    async spawn() { return { visibleMax: this.maxMembers } },
  },
})

test('a hook whose service is absent at load installs when the service appears, once', async () => {
  const service = {
    list: async () => teamPayload(),
    projections: async () => teamPayload(),
    async *control() { yield teamPayload() },
    async *follow() { yield teamPayload() },
  }
  const host = fakeHost({
    agentTeams: shippedAgentTeams([
      { id: 'lead-1', name: 'lead', role: 'lead' },
      { id: 'gone', name: 'probe', role: 'teammate' },
    ]),
  })
  apply(host.ctx, {})

  // At load the panel filter has no service: the answer says so instead of losing the feature silently.
  const before = await host.list()
  assert.equal(before.host_hooks.panel_filter, 'absent')
  assert.equal(before.host_hooks.roster_filter, 'installed')
  assert.equal(before.host_hooks.stripped_ids, 1, 'the store is already known, so the count is real')

  host.publish('sessionController', service)

  const after = await host.list()
  assert.equal(after.host_hooks.panel_filter, 'installed')
  assert.equal(after.host_hooks.slot_credit, 'installed')
  assert.equal(after.host_hooks.stripped_ids, 1)
  assert.equal(after.host_hooks.tombstone_read_failed, false)
  assert.equal(after.host_hooks.message, undefined, 'nothing is missing, so nothing is explained')

  // Both list shapes the shipped clients read lose the tombstoned member, and keep everything else.
  const listed = await service.list()
  assert.deepEqual(listed.sessions[0].subagentCatalog.map((entry) => entry.id), ['keep'])
  assert.deepEqual(listed.sessions[0].agentTeam.members.map((member) => member.id), ['lead-1'])
})

test('a hook whose service never appears reports absent, and every tool keeps working', async () => {
  // The shape a host without the Web layer presents: `agentTeams` is there because this plugin requires
  // it, but it carries neither the roster read nor the member budget.
  const host = fakeHost({ agentTeams: { tryMembership: () => undefined }, table: memoryTable() })
  apply(host.ctx, {})

  const listed = await host.list()
  assert.deepEqual(listed.members, [])
  assert.equal(listed.host_hooks.panel_filter, 'absent')
  assert.equal(listed.host_hooks.roster_filter, 'absent')
  assert.equal(listed.host_hooks.slot_credit, 'absent')
  assert.equal('stripped_ids' in listed.host_hooks, false, 'nothing is stripping, so no number is claimed')
  assert.match(listed.host_hooks.message, /sessionController/)
  assert.match(listed.host_hooks.message, /list_agents/)
  assert.match(listed.host_hooks.message, /agentTeams\.roster/)
  assert.match(listed.host_hooks.message, /tools are unaffected/)

  // The tool surface is the thing that must not depend on a host hook: a spawn still works and the
  // member is listed after it.
  const born = await host.tools.get('spawn_member')
    .execute({ name: 'reviewer', label: 'Reviewer', prompt: 'Start.' }, { agent: host.lead })
  assert.equal(born.target, 'reviewer')
  const again = await host.list()
  assert.deepEqual(again.members.map((member) => member.target), ['reviewer'])
})

test('a reload does not wrap the exits twice, and one dispose restores every method', async () => {
  const service = {
    list: async () => teamPayload(),
    projections: async () => teamPayload(),
    async *control() { yield teamPayload() },
    async *follow() { yield teamPayload() },
  }
  const original = { ...service }
  const agentTeams = shippedAgentTeams([{ id: 'lead-1', name: 'lead', role: 'lead' }])
  const originalListMembers = agentTeams.listMembers

  const first = fakeHost({ sessionController: service, agentTeams })
  apply(first.ctx, {})
  const wrappedList = service.list

  // A second load of the same plugin over the same host: the mark from the first load is reused, so the
  // exits are not wrapped a second time.
  const second = fakeHost({ sessionController: service, agentTeams })
  apply(second.ctx, {})
  assert.equal(service.list, wrappedList, 'the second load did not wrap the already-wrapped exit')
  assert.equal(agentTeams.listMembers.name, 'teamRosterFilteredList')

  first.unload()
  for (const [method, fn] of Object.entries(original)) {
    assert.equal(service[method], fn, `dispose restores ${method}`)
  }
  assert.equal(agentTeams.listMembers, originalListMembers, 'dispose restores the shipped roster read')
})

test('the shipped roster read drops a retired row and keeps the lead and every live member', () => {
  const rows = [
    { id: 'lead-1', name: 'lead', role: 'lead', status: 'running' },
    { id: 'gone', name: 'probe', role: 'teammate', status: 'inactive' },
    { id: 'keep', name: 'impl', role: 'teammate', status: 'inactive' },
  ]
  const service = { listMembers: () => rows }
  const original = service.listMembers
  const installed = installRosterFilter({ get: () => service }, { readRetiredNow: () => new Set(['gone']) })
  assert.equal(installed.installed, true)

  const answer = service.listMembers('agent')
  assert.ok(Array.isArray(answer), 'the wrapper stays synchronous: the shipped tool maps the array')
  assert.deepEqual(answer.map((row) => row.id), ['lead-1', 'keep'])
  assert.equal(answer[0], rows[0], 'the lead row is the host row, not a copy')

  installed.dispose()
  assert.equal(service.listMembers, original, 'dispose restores the shipped method')
  assert.equal(service.listMembers(), rows, 'and it serves every row again')
})

test('the shipped roster read is left alone when it is absent or has no shape to filter', () => {
  assert.equal(installRosterFilter({ get: () => undefined }).installed, false)
  const bare = { listMembers: () => [{ id: 'gone' }] }
  // No synchronous tombstone set yet: serve the rows rather than guess which one is retired.
  assert.equal(installRosterFilter({ get: () => bare }).installed, true)
  assert.deepEqual(bare.listMembers(), [{ id: 'gone' }])
  assert.equal(installRosterFilter({ get: () => ({ listMembers: 'not a method' }) }).installed, false)
})

test('a retirement and a restore each invalidate the tombstone set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-hook-install-'))
  const table = memoryTable()
  const planned = planMember({ leadSessionId: 'lead-1', members: [] }, 'reviewer', 'Check the diff')
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [planned] }))

  const calls = []
  const hooks = { filter: { invalidate: () => calls.push('invalidate') }, slots: { refresh: async () => {} } }
  const ctx = {
    agentTeams: { listMembers: () => [] },
    subagents: { listDescendants: async () => [], drainChildren: async () => {} },
    agents: { get: () => undefined },
    get: (name) => (name === 'sessionPersistence'
      ? { stat: async () => undefined }
      : undefined),
  }
  const retired = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: { session: { id: 'lead-1' } },
    dataDir: root,
    hooks,
    target: 'reviewer',
  })
  assert.equal(retired.retired, true)
  assert.deepEqual(calls, ['invalidate'], 'a retirement must not wait for the two-second cache')

  // The tombstone the retirement wrote records no artifact move, so the restore is a record write and
  // reaches the same invalidation.
  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    members: current.members.map((member) => ({ ...member, archived: false, trashPath: undefined })),
  }))
  const restored = await restoreMember({ ctx, table, leadSessionId: 'lead-1', target: 'reviewer', hooks })
  assert.equal(restored.restored, true)
  assert.deepEqual(calls, ['invalidate', 'invalidate'])
})
