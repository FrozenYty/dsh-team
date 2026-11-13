import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listMembers, messageMember, retireMember, spawnMember, taskBoard } from '../actions.js'
import { LIFETIME, PHASE, declaredLifetime, lifetimeOf, parseRoster, planMember, readRoster, updateRoster } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

/**
 * A context fake with a mutable live registry. A spawned child is resident until `ctx.finish(childId)`
 * says its turn ended and the Harness unloaded it — which is exactly the observation the lazy sweep is
 * allowed to act on. The registry is the local `ctx.agents.get`, not the subagent registry: the latter
 * reports `activity: 'inactive'` for a child that never started as well (ADR 0013).
 */
function fakeCtx() {
  const liveIds = new Set()
  const started = []
  const drained = []
  const sent = []
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (request) => {
        started.push(request)
        liveIds.add(request.childId)
        return { childId: request.childId }
      },
      drainChildren: async (caller, childIds) => { drained.push(...childIds) },
      sendMessage: async (caller, childId, messages) => {
        sent.push({ childId, text: messages[0]?.text })
        // A message wakes an unloaded continuable child, so the delivery itself makes it resident.
        liveIds.add(childId)
        return 'message-1'
      },
      interrupt: () => {},
    },
    agents: { get: (id) => (liveIds.has(id) ? { id, status: 'running' } : undefined) },
    get: () => undefined,
    /** The child's turn ended and the Harness unloaded it: the only "stopped" evidence the sweep uses. */
    finish(childId) {
      liveIds.delete(childId)
    },
    /** A reserved or messaged child that is now resident, which is what the reconciliation reads. */
    wake(childId) {
      liveIds.add(childId)
    },
    started,
    drained,
    sent,
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

/** The arguments the `retire_member` tool passes: the model's own decision to end a role. */
const asTool = (ctx, table, extra = {}) => call(ctx, table, { consentRequired: true, ...extra })

const memberNamed = (table, name, generation = 1) => readRoster(table, 'lead-1').members
  .find((member) => member.name === name && member.generation === generation)

const rowFor = (listed, target) => listed.members.find((row) => row.target === target)

/** Add an open task owned by one member, through the board's own create action. */
const ownTask = async (table, owner, title = 'Finish the parser tests') => (await taskBoard({
  table,
  leadSessionId: 'lead-1',
  action: 'create',
  title,
  owner,
})).task

// ---------------------------------------------------------------------------------------------
// Decision 1: the lifetime is declared on the call, from either spelling, and is never inherited.
// ---------------------------------------------------------------------------------------------

test('a spawn declares a lifetime, and the row reports the one it declared', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const oneShot = await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start on the probe.',
    lifetime: LIFETIME.oneShot,
  }))
  assert.equal(oneShot.lifetime, LIFETIME.oneShot, 'the row answers "may this member retire itself?"')
  assert.equal(oneShot.ephemeral, true, 'the durable field is still the one every record carries')
  const record = memberNamed(table, 'probe')
  assert.equal(lifetimeOf(record), LIFETIME.oneShot)
  assert.equal(typeof record.startedAt, 'string', 'the start is the positive evidence the sweep requires')

  // The default is standing, which is the safe side: only a one-shot is retired without asking.
  const standing = await spawnMember(call(ctx, table, { name: 'keeper', label: 'Hold the line', prompt: 'Stay.' }))
  assert.equal(standing.lifetime, LIFETIME.standing)
  assert.equal(Object.hasOwn(standing, 'ephemeral'), false, 'a standing row reports nothing it did not ask for')
  assert.equal(Object.hasOwn(memberNamed(table, 'keeper'), 'startedAt'), false)

  // `ephemeral: true` is the pre-v0.25 spelling of the same declaration and keeps working.
  const aliased = await spawnMember(call(ctx, table, {
    name: 'alias',
    label: 'Same thing',
    prompt: 'Go.',
    ephemeral: true,
  }))
  assert.equal(aliased.lifetime, LIFETIME.oneShot)
  assert.equal(aliased.ephemeral, true)

  // Declaring it twice is fine when the two agree, and refused when they do not: a tie-break would make
  // one of the two fields a silent lie.
  const agreed = await spawnMember(call(ctx, table, {
    name: 'agreed',
    label: 'Agreed',
    prompt: 'Go.',
    lifetime: LIFETIME.standing,
    ephemeral: false,
  }))
  assert.equal(agreed.lifetime, LIFETIME.standing)
  assert.equal(declaredLifetime({}), LIFETIME.standing, 'an omitted declaration is standing')
  assert.throws(
    () => declaredLifetime({ lifetime: LIFETIME.oneShot, ephemeral: false }),
    /declare different lifetimes/,
  )
  assert.throws(() => declaredLifetime({ lifetime: 'ephemeral' }), /lifetime must be "standing" or "one-shot"/)
})

