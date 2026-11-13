import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { handoffPrompt, handoffTemplate, messageMember, retireMember, restoreMember, spawnMember, stopMember } from '../actions.js'
import {
  ASSIGNMENT_MAX,
  HANDOFF_BRIEF_MAX,
  HANDOFF_TEMPLATE_MAX,
  LABEL_MAX,
  PHASE,
  ROSTER_SPEC,
  checkAssignment,
  findAnyTarget,
  planMember,
  readRoster,
  updateRoster,
} from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A context fake carrying what spawn, retire, message and stop read. `failStartFrom` makes the n-th
 * child start fail, so a failed start can be exercised without failing the first spawn.
 */
function fakeCtx({ failStartFrom = Number.POSITIVE_INFINITY } = {}) {
  const started = []
  const sent = []
  const drained = []
  let starts = 0
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (request) => {
        starts += 1
        if (starts >= failStartFrom) throw new Error('the capacity limit was reached')
        started.push(request)
        return { childId: request.childId }
      },
      drainChildren: async (caller, childIds) => { drained.push(...childIds) },
      sendMessage: async (caller, childId, messages) => {
        sent.push({ childId, text: messages[0]?.text })
        return 'message-1'
      },
      interrupt: () => {},
    },
    agents: { get: () => undefined },
    get: () => undefined,
    started,
    sent,
    drained,
  }
}

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

const firstReviewer = (ctx, table) => spawnMember(call(ctx, table, {
  name: 'reviewer',
  label: 'Check the diff',
  prompt: 'Start on the parser.',
  assignment: 'Finish the parser unit tests.',
}))

const memberNamed = (table, name, generation) => readRoster(table, 'lead-1').members
  .find((member) => member.name === name && member.generation === generation)

test('an assignment is stored on the record and capped', () => {
  assert.equal(checkAssignment('  keep the parser green  '), 'keep the parser green')
  assert.throws(() => checkAssignment(42), /must be a string/)
  assert.throws(() => checkAssignment('   '), /must not be empty/)
  assert.throws(
    () => checkAssignment('x'.repeat(ASSIGNMENT_MAX + 1), 'test'),
    new RegExp(`cap is ${ASSIGNMENT_MAX}`),
  )

  // The durable record refuses an assignment past the cap, so an old store cannot grow without limit.
  const record = {
    leadSessionId: 'lead-1',
    members: [{
      memberId: 'member-1',
      childId: 'child-1',
      name: 'reviewer',
      generation: 1,
      phase: PHASE.active,
      label: 'Check the diff',
      assignment: 'y'.repeat(ASSIGNMENT_MAX),
    }],
  }
  const parse = ROSTER_SPEC.tables.rosters.valueSchema.parse
  assert.equal(parse(record), record)
  record.members[0].assignment = 'y'.repeat(ASSIGNMENT_MAX + 1)
  assert.throws(() => parse(record), /exceeds/)
})

test('spawn_member stores the assignment and message_member replaces it', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'reviewer',
    label: 'Check the diff',
    prompt: 'Start on the parser.',
    assignment: 'Finish the parser unit tests.',
  }))
  assert.equal(born.assignment, 'Finish the parser unit tests.')
  assert.equal(memberNamed(table, 'reviewer', 1).assignment, 'Finish the parser unit tests.')

  const messaged = await messageMember(call(ctx, table, {
    target: 'reviewer',
    message: 'The parser is done; review the cache change next.',
    assignment: 'Review the cache change.',
  }))
  assert.equal(messaged.sent, true)
  assert.equal(messaged.assignment, 'Review the cache change.')
  assert.equal(memberNamed(table, 'reviewer', 1).assignment, 'Review the cache change.')

  await assert.rejects(
    () => messageMember(call(ctx, table, {
      target: 'reviewer',
      message: 'x',
      assignment: 'z'.repeat(ASSIGNMENT_MAX + 1),
    })),
    /cap is 1000/,
  )
  assert.equal(memberNamed(table, 'reviewer', 1).assignment, 'Review the cache change.', 'a refused update changes nothing')
})

