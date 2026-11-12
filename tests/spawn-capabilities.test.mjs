import assert from 'node:assert/strict'
import { test } from 'node:test'

import { messageMember, restoreMember, retireMember, spawnMember, stopMember } from '../actions.js'
import { PHASE, readRoster, updateRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A context fake that records every activation request, and can fail one the way the Harness fails a
 * start: `failStart(request)` returns the error to throw, or undefined to let the start through.
 */
function fakeCtx({ failStart } = {}) {
  const requests = []
  return {
    agentTeams: { listMembers: () => [] },
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
    },
    agents: { get: () => undefined },
    get: () => undefined,
    requests,
  }
}

/** A seam failure: `code` is the machine-routable class the plugin routes on. */
const hostError = (code, message, details) => Object.assign(
  new Error(message),
  { code, ...details === undefined ? {} : { details } },
)

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

/** Spawn one member with the defaults the other spawn assertions share. */
const spawn = (ctx, table, extra = {}) => spawnMember(call(ctx, table, {
  name: 'probe',
  label: 'Probe the cache',
  prompt: 'Start.',
  ...extra,
}))

const members = (table) => readRoster(table, 'lead-1').members

test('a spawn with no spawn_options produces exactly the request it produced before', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawn(ctx, table)

  assert.deepEqual(ctx.requests, [{ prompt: [{ type: 'text', text: 'Start.' }], parent: lead }])
  assert.deepEqual(Object.keys(ctx.requests[0]).sort(), ['parent', 'prompt'], 'no extra request field is added')
  assert.equal(Object.hasOwn(born, 'started_with'), false, 'nothing was applied, so nothing extra is reported')
  assert.equal(Object.hasOwn(born, 'started'), false)
  assert.equal(Object.hasOwn(born, 'reason'), false)
})

test('each spawn option is forwarded to the activation request and reported back', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawn(ctx, table, {
    cwd: '../elsewhere',
    agentOptions: { provider: 'other', model: 'cheap-model', reasoning_effort: 'low', max_tokens: 2048 },
    agentPreset: 'reader',
  })

  assert.deepEqual(ctx.requests[0], {
    prompt: [{ type: 'text', text: 'Start.' }],
    parent: lead,
    cwd: '../elsewhere',
    agentOptions: { provider: 'other', model: 'cheap-model', reasoningEffort: 'low', maxTokens: 2048 },
    agentPreset: 'reader',
  })
  assert.equal(ctx.requests[0].cwd, '../elsewhere', 'cwd is forwarded as a path, unresolved and unnormalised')
  assert.deepEqual(born.started_with, {
    cwd: '../elsewhere',
    agent_options: { provider: 'other', model: 'cheap-model', reasoning_effort: 'low', max_tokens: 2048 },
    agent_preset: 'reader',
  }, 'the result reports what the member started with')
  assert.deepEqual(JSON.parse(JSON.stringify(born)), born, 'the result stays lossless JSON')
})

test('an option supplied alone is forwarded alone and reported alone', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawn(ctx, table, { agentPreset: 'reader' })

  assert.deepEqual(Object.keys(ctx.requests[0]).sort(), ['agentPreset', 'parent', 'prompt'])
  assert.deepEqual(born.started_with, { agent_preset: 'reader' })
})

test('a Harness capability refusal becomes a typed refusal and leaves no half-registered member', async () => {
  const cases = [
    [
      hostError('UNSUPPORTED_CAPABILITY', 'subagent provider "spawn" does not support the "agentOptions" capability'),
      'unsupported-capability',
      /without agent_options and agent_preset/,
    ],
    [
      hostError('PRESET_UNAVAILABLE', 'selecting a child agent preset requires the agent-presets service'),
      'preset-unavailable',
      /without agent_preset/,
    ],
    [
      hostError('agent-preset/not-found', 'Unknown agent preset: ghost', { agentPreset: 'ghost', available: ['reader', 'writer'] }),
      'preset-not-found',
      /"reader", "writer"/,
    ],
    [
      hostError('UNAUTHORIZED', 'subagent creation requires the exact live parent agent'),
      'unauthorized',
      /retry/,
    ],
  ]
  for (const [error, reason, sentence] of cases) {
    const table = memoryTable()
    const ctx = fakeCtx({ failStart: () => error })
    const refused = await spawn(ctx, table, { agentOptions: { model: 'cheap-model' }, agentPreset: 'ghost' })

    assert.equal(refused.started, false, `${reason}: the result says no child started`)
    assert.equal(refused.reason, reason)
    assert.match(refused.message, sentence, `${reason}: the sentence names the way out`)
    assert.equal(refused.phase, PHASE.failed)
    assert.equal(members(table).length, 1)
    assert.equal(members(table)[0].phase, PHASE.failed, 'the failed reservation is visible, never a phantom')
    assert.deepEqual(JSON.parse(JSON.stringify(refused)), refused, 'the refusal stays lossless JSON')
    assert.equal(ctx.requests.length, 1, 'the start was attempted exactly once')
  }
})