test('a replace does not inherit the predecessor\'s lifetime, so the work it just handed over survives', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start.',
    lifetime: LIFETIME.oneShot,
  }))
  const task = await ownTask(table, 'probe')

  // The predecessor is one-shot, and the replacement does not say otherwise: the successor is standing,
  // because a lifetime is this call's declaration and not a property of the name.
  const successor = await spawnMember(call(ctx, table, {
    replace: 'probe',
    label: 'Probe II',
    prompt: 'Continue.',
  }))
  assert.equal(successor.target, 'probe-g2')
  assert.equal(successor.lifetime, LIFETIME.standing)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.retired)
  assert.equal(memberNamed(table, 'probe', 2).phase, PHASE.active)
  assert.equal(Object.hasOwn(memberNamed(table, 'probe', 2), 'startedAt'), false)

  // The work moved, and the successor is not eligible for a sweep even after it stops: the orphaned-work
  // failure ADR 0019 accepted cannot happen through a replace any more.
  assert.equal(readRoster(table, 'lead-1').tasks.find((row) => row.id === task.id).owner, 'probe-g2')
  ctx.finish(successor.child_id)
  const listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false)
  assert.equal(memberNamed(table, 'probe', 2).phase, PHASE.active)

  // An explicit declaration on the replace call is honoured, so the fan-out can still replace with one.
  const third = await spawnMember(call(ctx, table, {
    replace: 'probe-g2',
    label: 'Probe III',
    prompt: 'Continue.',
    lifetime: LIFETIME.oneShot,
  }))
  assert.equal(third.lifetime, LIFETIME.oneShot)
  assert.equal(typeof memberNamed(table, 'probe', 3).startedAt, 'string')
  assert.equal(born.ephemeral, true)
})

// ---------------------------------------------------------------------------------------------
// Decisions 2, 3 and 4: three conditions, standing is never swept, the board is a veto.
// ---------------------------------------------------------------------------------------------

test('a one-shot member is swept only after it started, stopped, and owned no open row', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start.',
    lifetime: LIFETIME.oneShot,
  }))

  // Condition 2: still running. It has started, but it has not stopped.
  let listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.active)

  // Conditions 1 and 2 hold, and the board owns nothing: the sweep acts, through the normal retirement.
  ctx.finish(born.child_id)
  listed = await listMembers(call(ctx, table))
  assert.equal(listed.swept, 1)
  assert.deepEqual(listed.swept_targets, ['probe'])
  assert.equal(rowFor(listed, 'probe').phase, PHASE.retired, 'the same read already shows the sweep')
  assert.equal(memberNamed(table, 'probe').retireReason, 'one-shot member: it ran and stopped and owned no open task')
  assert.deepEqual(ctx.drained, [born.child_id], 'the sweep drained the child through the normal path')
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed, 'the result stays lossless JSON')
})