test('the handoff prompt carries what the predecessor was doing and that it is gone', () => {
  const prompt = handoffPrompt({
    successor: 'reviewer-g2',
    predecessor: {
      name: 'reviewer',
      generation: 1,
      label: 'Check the diff',
      assignment: 'Finish the parser unit tests.',
    },
    prompt: 'Continue with the cache change.',
  })
  assert.match(prompt, /You are reviewer-g2, the successor of reviewer/)
  assert.match(prompt, /has been retired and is gone/)
  assert.match(prompt, /Check the diff/)
  assert.match(prompt, /Finish the parser unit tests\./)
  assert.match(prompt, /this Lead's own task board under the name "reviewer"/)
  assert.match(prompt, /read it with list_my_tasks/)
  assert.match(prompt, /Continue with the cache change\./)
  assert.ok(prompt.length < 800, 'the brief stays short enough for a cold child')
  assert.equal(prompt.split('\n').length, 5, 'five lines, not a wall of prose')
})

test('a predecessor without an assignment still yields a usable brief', () => {
  const prompt = handoffPrompt({
    successor: 'probe-g2',
    predecessor: { name: 'probe', generation: 1, label: 'Audit the theme tokens' },
    prompt: 'Take over.',
  })
  assert.match(prompt, /Its role was: Audit the theme tokens\./)
  assert.match(prompt, /not recorded; take it from this Lead's task board with list_my_tasks/)
})

test('a Lead with no stored template gets the built-in brief byte for byte', () => {
  const prompt = handoffPrompt({
    successor: 'reviewer-g2',
    predecessor: {
      name: 'reviewer',
      generation: 1,
      label: 'Check the diff',
      assignment: 'Finish the parser unit tests.',
    },
    prompt: 'Continue with the cache change.',
  })
  assert.equal(prompt, [
    'You are reviewer-g2, the successor of reviewer. reviewer has been retired and is gone; it cannot be messaged.',
    'Its role was: Check the diff.',
    'What it was doing: Finish the parser unit tests.',
    'Its unfinished work is still on this Lead\'s own task board under the name "reviewer"; read it with list_my_tasks and take those tasks over instead of redoing finished work',
    'Your task: Continue with the cache change.',
  ].join('\n'))

  // The same shape when nothing was recorded: the fallback sentence is part of the built-in brief.
  const bare = handoffPrompt({
    successor: 'probe-g2',
    predecessor: { name: 'probe', generation: 1, label: 'Audit the theme tokens' },
    prompt: 'Take over.',
  })
  assert.equal(bare, [
    'You are probe-g2, the successor of probe. probe has been retired and is gone; it cannot be messaged.',
    'Its role was: Audit the theme tokens.',
    'What it was doing: not recorded; take it from this Lead\'s task board with list_my_tasks',
    'Its unfinished work is still on this Lead\'s own task board under the name "probe"; read it with list_my_tasks and take those tasks over instead of redoing finished work',
    'Your task: Take over.',
  ].join('\n'))
})

test('the template is read back, and a bad stored value is reported instead of dropped', async () => {
  const table = memoryTable()
  const written = 'You are {successor}, taking over from {predecessor}. {assignment}'
  const set = await handoffTemplate({ table, leadSessionId: 'lead-1', template: written })
  assert.equal(set.stored, true)
  assert.equal(set.valid, true)
  assert.equal(set.template, written)
  assert.deepEqual(JSON.parse(JSON.stringify(set)), set, 'the result stays lossless JSON')

  const read = await handoffTemplate({ table, leadSessionId: 'lead-1' })
  assert.equal(read.template, set.template, 'the get form reads back exactly what was set')
  assert.equal(read.stored, true)
  assert.equal(read.valid, true)
  assert.deepEqual(JSON.parse(JSON.stringify(read)), read)

  // A value that got past the set path — hand-edited, or written by a release with other rules — is
  // reported by the read and left on the record rather than thrown away.
  await updateRoster(table, 'lead-1', (current) => ({ ...current, handoffTemplate: 'a brief with {asignment}' }))
  const broken = await handoffTemplate({ table, leadSessionId: 'lead-1' })
  assert.equal(broken.stored, true)
  assert.equal(broken.valid, false)
  assert.match(broken.problem, /\{asignment\}/)
  assert.equal(readRoster(table, 'lead-1').handoffTemplate, 'a brief with {asignment}', 'it is kept, not silently cleared')

  // ... and the composition falls back to the built-in instead of writing the token into a child.
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe', prompt: 'Start.', assignment: 'Watch the cache.' }))
  await spawnMember(call(ctx, table, { replace: 'probe', label: 'Probe', prompt: 'Continue.' }))
  const text = ctx.started.at(-1).request.prompt[0].text
  assert.match(text, /^You are probe-g2, the successor of probe\./)
  assert.ok(!text.includes('{'), 'no placeholder or stray brace reaches the child')
})

test('two Leads do not share a handoff template', async () => {
  const table = memoryTable()
  const stored = 'Take over from {predecessor} as {successor}: {assignment}'
  await handoffTemplate({ table, leadSessionId: 'lead-1', template: stored })
  await handoffTemplate({ table, leadSessionId: 'lead-2', template: 'Lead two: {assignment}' })

  assert.equal((await handoffTemplate({ table, leadSessionId: 'lead-2' })).template, 'Lead two: {assignment}')
  await handoffTemplate({ table, leadSessionId: 'lead-1', template: '' })
  assert.equal((await handoffTemplate({ table, leadSessionId: 'lead-1' })).stored, false)
  assert.equal((await handoffTemplate({ table, leadSessionId: 'lead-2' })).template, 'Lead two: {assignment}')
  assert.equal(readRoster(table, 'lead-2').handoffTemplate, 'Lead two: {assignment}')
})

test('an unknown placeholder is refused at set time and names the token', async () => {
  const table = memoryTable()
  await assert.rejects(
    () => handoffTemplate({ table, leadSessionId: 'lead-1', template: 'What it was doing: {asignment}' }),
    (error) => /handoff_template/.test(error.message) && /\{asignment\}/.test(error.message),
  )
  // An unbalanced brace is the other half of the same typo class: it would be literal text too.
  await assert.rejects(
    () => handoffTemplate({ table, leadSessionId: 'lead-1', template: 'Work: {assignment' }),
    /not part of one of/,
  )
  assert.equal(readRoster(table, 'lead-1').handoffTemplate, undefined, 'a refused template is not stored')
})

test('a template that does not reference the assignment is refused, with the reason', async () => {
  const table = memoryTable()
  await assert.rejects(
    () => handoffTemplate({ table, leadSessionId: 'lead-1', template: 'You are {successor}. Do your best.' }),
    /must reference \{assignment\}/,
  )
  assert.equal(readRoster(table, 'lead-1').handoffTemplate, undefined)
})

test('the template cap refuses rather than truncating', async () => {
  const table = memoryTable()
  const oversized = `{assignment} ${'x'.repeat(HANDOFF_TEMPLATE_MAX)}`
  await assert.rejects(
    () => handoffTemplate({ table, leadSessionId: 'lead-1', template: oversized }),
    new RegExp(`cap is ${HANDOFF_TEMPLATE_MAX}`),
  )
  assert.equal(readRoster(table, 'lead-1').handoffTemplate, undefined)
  // The boundary itself is accepted.
  const bounded = `{assignment} ${'x'.repeat(HANDOFF_TEMPLATE_MAX - 13)}`
  assert.equal(bounded.length, HANDOFF_TEMPLATE_MAX)
  assert.equal((await handoffTemplate({ table, leadSessionId: 'lead-1', template: bounded })).stored, true)
})

test('a template that renders past the brief cap refuses the replacement before anything starts', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const template = `{assignment} ${'x'.repeat(900)} {label}`
  await handoffTemplate({ table, leadSessionId: 'lead-1', template })
  await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'L'.repeat(LABEL_MAX),
    prompt: 'Start.',
    assignment: 'a'.repeat(ASSIGNMENT_MAX),
  }))
  const startedBefore = ctx.started.length

  await assert.rejects(
    () => spawnMember(call(ctx, table, { replace: 'probe', label: 'Next', prompt: 'Continue.' })),
    new RegExp(`cap is ${HANDOFF_BRIEF_MAX}`),
  )
  assert.equal(ctx.started.length, startedBefore, 'the refusal happens before any child is started')
  assert.equal(memberNamed(table, 'probe', 1).phase, PHASE.active, 'the predecessor is untouched')
  assert.equal(memberNamed(table, 'probe', 2), undefined, 'no failed reservation was written')
})

