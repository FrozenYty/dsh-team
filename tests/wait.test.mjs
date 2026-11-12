import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WAIT_TIMEOUT_DEFAULT, spawnMember, waitMembers } from '../actions.js'
import { readRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * The fakes a wait needs: a roster, a live registry that can flip one child, and an event bus the test
 * drives by hand. `agent/status` is the only event the operation subscribes to, so the bus records
 * listeners per event name exactly as the Host's dispatch would deliver them.
 */
function fakeCtx() {
  const listeners = new Map()
  const running = new Set()
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (request) => ({ childId: request.childId }),
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
    },
    agents: { get: (id) => (running.has(id) ? { id, status: 'running' } : undefined) },
    get: () => undefined,
    running,
    on(name, handler) {
      const handlers = listeners.get(name) ?? []
      handlers.push(handler)
      listeners.set(name, handlers)
      return () => {
        const at = handlers.indexOf(handler)
        if (at !== -1) handlers.splice(at, 1)
      }
    },
    emit(name, payload) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(payload)
    },
    listenerCount: (name) => (listeners.get(name) ?? []).length,
  }
}

const lead = { session: { id: 'lead-1' } }
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })
const call = (ctx, table, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: '/tmp/dsh-team-test',
  hooks: hooks(),
  ...extra,
})

/** A member on the roster whose child Session exists but is not reported `running`. */
async function memberAtRest(ctx, table, { name = 'reviewer' } = {}) {
  await spawnMember(call(ctx, table, { name, label: 'Check the diff', prompt: 'Start.' }))
  return readRoster(table, 'lead-1').members.find((member) => member.name === name)
}

/**
 * Wait until the operation has subscribed. The call adopts before it waits, so the listener appears a
 * few microtasks after it starts; this keeps the test from excepting a fixed tick count.
 */
async function untilListening(ctx) {
  for (let tick = 0; tick < 200 && ctx.listenerCount('agent/status') === 0; tick += 1) await Promise.resolve()
  assert.equal(ctx.listenerCount('agent/status'), 1, 'the wait subscribed to agent/status')
}

test('a member status change ends the wait, reports it, and removes the listener', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const member = await memberAtRest(ctx, table)
  ctx.running.add(member.childId)

  const pending = waitMembers(call(ctx, table, { timeoutMs: 5000 }))
  await untilListening(ctx)
  ctx.running.delete(member.childId)
  ctx.emit('agent/status', { agent: { id: member.childId }, status: 'idle' })
  const result = await pending

  assert.equal(result.timed_out, false)
  assert.equal(result.target, 'reviewer')
  assert.equal(result.status, 'idle')
  assert.equal(result.no_progress, undefined)
  assert.ok(Number.isInteger(result.waited_ms))
  assert.match(result.message, /reviewer/)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the result stays lossless JSON')
  assert.equal(ctx.listenerCount('agent/status'), 0, 'a finished wait leaves no listener behind')
})

test('a transition of an agent outside the roster does not wake the wait, which times out', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const member = await memberAtRest(ctx, table)
  ctx.running.add(member.childId)

  const pending = waitMembers(call(ctx, table, { timeoutMs: 25 }))
  await untilListening(ctx)
  // The Lead is not a member, and neither is an unrelated agent: both are ignored.
  ctx.emit('agent/status', { agent: { id: 'lead-1' }, status: 'idle' })
  ctx.emit('agent/status', { agent: { id: 'someone-else' }, status: 'idle' })
  const result = await pending

  assert.equal(result.timed_out, true)
  assert.equal(result.target, undefined)
  assert.equal(result.status, undefined)
  assert.ok(result.waited_ms >= 20, `the wait lasted the timeout, saw ${result.waited_ms} ms`)
  assert.equal(ctx.listenerCount('agent/status'), 0)
})

test('with nothing running or provisioning the wait answers no_progress instead of blocking', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await memberAtRest(ctx, table)

  const startedAt = Date.now()
  const result = await waitMembers(call(ctx, table, { timeoutMs: 60_000 }))

  assert.equal(result.no_progress, true)
  assert.equal(result.timed_out, false)
  assert.equal(result.target, undefined)
  assert.ok(Date.now() - startedAt < 1000, 'it returned rather than waiting out the timeout')
  assert.equal(ctx.listenerCount('agent/status'), 0, 'an impossible wait installs no listener')
})

test('a cancelled wait rejects instead of pretending it timed out', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const member = await memberAtRest(ctx, table)
  ctx.running.add(member.childId)

  const controller = new AbortController()
  const pending = waitMembers(call(ctx, table, { timeoutMs: 60_000, signal: controller.signal }))
  await untilListening(ctx)
  controller.abort(new Error('cancelled by the caller'))

  await assert.rejects(pending, /cancelled by the caller/)
  assert.equal(ctx.listenerCount('agent/status'), 0)
})

test('the documented default is a bounded thirty seconds', () => {
  assert.equal(WAIT_TIMEOUT_DEFAULT, 30_000)
})
