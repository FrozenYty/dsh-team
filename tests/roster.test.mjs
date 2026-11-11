import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PHASE, adoptMember, findByTarget, planMember, targetOf, withMember } from '../roster.js'

const emptyRoster = () => ({ leadSessionId: 'lead-1', members: [] })

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