test('a stored template is interpolated with the real values when a successor starts', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await handoffTemplate({ table, leadSessionId: 'lead-1', template: [
    'Handoff: {predecessor} -> {successor}.',
    'Its role was: {label}.',
    'Inherited work: {assignment}',
    'Board: {task_board}',
    'Do not redo finished work.',
  ].join('\n') })

  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue.' }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.predecessor_retired, true)
  const text = ctx.started.at(-1).request.prompt[0].text
  assert.match(text, /^Handoff: reviewer -> reviewer-g2\./)
  assert.match(text, /Its role was: Check the diff\./)
  assert.match(text, /Inherited work: Finish the parser unit tests\./)
  assert.match(text, /Board: this Lead's own task board under the name "reviewer"/)
  assert.match(text, /Do not redo finished work\.\nYour task: Continue\.$/)
  assert.ok(!text.includes('{'), 'every placeholder is replaced before it reaches the child')
})

test('clearing the template returns that Lead to the built-in brief', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await handoffTemplate({ table, leadSessionId: 'lead-1', template: 'One line: {assignment}' })
  const cleared = await handoffTemplate({ table, leadSessionId: 'lead-1', template: '   ' })
  assert.equal(cleared.stored, false)
  assert.equal(cleared.template, '')
  assert.equal(readRoster(table, 'lead-1').handoffTemplate, undefined)

  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue the parser work.' }))
  assert.equal(ctx.started.at(-1).request.prompt[0].text, [
    'You are reviewer-g2, the successor of reviewer. reviewer has been retired and is gone; it cannot be messaged.',
    'Its role was: Check the diff.',
    'What it was doing: Finish the parser unit tests.',
    'Its unfinished work is still on this Lead\'s own task board under the name "reviewer"; read it with list_my_tasks and take those tasks over instead of redoing finished work',
    'Your task: Continue the parser work.',
  ].join('\n'), 'clearing returns byte-identical built-in briefs')
})