test('a standing member is never swept, however long it idles', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'keeper',
    label: 'Hold the line',
    prompt: 'Stay.',
    lifetime: LIFETIME.standing,
  }))
  ctx.finish(born.child_id)

  // Three reads, a fan-out call between them, and the member is untouched: nothing retires a standing
  // role except a retirement call.
  for (const step of ['first', 'second', 'third']) {
    const listed = await listMembers(call(ctx, table))
    assert.equal(Object.hasOwn(listed, 'swept'), false, `${step}: a standing member is not swept`)
    assert.equal(memberNamed(table, 'keeper').phase, PHASE.active)
    assert.deepEqual(ctx.drained, [], 'nothing was drained')
  }
  await spawnMember(call(ctx, table, { name: 'other', label: 'Other', prompt: 'Go.' }))
  assert.equal(memberNamed(table, 'keeper').phase, PHASE.active)
})

test('the board is a veto: an owned open row blocks the sweep, and the result names the row and its call', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start.',
    lifetime: LIFETIME.oneShot,
  }))
  const blocking = await ownTask(table, 'probe', 'Recheck the curve')
  ctx.finish(born.child_id)

  // All of decisions 2's first two conditions hold. The third does not, so the member stays.
  const listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false, 'the veto blocked the sweep')
  assert.equal(listed.blocked, 1)
  assert.deepEqual(listed.blocking_tasks, [blocking.id])
  assert.match(listed.blocking_note, new RegExp(`task_id: "${blocking.id}"`), 'the note names the call that clears it')
  assert.match(listed.blocking_note, /left it alone/)
  assert.match(listed.blocking_note, /never what proves the member finished/)
  assert.equal(rowFor(listed, 'probe').phase, PHASE.active, 'a blocked member is still listed as active')
  assert.equal(readRoster(table, 'lead-1').tasks.find((row) => row.id === blocking.id).owner, 'probe')
  assert.deepEqual(ctx.drained, [], 'a blocked member is not drained')

  // Closing the row is what makes it eligible — and it is not what proves the member finished, which is
  // why the sweep waits for a stop as well.
  await taskBoard({ table, leadSessionId: 'lead-1', action: 'update', task_id: blocking.id, status: 'done' })
  const after = await listMembers(call(ctx, table))
  assert.equal(after.swept, 1)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.retired)
})

test('an empty board is not a trigger: a one-shot member that never ran is left alone', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()

  // A reservation that never published: the sweep has no `startedAt` to act on, and no row blocks it.
  const reserved = planMember({ leadSessionId: 'lead-1', members: [] }, 'probe', 'Probe', undefined, true)
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [reserved] }))
  const afterReservation = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(afterReservation, 'swept'), false)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.failed, 'the read-time reconciliation is a different operation')

  // An active one-shot record with no start evidence is left alone too: the flag alone is not proof.
  const unstarted = {
    ...planMember({ leadSessionId: 'lead-1', members: [] }, 'watcher', 'Watch', undefined, true),
    phase: PHASE.active,
  }
  await updateRoster(table, 'lead-1', (current) => ({ ...current, members: [...current.members, unstarted] }))
  const listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false)
  assert.equal(memberNamed(table, 'watcher').phase, PHASE.active)
})

test('the sweep is idempotent, and spawn_member is the other trigger and reports what it freed', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const first = await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe',
    prompt: 'Go.',
    lifetime: LIFETIME.oneShot,
  }))
  const second = await spawnMember(call(ctx, table, {
    name: 'audit',
    label: 'Audit',
    prompt: 'Go.',
    lifetime: LIFETIME.oneShot,
  }))
  ctx.finish(first.child_id)
  ctx.finish(second.child_id)

  const listed = await listMembers(call(ctx, table))
  assert.equal(listed.swept, 2)
  assert.deepEqual(listed.swept_targets.sort(), ['audit', 'probe'])
  const retiredAt = memberNamed(table, 'probe').retiredAt

  const again = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(again, 'swept'), false)
  assert.equal(memberNamed(table, 'probe').retiredAt, retiredAt)
  assert.equal(ctx.drained.length, 2, 'nothing was drained twice')

  const third = await spawnMember(call(ctx, table, {
    name: 'reviewer',
    label: 'Review',
    prompt: 'Go.',
    lifetime: LIFETIME.oneShot,
  }))
  await spawnMember(call(ctx, table, { name: 'scribe', label: 'Scribe', prompt: 'Go.' }))
  ctx.finish(third.child_id)
  const started = await spawnMember(call(ctx, table, { name: 'watcher', label: 'Watch', prompt: 'Go.' }))
  assert.equal(started.swept, 1)
  assert.deepEqual(started.swept_targets, ['reviewer'])
  assert.equal(memberNamed(table, 'reviewer').phase, PHASE.retired)
})

