import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PHASE, adoptMember, checkLabel, findAnyTarget, findByTarget, parseRoster, planMember, targetOf, withMember } from '../roster.js'

const emptyRoster = () => ({ leadSessionId: 'lead-1', members: [] })

test('a label is trimmed and capped at the write boundary', () => {
  assert.equal(checkLabel('  Check the diff  '), 'Check the diff')
  assert.equal(checkLabel('x'.repeat(200)).length, 200)
  assert.throws(() => checkLabel('x'.repeat(201)), /the cap is 200/)
  assert.throws(() => checkLabel('   '), /non-empty/)
  assert.throws(() => checkLabel(undefined), /must be a string/)
  // The cap is enforced where a member is planned, so no write can store an unbounded label.
  assert.throws(() => planMember(emptyRoster(), 'reviewer', 'x'.repeat(201)), /the cap is 200/)
  assert.equal(planMember(emptyRoster(), 'reviewer', '  spaced  ').label, 'spaced')
})

test('the first holder of a name keeps the bare name; the next generation is suffixed', () => {
  const first = planMember(emptyRoster(), 'reviewer', 'Check the diff')
  assert.equal(first.generation, 1)
  assert.equal(targetOf(first), 'reviewer')

  const roster = withMember(emptyRoster(), first)
  const second = planMember(roster, 'reviewer', 'Check the diff again')
  assert.equal(second.generation, 2)
  assert.equal(targetOf(second), 'reviewer-g2')
})

test('a retired holder does not block the next generation', () => {
  const first = planMember(emptyRoster(), 'reviewer', 'x')
  const roster = withMember(emptyRoster(), { ...first, phase: PHASE.retired })
  const second = planMember(roster, 'reviewer', 'y')
  assert.equal(second.generation, 2)
  assert.equal(findByTarget(roster, 'reviewer'), undefined, 'a retired member is not addressable')
})

test('names and identity are validated', () => {
  assert.throws(() => planMember(emptyRoster(), 'lead', 'x'), /reserved/)
  assert.throws(() => planMember(emptyRoster(), 'Reviewer', 'x'), /must match/)
  assert.throws(() => planMember(emptyRoster(), 'a b', 'x'), /must match/)
})

test('planMember never reuses a live target', () => {
  const first = planMember(emptyRoster(), 'reviewer', 'x')
  const roster = withMember(emptyRoster(), { ...first, phase: PHASE.active })
  // Force a collision by pretending the stored generation is the one that would be planned next.
  const collided = { ...roster, members: [{ ...first, memberId: 'other', childId: 'other', phase: PHASE.active }] }
  assert.equal(planMember(collided, 'reviewer', 'y').generation, 2)
})

test('adoption keeps the child Session id as identity and a usable name', () => {
  const adopted = adoptMember(emptyRoster(), {
    id: 'child-1',
    name: 'Reviewer One',
    description: 'Shipped roster member',
    status: 'active',
  })
  assert.equal(adopted.memberId, 'child-1')
  assert.equal(adopted.childId, 'child-1')
  assert.equal(adopted.phase, PHASE.active)
  assert.equal(adopted.name, 'reviewer-one', 'a name the registry cannot store is normalized')
  assert.equal(targetOf(adopted), 'reviewer-one')
})

test('adoption refuses a row without an identity, and marks a failed member failed', () => {
  assert.equal(adoptMember(emptyRoster(), { name: 'x' }), undefined)
  const failed = adoptMember(emptyRoster(), { id: 'child-2', name: 'probe', status: 'failed' })
  assert.equal(failed.phase, PHASE.failed)
})

test('adoption of the same child twice yields one record', () => {
  const shipped = { id: 'child-3', name: 'probe', description: 'x', status: 'active' }
  const first = adoptMember(emptyRoster(), shipped)
  const roster = withMember(emptyRoster(), first)
  const second = adoptMember(roster, shipped)
  assert.equal(second.generation, 2)
  assert.equal(second.memberId, first.memberId)
})

test('withMember replaces by memberId and appends otherwise', () => {
  const first = planMember(emptyRoster(), 'a', 'x')
  const roster = withMember(emptyRoster(), first)
  assert.equal(roster.members.length, 1)
  const updated = withMember(roster, { ...first, label: 'changed' })
  assert.equal(updated.members.length, 1)
  assert.equal(updated.members[0].label, 'changed')
})

test('an addressable lookup skips a failed member that the any-phase lookup still finds', () => {
  const planned = planMember(emptyRoster(), 'reviewer', 'x')
  const roster = withMember(emptyRoster(), { ...planned, phase: PHASE.failed })
  assert.equal(findByTarget(roster, 'reviewer'), undefined, 'a failed member cannot be messaged or stopped')
  assert.equal(findAnyTarget(roster, 'reviewer').phase, PHASE.failed, 'but the lifecycle can still name it')
})

test('a record that gives one target to two members is refused when it is loaded', () => {
  const parse = parseRoster
  const record = {
    leadSessionId: 'lead-1',
    members: [
      { memberId: 'a', childId: 'a', name: 'reviewer', generation: 1, phase: PHASE.active, label: 'x' },
      { memberId: 'b', childId: 'b', name: 'reviewer', generation: 1, phase: PHASE.active, label: 'y' },
    ],
  }
  assert.throws(() => parse(record), /held by more than one member/, 'the lookup takes the first match, so a duplicate must not load')

  record.members[1].generation = 2
  assert.equal(parse(record), record, 'distinct generations of one name are the normal successor case')
})