test('a stored template must be a string for the record to load', () => {
  const parse = ROSTER_SPEC.tables.rosters.valueSchema.parse
  const record = { leadSessionId: 'lead-1', members: [], handoffTemplate: 'You are {successor}: {assignment}' }
  assert.equal(parse(record), record)
  record.handoffTemplate = 42
  assert.throws(() => parse(record), /handoffTemplate must be a string/)
})

test('one spawn_member call retires the predecessor and starts its successor', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)

  const replaced = await spawnMember(call(ctx, table, {
    replace: 'reviewer',
    label: 'Check the diff',
    prompt: 'Continue the parser work.',
  }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.generation, 2)
  assert.equal(replaced.phase, PHASE.active)
  assert.equal(replaced.replaced, 'reviewer')
  assert.equal(replaced.predecessor_retired, true)
  assert.match(replaced.message, /handoff brief/)
  assert.deepEqual(JSON.parse(JSON.stringify(replaced)), replaced, 'the result stays lossless JSON')

  const predecessor = memberNamed(table, 'reviewer', 1)
  const successor = memberNamed(table, 'reviewer', 2)
  assert.equal(predecessor.phase, PHASE.retired, 'the predecessor is retired in the same call')
  assert.equal(predecessor.assignment, 'Finish the parser unit tests.', 'the tombstone keeps the assignment')
  assert.equal(successor.phase, PHASE.active)
  assert.equal(successor.predecessor, predecessor.memberId, 'the successor records what it replaced')
  assert.equal(successor.assignment, 'Finish the parser unit tests.', 'the work is inherited unless re-recorded')

  // The child was started from the brief, not from the predecessor's transcript.
  const text = ctx.started.at(-1).request.prompt[0].text
  assert.match(text, /You are reviewer-g2, the successor of reviewer/)
  assert.match(text, /Finish the parser unit tests\./)
  assert.match(text, /Continue the parser work\./)
})