// ---------------------------------------------------------------------------------------------
// Decision 5: a standing member is retired only on the person's quoted words.
// ---------------------------------------------------------------------------------------------

test('retire_member refuses a standing member until it carries the person\'s words, and retires nothing', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'keeper',
    label: 'Hold the line',
    prompt: 'Stay.',
    assignment: 'Keep the release green.',
  }))
  const owned = await ownTask(table, 'keeper', 'Watch the release')

  const refused = await retireMember(asTool(ctx, table, { target: 'keeper' }))
  assert.equal(refused.retired, false)
  assert.equal(refused.reason, 'needs-confirmation')
  assert.equal(refused.lifetime, LIFETIME.standing)
  assert.match(refused.question, /Retire the standing member "keeper"/)
  assert.match(refused.question, /still owns 1 open task/)
  assert.match(refused.question, /Keep the release green/, 'the question carries what the member was doing')
  assert.deepEqual(refused.owns_tasks, [owned.id])
  assert.match(refused.message, /confirmed set to their answer, quoted verbatim/)
  assert.deepEqual(JSON.parse(JSON.stringify(refused)), refused, 'the refusal stays lossless JSON')

  // A refusal changes nothing at all: no tombstone, no drain, no un-owned work.
  assert.equal(memberNamed(table, 'keeper').phase, PHASE.active)
  assert.equal(readRoster(table, 'lead-1').tasks.find((row) => row.id === owned.id).owner, 'keeper')
  assert.deepEqual(ctx.drained, [])
  assert.equal(ctx.agents.get(born.child_id).id, born.child_id, 'the child was never drained')

  // An empty confirmation is not consent either.
  const blank = await retireMember(asTool(ctx, table, { target: 'keeper', confirmed: '   ' }))
  assert.equal(blank.reason, 'needs-confirmation')

  // The retirement happens on the next call, and the sentence is echoed back into the transcript.
  const done = await retireMember(asTool(ctx, table, { target: 'keeper', confirmed: 'Yes, the reviewer role is done for now.' }))
  assert.equal(done.retired, true)
  assert.equal(done.lifetime, LIFETIME.standing)
  assert.match(done.message, /quoted back here: "Yes, the reviewer role is done for now\."/)
  assert.equal(memberNamed(table, 'keeper').phase, PHASE.retired)
  assert.deepEqual(done.unowned_tasks, [owned.id], 'the work it owned lost its owner, and is named')
})

test('a one-shot member, a replacement and a tombstone need no confirmation', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe',
    prompt: 'Go.',
    lifetime: LIFETIME.oneShot,
  }))
  // The declaration was the person's prior consent, so the tool's gate does not stop it.
  const oneShot = await retireMember(asTool(ctx, table, { target: 'probe' }))
  assert.equal(oneShot.retired, true)
  assert.equal(oneShot.lifetime, LIFETIME.oneShot)

  // Repeating it is the state matrix's no-op, not a second question.
  const repeat = await retireMember(asTool(ctx, table, { target: 'probe' }))
  assert.equal(repeat.retired, true)
  assert.equal(repeat.reason, 'already-retired')
  assert.equal(Object.hasOwn(repeat, 'question'), false)

  // A replacement continues the role with a new holder, so a standing predecessor leaves without a
  // question — which is what keeps the ordinary operation one call.
  await spawnMember(call(ctx, table, { name: 'keeper', label: 'Hold the line', prompt: 'Stay.' }))
  const replaced = await spawnMember(call(ctx, table, { replace: 'keeper', label: 'Keeper II', prompt: 'Continue.' }))
  assert.equal(replaced.predecessor_retired, true)
  assert.equal(memberNamed(table, 'keeper').phase, PHASE.retired)
  assert.equal(memberNamed(table, 'keeper', 2).phase, PHASE.active)
})

