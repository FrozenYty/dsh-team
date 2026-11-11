import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installProjectionFilter, installSlotCredit, stripRetiredMembers } from '../host-hooks.js'

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