test('a replacement keeps the name generation unless the model names it', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue.' }))
  const third = await spawnMember(call(ctx, table, { replace: 'reviewer-g2', label: 'Check the diff', prompt: 'Continue again.' }))
  assert.equal(third.target, 'reviewer-g3')

  const named = await spawnMember(call(ctx, table, {
    replace: 'reviewer-g3',
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start the probe.',
  }))
  assert.equal(named.target, 'probe')
  assert.equal(named.generation, 1, 'an explicitly named successor starts its own generation')
  assert.equal(memberNamed(table, 'reviewer', 3).phase, PHASE.retired)
})

test('a retirement that fails after the successor started is reported as that half', async () => {
  const table = memoryTable({ failRetirement: true })
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)

  const replaced = await spawnMember(call(ctx, table, {
    replace: 'reviewer',
    label: 'Check the diff',
    prompt: 'Continue.',
  }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.phase, PHASE.active)
  assert.equal(replaced.predecessor_retired, false, 'the half that did not happen is reported')
  assert.match(replaced.message, /could NOT be retired/)
  assert.match(replaced.message, /still live/)
  assert.equal(memberNamed(table, 'reviewer', 1).phase, PHASE.active, 'the predecessor was left live')
  assert.equal(memberNamed(table, 'reviewer', 2).phase, PHASE.active)
})

test('a successor that cannot start leaves the predecessor untouched and says so', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({ failStartFrom: 2 })
  await firstReviewer(ctx, table)

  await assert.rejects(
    () => spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Continue.' })),
    /was NOT retired and is still live/,
  )
  assert.equal(memberNamed(table, 'reviewer', 1).phase, PHASE.active, 'the predecessor is untouched')
  assert.equal(memberNamed(table, 'reviewer', 2).phase, PHASE.failed, 'the failed reservation is visible')
})

test('a retired predecessor can still be replaced from its tombstone', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  const retirement = await retireMember(call(ctx, table, { target: 'reviewer', reason: 'Moving on' }))
  assert.equal(retirement.retired, true)

  const replaced = await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Check the diff', prompt: 'Take over.' }))
  assert.equal(replaced.target, 'reviewer-g2')
  assert.equal(replaced.predecessor_retired, true)
  assert.match(replaced.message, /already retired/)
  assert.equal(memberNamed(table, 'reviewer', 2).assignment, 'Finish the parser unit tests.')
  assert.match(ctx.started.at(-1).request.prompt[0].text, /Finish the parser unit tests\./)
})

test('retiring an already-retired member is the matrix no-op with a typed reason', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  const first = await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(first.retired, true)

  const again = await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(again.retired, true)
  assert.equal(again.drained, false)
  assert.equal(again.reason, 'already-retired')
  assert.deepEqual(JSON.parse(JSON.stringify(again)), again, 'the no-op result stays lossless JSON')

  // The tombstone is untouched — no second drain, no second move.
  const record = memberNamed(table, 'reviewer', 1)
  assert.equal(record.phase, PHASE.retired)
  assert.equal(record.trashState, 'none')
  assert.equal(readRoster(table, 'lead-1').members.length, 1)
})