test('a record that never became a role needs no confirmation, and one that did still does', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()

  // A failed standing record never started: there is no role to ask about, so cleanup is one call.
  const failed = {
    ...planMember({ leadSessionId: 'lead-1', members: [] }, 'broken', 'Broken', undefined),
    phase: PHASE.failed,
  }
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [failed] }))
  const cleaned = await retireMember(asTool(ctx, table, { target: 'broken' }))
  assert.equal(cleaned.retired, true, 'a failed record is removed without a question')
  assert.equal(cleaned.lifetime, LIFETIME.standing, 'the exemption is about the phase, not about one-shot')
  assert.equal(Object.hasOwn(cleaned, 'question'), false)
  assert.equal(memberNamed(table, 'broken').phase, PHASE.retired)

  // A standing member that actually ran is `active` while it lives, so the quoted words are still required
  // — the narrow exemption must not leak into the case consent exists for. It is given an assignment so it
  // carries something: a bare one is housekeeping under v0.25.1's narrower gate, which its own test covers.
  await spawnMember(call(ctx, table, {
    name: 'keeper',
    label: 'Hold the line',
    prompt: 'Stay.',
    assignment: 'Keep the release green.',
  }))
  const refused = await retireMember(asTool(ctx, table, { target: 'keeper' }))
  assert.equal(refused.retired, false)
  assert.equal(refused.reason, 'needs-confirmation')
  const answered = await retireMember(asTool(ctx, table, { target: 'keeper', confirmed: 'The release is signed off.' }))
  assert.equal(answered.retired, true)

  // The boundary the exemption must not cross, and the reconciliation that decides which side a
  // reservation falls on. A reserved record whose child published is reconciled to `active` — it is a role
  // now, so it is asked about; one whose child never published is reconciled to `failed`, which is the
  // case above and needs no words. The assignment keeps this cell about the phase rather than about the
  // gate's carrier rule, which is decided on its own.
  const published = planMember({ leadSessionId: 'lead-1', members: readRoster(table, 'lead-1').members }, 'pending', 'Pending', 'Carry the reservation.')
  await updateRoster(table, 'lead-1', (current) => ({ ...current, members: [...current.members, published] }))
  ctx.wake(published.childId)
  const provisioned = await retireMember(asTool(ctx, table, { target: 'pending' }))
  assert.equal(provisioned.reason, 'needs-confirmation', 'a reservation whose child published became a role')
  assert.equal(memberNamed(table, 'pending').phase, PHASE.active, 'the read reconciled it, and it is still live')

  const stranded = planMember({ leadSessionId: 'lead-1', members: readRoster(table, 'lead-1').members }, 'stranded', 'Stranded', undefined)
  await updateRoster(table, 'lead-1', (current) => ({ ...current, members: [...current.members, stranded] }))
  const tidied = await retireMember(asTool(ctx, table, { target: 'stranded' }))
  assert.equal(tidied.retired, true, 'a reservation that never published a child is `failed`, so it is cleanup')
  assert.equal(Object.hasOwn(tidied, 'question'), false)
})

// ---------------------------------------------------------------------------------------------
// The gate protects a role-level decision, not every act of housekeeping (v0.25.1).
// ---------------------------------------------------------------------------------------------