test('a start failure the Harness does not type still throws, as it did before', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({ failStart: () => new Error('the capacity limit was reached') })
  await assert.rejects(() => spawn(ctx, table), /capacity limit/)
  assert.equal(members(table)[0].phase, PHASE.failed)
})

test('a refused successor start leaves the predecessor live and says so', async () => {
  const table = memoryTable()
  let refuse = false
  const ctx = fakeCtx({
    failStart: () => (refuse
      ? hostError('UNSUPPORTED_CAPABILITY', 'subagent provider "spawn" does not support the "agentPreset" capability')
      : undefined),
  })
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start.' }))
  refuse = true

  const refused = await spawnMember(call(ctx, table, {
    replace: 'reviewer',
    label: 'Check the diff',
    prompt: 'Continue.',
    agentPreset: 'ghost',
  }))
  assert.equal(refused.started, false)
  assert.equal(refused.reason, 'unsupported-capability')
  assert.equal(refused.replaced, 'reviewer')
  assert.equal(refused.predecessor_retired, false)
  assert.match(refused.message, /NOT retired and is still live/)
  assert.equal(members(table).find((member) => member.generation === 1).phase, PHASE.active)
  assert.equal(members(table).find((member) => member.generation === 2).phase, PHASE.failed)
})

test('a refusal for a stale target names the member that now holds the name', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start.' }))
  await retireMember(call(ctx, table, { target: 'reviewer' }))
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start again.' }))

  const messaged = await messageMember(call(ctx, table, { target: 'reviewer', message: 'are you there?' }))
  assert.equal(messaged.sent, false)
  assert.equal(messaged.reason, 'retired', 'which refusal happens does not change')
  assert.deepEqual(messaged.current_holder, { target: 'reviewer-g2', generation: 2 })
  assert.match(messaged.message, /reviewer-g2/, 'the sentence says where the name went')
  assert.deepEqual(JSON.parse(JSON.stringify(messaged)), messaged, 'the refusal stays lossless JSON')

  const stopped = await stopMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(stopped.reason, 'retired')
  assert.deepEqual(stopped.current_holder, { target: 'reviewer-g2', generation: 2 })

  const retired = await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(retired.reason, 'already-retired')
  assert.deepEqual(retired.current_holder, { target: 'reviewer-g2', generation: 2 })
  assert.match(retired.message, /retarget/)
})

test('the holder is only reported while another generation of the name is live', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawn(ctx, table)
  await retireMember(call(ctx, table, { target: 'probe' }))

  const alone = await messageMember(call(ctx, table, { target: 'probe', message: 'x' }))
  assert.equal(alone.reason, 'retired')
  assert.equal(Object.hasOwn(alone, 'current_holder'), false, 'no successor, so the refusal is what it always was')

  // A second generation that has itself retired holds nothing: only a live member can be retargeted to.
  await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe', prompt: 'Again.' }))
  await retireMember(call(ctx, table, { target: 'probe-g2' }))
  const neither = await messageMember(call(ctx, table, { target: 'probe', message: 'x' }))
  assert.equal(neither.reason, 'retired')
  assert.equal(Object.hasOwn(neither, 'current_holder'), false)

  const missing = await messageMember(call(ctx, table, { target: 'ghost', message: 'x' }))
  assert.equal(missing.reason, 'missing')
  assert.equal(Object.hasOwn(missing, 'current_holder'), false)
})

test('a restore refusal names the holder the same way', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe', prompt: 'Start.' }))
  await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe', prompt: 'More.' }))
  // Generation 1 is a failed reservation while generation 2 is live: restore has nothing to restore.
  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    members: current.members.map((member) => (member.generation === 1 ? { ...member, phase: PHASE.failed } : member)),
  }))

  const notRetired = await restoreMember(call(ctx, table, { target: 'probe' }))
  assert.equal(notRetired.restored, false)
  assert.equal(notRetired.reason, 'not-retired')
  assert.deepEqual(notRetired.current_holder, { target: 'probe-g2', generation: 2 })

  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    members: current.members.map((member) => (member.generation === 1
      ? { ...member, phase: PHASE.retired, trashState: 'pruned', trashPath: '/tmp/gone', archived: false }
      : member)),
  }))
  const pruned = await restoreMember(call(ctx, table, { target: 'probe' }))
  assert.equal(pruned.reason, 'pruned')
  assert.deepEqual(pruned.current_holder, { target: 'probe-g2', generation: 2 })
})