test('retiring a genuinely unknown target still refuses', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await assert.rejects(
    () => retireMember(call(ctx, table, { target: 'ghost' })),
    /no member named "ghost"/,
  )
  await assert.rejects(
    () => restoreMember(call(ctx, table, { target: 'ghost' })),
    /no member named "ghost"/,
  )
})

test('restoring an active member is the matrix no-op with a typed reason', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await retireMember(call(ctx, table, { target: 'reviewer' }))
  const first = await restoreMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(first.restored, true)

  const again = await restoreMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(again.restored, true)
  assert.equal(again.reason, 'already-active')
  assert.equal(memberNamed(table, 'reviewer', 1).phase, PHASE.active)
})

test('a message to a retired, failed or unknown target is a typed refusal', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await retireMember(call(ctx, table, { target: 'reviewer' }))

  const retired = await messageMember(call(ctx, table, { target: 'reviewer', message: 'are you there?' }))
  assert.equal(retired.sent, false)
  assert.equal(retired.reason, 'retired')

  await updateRoster(table, 'lead-1', (current) => ({
    ...current,
    members: current.members.map((member) => ({ ...member, phase: PHASE.failed })),
  }))
  const failed = await messageMember(call(ctx, table, { target: 'reviewer', message: 'x' }))
  assert.equal(failed.sent, false)
  assert.equal(failed.reason, 'failed')

  const missing = await messageMember(call(ctx, table, { target: 'ghost', message: 'x' }))
  assert.equal(missing.sent, false)
  assert.equal(missing.reason, 'missing')
  assert.notEqual(missing.message, retired.message, 'a tombstone and a never-existed target are different answers')
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), missing)

  const stopped = await stopMember(call(ctx, table, { target: 'ghost' }))
  assert.equal(stopped.stopped, false)
  assert.equal(stopped.reason, 'missing')
  assert.equal(ctx.sent.length, 0, 'a refused delivery never reaches the subagent service')
})

test('a stop on a retired target is a typed refusal', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await retireMember(call(ctx, table, { target: 'reviewer' }))
  const stopped = await stopMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(stopped.stopped, false)
  assert.equal(stopped.reason, 'retired')
})

test('a failed member can still be retired: it is the cleanup operation', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({ failStartFrom: 2 })
  await firstReviewer(ctx, table)
  await assert.rejects(
    () => spawnMember(call(ctx, table, { name: 'probe', label: 'Probe', prompt: 'x' })),
    /capacity limit/,
  )
  const refused = await messageMember(call(ctx, table, { target: 'probe', message: 'x' }))
  assert.equal(refused.sent, false)
  assert.equal(refused.reason, 'failed')
  const retired = await retireMember(call(ctx, table, { target: 'probe' }))
  assert.equal(retired.retired, true)
  assert.equal(memberNamed(table, 'probe', 1).phase, PHASE.retired)
})

test('the tombstone is written before the workspace-archive branch runs', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  let phaseDuringArchive
  ctx.get = (name) => (name === 'workspaceRegistry'
    ? {
      archiveSession: async () => {
        phaseDuringArchive = readRoster(table, 'lead-1').members[0]?.phase
      },
    }
    : undefined)
  await firstReviewer(ctx, table)

  const retired = await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(retired.archived, true)
  assert.equal(retired.trashed, false)
  assert.equal(phaseDuringArchive, PHASE.retired, 'the record is already a tombstone when the archive runs')
})