test('a standing member that carries nothing retires in one call, and the result says why', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe the cache', prompt: 'Start.' }))

  const done = await retireMember(asTool(ctx, table, {
    target: 'probe',
    reason: 'Left over from yesterday\'s probe; nothing owed.',
  }))
  assert.equal(done.retired, true, 'bare residue is the Lead\'s to clear')
  assert.equal(done.lifetime, LIFETIME.standing)
  assert.equal(Object.hasOwn(done, 'question'), false, 'nobody is asked about housekeeping')
  assert.match(done.message, /carried nothing — no recorded assignment, no open task, no evidence it was re-tasked/)
  assert.match(done.message, /housekeeping on the reason you stated/)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.retired)
  assert.equal(
    memberNamed(table, 'probe').retireReason,
    'Left over from yesterday\'s probe; nothing owed.',
    'the reason is what the tombstone keeps, which is why the call must state it',
  )
})

test('a bare standing member is refused when the call states no reason', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'probe', label: 'Probe', prompt: 'Start.' }))

  const refused = await retireMember(asTool(ctx, table, { target: 'probe' }))
  assert.equal(refused.retired, false)
  assert.equal(refused.reason, 'needs-reason')
  assert.equal(refused.lifetime, LIFETIME.standing)
  assert.deepEqual(refused.carries, [], 'the empty list is the statement: it carries nothing')
  assert.equal(Object.hasOwn(refused, 'question'), false, 'this half of the gate asks nobody')
  assert.match(refused.message, /State why with the reason parameter/)
  assert.equal(memberNamed(table, 'probe').phase, PHASE.active, 'the refusal changed nothing')
  assert.deepEqual(ctx.drained, [], 'and drained nothing')

  // A blank reason is not a reason either — the same rule as every other cap in this plugin.
  const blank = await retireMember(asTool(ctx, table, { target: 'probe', reason: '   ' }))
  assert.equal(blank.reason, 'needs-reason')
  assert.equal(memberNamed(table, 'probe').phase, PHASE.active)
})

test('a standing member that carries something is still asked about, whatever it carries', async () => {
  // A recorded assignment is the durable statement of what the role was doing.
  {
    const table = memoryTable()
    const ctx = fakeCtx()
    await spawnMember(call(ctx, table, {
      name: 'writer',
      label: 'Write the docs',
      prompt: 'Go.',
      assignment: 'Keep the docs green.',
    }))
    const refused = await retireMember(asTool(ctx, table, { target: 'writer', reason: 'Tidying up.' }))
    assert.equal(refused.reason, 'needs-confirmation', 'a reason does not replace consent')
    assert.deepEqual(refused.carries, ['a recorded assignment'], 'and the refusal names what stopped it')
    assert.equal(refused.assignment, 'Keep the docs green.')
    assert.equal(Object.hasOwn(refused, 'owns_tasks'), false, 'a field it has nothing for is omitted, not empty')
  }

  // An open row is work someone still owes this Lead.
  {
    const table = memoryTable()
    const ctx = fakeCtx()
    await spawnMember(call(ctx, table, { name: 'runner', label: 'Run the suite', prompt: 'Go.' }))
    const task = await ownTask(table, 'runner', 'Finish the parser tests')
    const refused = await retireMember(asTool(ctx, table, { target: 'runner', reason: 'Tidying up.' }))
    assert.equal(refused.reason, 'needs-confirmation')
    assert.deepEqual(refused.carries, ['1 open task'])
    assert.deepEqual(refused.owns_tasks, [task.id])
  }

  // Being handed work twice with nothing else to show for it is the third kind of carrier.
  {
    const table = memoryTable()
    const ctx = fakeCtx()
    await spawnMember(call(ctx, table, { name: 'prober', label: 'Probe the cache', prompt: 'Go.' }))
    await messageMember(call(ctx, table, { target: 'prober', message: 'One more round.' }))
    await messageMember(call(ctx, table, { target: 'prober', message: 'And one more.' }))
    const refused = await retireMember(asTool(ctx, table, { target: 'prober', reason: 'Tidying up.' }))
    assert.equal(refused.reason, 'needs-confirmation', 'a member used twice is a role, not residue')
    assert.deepEqual(refused.carries, ['being re-tasked (2 messages)'])
  }
})

test('the re-task counters are written for a standing member too, which is what the gate reads', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'prober', label: 'Probe the cache', prompt: 'Go.' }))
  await messageMember(call(ctx, table, { target: 'prober', message: 'One more round.' }))
  const once = memberNamed(table, 'prober')
  assert.equal(once.messageCount, 1, 'a standing member has no startedAt, but it does have a count')
  assert.equal(Object.hasOwn(once, 'startedAt'), false, 'and the one-shot evidence is left alone')

  // One message is not re-tasking, so the member is still bare residue.
  const done = await retireMember(asTool(ctx, table, { target: 'prober', reason: 'Nothing owed after one nudge.' }))
  assert.equal(done.retired, true)
  assert.equal(Object.hasOwn(done, 'question'), false)

  // The advice on a row stays one-shot-only: a standing member is not told it is "probably standing".
  const table2 = memoryTable()
  const ctx2 = fakeCtx()
  await spawnMember(call(ctx2, table2, { name: 'keeper', label: 'Hold the line', prompt: 'Stay.' }))
  await messageMember(call(ctx2, table2, { target: 'keeper', message: 'One more round.' }))
  await messageMember(call(ctx2, table2, { target: 'keeper', message: 'And one more.' }))
  const listed = await listMembers(call(ctx2, table2))
  const row = listed.members.find((candidate) => candidate.target === 'keeper')
  assert.equal(row.lifetime, LIFETIME.standing)
  assert.equal(Object.hasOwn(row, 'retasked'), false, 'the advice corrects a one-shot declaration, not a role')
})

// ---------------------------------------------------------------------------------------------
// Decision 6 and 7: a message re-opens a one-shot member; the advice never converts one.
// ---------------------------------------------------------------------------------------------

test('a message re-opens a one-shot member instead of re-declaring it', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const born = await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start.',
    lifetime: LIFETIME.oneShot,
  }))

  const messaged = await messageMember(call(ctx, table, { target: 'probe', message: 'One more round.' }))
  assert.equal(messaged.sent, true)
  assert.equal(messaged.lifetime, LIFETIME.oneShot, 'the lifetime is unchanged by a message')
  assert.equal(messaged.reopened, true)
  assert.equal(Object.hasOwn(messaged, 'ephemeral'), false, 'the flag is not cleared, so there is no cleared flag to report')
  assert.equal(memberNamed(table, 'probe').ephemeral, true, 'the declaration survives the message')
  assert.equal(Object.hasOwn(memberNamed(table, 'probe'), 'startedAt'), false, 'the finished-evidence is invalidated')

  // The discriminating case: it stops again, and it is NOT swept, because the plugin has not observed it
  // alive since the last time it was handed work.
  ctx.finish(born.child_id)
  let listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false, 'a just-messaged member is not swept')
  assert.equal(memberNamed(table, 'probe').phase, PHASE.active)
  assert.deepEqual(ctx.drained, [])

  // Once it has actually run again and stopped, the same evidence exists again and the sweep acts.
  await messageMember(call(ctx, table, { target: 'probe', message: 'And once more.' }))
  listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(listed, 'swept'), false, 'still resident, so still not swept')
  assert.equal(typeof memberNamed(table, 'probe').startedAt, 'string', 'the read re-stamps what it observed')
  ctx.finish(born.child_id)
  listed = await listMembers(call(ctx, table))
  assert.equal(listed.swept, 1, 'it runs, stops, owns nothing, and leaves')
  assert.equal(memberNamed(table, 'probe').phase, PHASE.retired)
})