test('a retirement records archived only for the branch that ran, never beside a trash path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-retire-'))
  const memberDir = join(root, 'sessions', 'artifact')
  await mkdir(memberDir, { recursive: true })
  await writeFile(join(memberDir, 'session.jsonl'), 'log')
  const ctx = fakeCtx()
  ctx.get = (name) => (name === 'sessionPersistence' ? { stat: async () => ({ location: { path: memberDir } }) } : undefined)
  const table = memoryTable()
  await firstReviewer(ctx, table)

  const retired = await retireMember(call(ctx, table, { target: 'reviewer', dataDir: join(root, 'data') }))
  assert.equal(retired.trashed, true)
  assert.equal(retired.archived, false)
  const record = memberNamed(table, 'reviewer', 1)
  assert.equal(record.trashPath, undefined, 'the tombstone carries no absolute path')
  assert.equal(typeof record.trashRelPath, 'string', 'it carries a path relative to the data root')
  assert.equal(record.trashState, 'done')
  assert.equal(record.archived, false, 'archived means the archive ran, and here a move did')

  const restored = await restoreMember(call(ctx, table, { target: 'reviewer', dataDir: join(root, 'data') }))
  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'moved-back')
  assert.equal(memberNamed(table, 'reviewer', 1).phase, PHASE.active)
})

test('a pending tombstone whose move never happened is reactivated, not refused', async () => {
  // The crash window the tombstone-first ordering creates: the tombstone is committed, the artifact
  // never reached the trash, and the process is gone. Its original path still holds the session.
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-crash-'))
  const original = join(root, 'sessions', 'artifact')
  await mkdir(original, { recursive: true })
  const planned = planMember({ leadSessionId: 'lead-1', members: [] }, 'reviewer', 'Check the diff')
  const table = memoryTable()
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [{
      ...planned,
      phase: PHASE.retired,
      archived: false,
      trashState: 'pending',
      trashPath: join(root, 'trash', 'lead-1', 'artifact-1'),
      trashKind: 'directory',
      originalPath: original,
    }],
  }))

  let unarchived = 0
  const ctx = fakeCtx()
  ctx.get = (name) => (name === 'workspaceRegistry' ? { unarchiveSession: async () => { unarchived += 1 } } : undefined)
  const restored = await restoreMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'never-moved')
  assert.equal(unarchived, 0)
  assert.equal(memberNamed(table, 'reviewer', 1).phase, PHASE.active)
})

test('restoring a tombstone that archived nothing does not call the workspace', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  const retired = await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(retired.archived, false, 'no persistence and no workspace: neither branch ran')

  let unarchived = 0
  const withWorkspace = {
    ...ctx,
    get: () => ({ unarchiveSession: async () => { unarchived += 1 } }),
  }
  const restored = await restoreMember(call(withWorkspace, table, { target: 'reviewer' }))
  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'not-archived', 'it names the branch that ran instead of claiming an unarchive')
  assert.equal(unarchived, 0, 'the workspace is never asked to unhide a session it never hid')
})

test('a retirement that lands while the spawn is in flight keeps the tombstone and drains the child', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  ctx.subagents.startActivation = async (request) => {
    // A concurrent retirement commits while this spawn is suspended inside startActivation.
    await updateRoster(table, 'lead-1', (current) => ({
      ...current,
      members: current.members.map((member) => (member.name === 'probe'
        ? { ...member, phase: PHASE.retired, archived: false, trashState: 'none' }
        : member)),
    }))
    return { childId: request.childId }
  }

  const born = await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe the cache', prompt: 'Start.' }))
  assert.equal(born.phase, PHASE.retired, 'the tombstone wins over the activation that published later')
  const record = memberNamed(table, 'probe', 1)
  assert.equal(record.phase, PHASE.retired)
  assert.deepEqual(ctx.drained, [record.childId], 'the child that published was drained when it published')
})

test('a retirement that archived nothing is still a tombstone the live lookup ignores', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await firstReviewer(ctx, table)
  await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(findAnyTarget(readRoster(table, 'lead-1'), 'reviewer').phase, PHASE.retired)
})