test('a re-tasked one-shot member is flagged as probably standing, and is never converted', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, {
    name: 'probe',
    label: 'Probe the cache',
    prompt: 'Start.',
    lifetime: LIFETIME.oneShot,
  }))

  // One message is not evidence: any member may need one follow-up.
  await messageMember(call(ctx, table, { target: 'probe', message: 'Carry on.' }))
  let listed = await listMembers(call(ctx, table))
  assert.equal(Object.hasOwn(rowFor(listed, 'probe'), 'retasked'), false)

  await messageMember(call(ctx, table, { target: 'probe', message: 'And the next round.' }))
  listed = await listMembers(call(ctx, table))
  const row = rowFor(listed, 'probe')
  assert.equal(row.retasked, true)
  assert.match(row.retasked_note, /2 messages/)
  assert.match(row.retasked_note, /probably not one/)
  assert.match(row.retasked_note, /lifetime: "standing"/, 'the note names the call that declares it')
  assert.equal(row.lifetime, LIFETIME.oneShot, 'advice, not a conversion')

  // Assignment changes are the second signal, and they count on their own — but only once there are two
  // of them, for the same reason: one rewrite is a clarification, not a change of role.
  await messageMember(call(ctx, table, { target: 'probe', message: 'Take the first half.', assignment: 'Take the first half.' }))
  assert.equal(
    Object.hasOwn(rowFor(await listMembers(call(ctx, table)), 'probe'), 'retasked_note'),
    true,
    'the message count already flagged it',
  )
  await messageMember(call(ctx, table, { target: 'probe', message: 'Now the second half.', assignment: 'Take the second half.' }))
  const counted = memberNamed(table, 'probe')
  assert.equal(counted.assignmentCount, 2, 'two assignment changes were written')
  const third = rowFor(await listMembers(call(ctx, table)), 'probe')
  assert.match(third.retasked_note, /2 assignment changes/)
  assert.equal(memberNamed(table, 'probe').ephemeral, true)

  // The counters are written for every member, because the retirement gate reads them; what stays
  // one-shot-only is the advice drawn from them, asserted in its own test below this one.
  await spawnMember(call(ctx, table, { name: 'keeper', label: 'Hold the line', prompt: 'Stay.' }))
  await messageMember(call(ctx, table, { target: 'keeper', message: 'Still there?' }))
  assert.equal(memberNamed(table, 'keeper').messageCount, 1)
})

// ---------------------------------------------------------------------------------------------
// The stored fields, validated on load like every other optional one.
// ---------------------------------------------------------------------------------------------

test('the lifetime fields are validated when a record is loaded, and older records still load', () => {
  const parse = parseRoster
  const record = { leadSessionId: 'lead-1', members: [] }
  assert.equal(parse(record), record, 'a record written before v0.9 loads unchanged')
  for (const [field, value, message] of [
    ['ephemeral', 'yes', /ephemeral must be a boolean/],
    ['startedAt', '', /startedAt must be a non-empty string/],
    ['messageCount', 1.5, /messageCount must be a non-negative integer/],
    ['messageCount', -1, /messageCount must be a non-negative integer/],
    ['assignmentCount', 'two', /assignmentCount must be a non-negative integer/],
  ]) {
    const broken = {
      leadSessionId: 'lead-1',
      members: [{ memberId: 'm-1', childId: 'c-1', name: 'probe', generation: 1, phase: PHASE.active, label: 'x', [field]: value }],
    }
    assert.throws(() => parse(broken), message)
  }
  const counted = {
    leadSessionId: 'lead-1',
    members: [{
      memberId: 'm-1',
      childId: 'c-1',
      name: 'probe',
      generation: 1,
      phase: PHASE.active,
      label: 'x',
      ephemeral: true,
      messageCount: 0,
      assignmentCount: 3,
    }],
  }
  assert.equal(parse(counted), counted, 'zero is a count, not an absence')
})
