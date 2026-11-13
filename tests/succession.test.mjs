/**
 * The succession link: a replacement writes both directions of one fact, in the mutations that create the
 * two records, so a chain reads from either end.
 *
 * The forward half (`predecessor` on the successor) has been written since v0.2; the reverse half
 * (`successor` on the tombstone) is this release, and the point is the invariant rather than the field: a
 * reader must never see a retired predecessor whose successor is unrecorded, which is why both halves are
 * written by the same event and the reverse half goes into the *same* serialized mutation that makes the
 * record a tombstone (ADR 0032). The link is a fact about the position, not about the artifact, so a pruned
 * tombstone still answers both directions.
 *
 * Two interactions arrived after this was designed, and both are tested here rather than assumed:
 *
 *   - a tombstone past the retention window leaves the roster for the archive (ADR 0030), so a walk
 *     backwards can reach a member id this read has no record for. The walk stops there, the edge keeps its
 *     id and loses its target, and the same read reports `archived_records` and `archive_file` — the archive
 *     is not opened, because a list read that opened it would be the hot-path read ADR 0030 forbids;
 *   - a record can arrive from a seed, so the loader's validation is the only thing standing between a
 *     hand-edited or foreign record and a row that reports an edge the schema refuses.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listMembers, restoreMember, retireMember, spawnMember } from '../actions.js'
import {
  ARCHIVE_FILE_NAME,
  PHASE,
  PROVENANCE_FILE_NAME,
  ROSTER_FILE_NAME,
  TRASH_STATE,
  createRosterSource,
  readRoster,
  updateRoster,
} from '../roster.js'
import { TEAM_DIR, createRootBinder } from '../trash.js'
import { memoryTable } from './memory-table.mjs'

const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-succession-'))

/**
 * A context fake carrying what a spawn, a retirement and the roster read touch. `listed` is what the
 * shipped roster reports for adoption, and `artifactOf` mounts the persistence service a real trash move
 * (and therefore a real prune) needs: it maps a child id to a directory on disk, or to undefined when
 * that member's artifact does not exist.
 */
function fakeCtx({ listed = [], artifactOf } = {}) {
  const started = []
  return {
    agentTeams: { listMembers: () => listed },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => {
        started.push(spec)
        return { childId: spec.childId }
      },
      drainChildren: async () => {},
    },
    agents: { get: () => undefined },
    get: (name) => (name === 'sessionPersistence' && artifactOf !== undefined
      ? { stat: async (id) => {
        const path = artifactOf(id)
        return path === undefined ? undefined : { location: { path } }
      } }
      : undefined),
    started,
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
  dataDir: join(tmpdir(), 'dsh-team-succession-data'),
  hooks: hooks(),
  ...extra,
})

const memberIn = (roster, memberId) => roster.members.find((member) => member.memberId === memberId)
const memberNamed = (table, name, generation) => readRoster(table, 'lead-1').members
  .find((member) => member.name === name && member.generation === generation)
const rowsOf = async (ctx, table, extra = {}) => (await listMembers(call(ctx, table, extra))).members
const rowById = (rows, memberId) => rows.find((row) => row.member_id === memberId)

/** One replacement, from the roster that holds its predecessor to the row the successor reports. */
async function replace(ctx, table, { name, target, generation, trashLimit } = {}) {
  await spawnMember(call(ctx, table, {
    name,
    label: 'Check the diff',
    prompt: 'Start.',
    assignment: 'Finish the parser unit tests.',
    trashLimit,
  }))
  const predecessor = memberNamed(table, name, 1)
  const replaced = await spawnMember(call(ctx, table, {
    replace: target ?? name,
    label: 'Check the diff',
    prompt: 'Continue the parser work.',
    trashLimit,
  }))
  return {
    // The record as the replacement left it, not the snapshot taken before it ran.
    predecessor: memberIn(readRoster(table, 'lead-1'), predecessor.memberId),
    born: predecessor,
    replaced,
    successor: memberNamed(table, name, generation ?? 2),
  }
}

test('one replacement writes both directions, and never one without the other', async () => {
  const table = memoryTable()
  // Every state the table ever held, so "written in the same mutation" is checked against what a reader
  // could actually have seen rather than against the end state alone.
  const snapshots = []
  const tracked = {
    ...table,
    update: async (key, mutate) => {
      const next = await table.update(key, mutate)
      snapshots.push(JSON.parse(JSON.stringify(next)))
      return next
    },
  }
  const ctx = fakeCtx()
  const { predecessor, replaced, successor } = await replace(ctx, tracked, { name: 'reviewer' })

  assert.equal(successor.predecessor, predecessor.memberId, 'the successor records the identity it replaced')
  assert.deepEqual(predecessor.successor, { target: 'reviewer-g2', member_id: successor.memberId })
  assert.deepEqual(replaced.predecessor, { target: 'reviewer', member_id: predecessor.memberId }, 'the spawn answer reports the link it wrote')

  const retired = snapshots.filter((snapshot) => memberIn(snapshot, predecessor.memberId)?.phase === PHASE.retired)
  assert.ok(retired.length > 0, 'the replacement tombstoned its predecessor')
  for (const snapshot of retired) {
    assert.deepEqual(
      memberIn(snapshot, predecessor.memberId).successor,
      { target: 'reviewer-g2', member_id: successor.memberId },
      'every state in which the predecessor is a tombstone carries its successor in that same write',
    )
    assert.equal(
      memberIn(snapshot, successor.memberId).predecessor,
      predecessor.memberId,
      'and the successor that edge names already points back',
    )
  }

  const rows = await rowsOf(ctx, tracked)
  const oldRow = rowById(rows, predecessor.memberId)
  const newRow = rowById(rows, successor.memberId)
  assert.deepEqual(oldRow.successor, { target: 'reviewer-g2', member_id: successor.memberId })
  assert.deepEqual(newRow.predecessor, { target: 'reviewer', member_id: predecessor.memberId })
  assert.equal(oldRow.predecessor, undefined, 'the first holder of a name inherited from nobody')
  assert.equal(newRow.successor, undefined, 'a live successor has not handed anything on yet')
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows, 'the read stays lossless JSON')
})

test('a two-hop chain reads in both directions from either end', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const first = await replace(ctx, table, { name: 'reviewer' })
  const third = await spawnMember(call(ctx, table, {
    replace: 'reviewer-g2',
    label: 'Check the diff',
    prompt: 'Continue again.',
  }))
  const second = memberNamed(table, 'reviewer', 2)
  const last = memberNamed(table, 'reviewer', 3)
  assert.equal(third.target, 'reviewer-g3')

  const rows = await rowsOf(ctx, table)
  // Forward, from the first holder: successor -> successor -> nothing.
  const forward = []
  for (let row = rowById(rows, first.predecessor.memberId); row?.successor !== undefined; row = rowById(rows, row.successor.member_id)) {
    forward.push([row.target, row.successor.target, row.successor.member_id])
  }
  // Backward, from the last: predecessor -> predecessor -> nothing.
  const backward = []
  for (let row = rowById(rows, last.memberId); row?.predecessor !== undefined; row = rowById(rows, row.predecessor.member_id)) {
    backward.push([row.target, row.predecessor.target, row.predecessor.member_id])
  }

  assert.deepEqual(forward, [
    ['reviewer', 'reviewer-g2', second.memberId],
    ['reviewer-g2', 'reviewer-g3', last.memberId],
  ])
  assert.deepEqual(backward, [
    ['reviewer-g3', 'reviewer-g2', second.memberId],
    ['reviewer-g2', 'reviewer', first.predecessor.memberId],
  ])
  assert.equal(rowById(rows, first.predecessor.memberId).predecessor, undefined, 'the chain ends at the first holder')
  assert.equal(rowById(rows, last.memberId).successor, undefined, 'and at the last')
})

test('a base name reused by a later generation never confuses the ids', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  const first = await replace(ctx, table, { name: 'reviewer' })
  await spawnMember(call(ctx, table, { replace: 'reviewer-g2', label: 'Check the diff', prompt: 'Continue again.' }))

  const roster = readRoster(table, 'lead-1')
  const holders = roster.members.filter((member) => member.name === 'reviewer')
  assert.deepEqual(holders.map((member) => member.generation), [1, 2, 3], 'one base name, three generations')
  assert.deepEqual([...new Set(holders.map((member) => member.name))], ['reviewer'], 'and nothing distinguishes them by name')

  const rows = await rowsOf(ctx, table)
  const third = rows.find((row) => row.target === 'reviewer-g3')
  // A link shaped as a name would resolve the third holder's predecessor to generation 1, because all
  // three share the base name. The recorded identity resolves it to the generation that actually held it.
  assert.deepEqual(third.predecessor, { target: 'reviewer-g2', member_id: holders[1].memberId })
  for (const row of rows) {
    for (const edge of [row.predecessor, row.successor]) {
      if (edge === undefined) continue
      const linked = rowById(rows, edge.member_id)
      assert.ok(linked, `the edge ${edge.member_id} names a row`)
      assert.equal(linked.target, edge.target, 'the target beside an id is the target that id holds')
    }
  }
  assert.equal(rowById(rows, first.predecessor.memberId).successor.member_id, holders[1].memberId)
})

test('a retirement with no successor records no reverse edge', async () => {
  const table = memoryTable()
  const ctx = fakeCtx()
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start.' }))
  const born = memberNamed(table, 'reviewer', 1)

  const retired = await retireMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(retired.retired, true)
  const tombstone = memberNamed(table, 'reviewer', 1)
  assert.equal(tombstone.phase, PHASE.retired)
  assert.equal(tombstone.successor, undefined, 'nothing took the position, so nothing is recorded')
  assert.equal(tombstone.predecessor, undefined, 'and an unrestored first holder inherited from nobody')

  const rows = await rowsOf(ctx, table)
  assert.equal(rowById(rows, born.memberId).successor, undefined)
  assert.equal(rowById(rows, born.memberId).predecessor, undefined)

  // A restore is not a replacement either: it puts the same record back and fabricates no link.
  const restored = await restoreMember(call(ctx, table, { target: 'reviewer' }))
  assert.equal(restored.restored, true)
  assert.equal(memberNamed(table, 'reviewer', 1).successor, undefined)
  assert.equal(rowById(await rowsOf(ctx, table), born.memberId).successor, undefined)
})

test('an adopted member has no predecessor', async () => {
  const table = memoryTable()
  const ctx = fakeCtx({
    listed: [{ id: 'child-adopted', name: 'outsider', description: 'Brought in from the shipped roster', status: 'active', role: 'teammate' }],
  })
  const rows = await rowsOf(ctx, table)
  const adopted = rows.find((row) => row.target === 'outsider')
  assert.ok(adopted, 'the shipped member is adopted on the first read')
  assert.equal(adopted.member_id, 'child-adopted', 'an adopted member keeps its Session id as its identity')
  assert.equal(adopted.predecessor, undefined)
  assert.equal(adopted.successor, undefined)
})

test('a pruned predecessor still answers both directions', async () => {
  const root = await scratch()
  const sessions = join(root, 'sessions')
  // The persistence service reports a member's artifact while it exists, which is what makes the move —
  // and therefore the cap — happen for real on disk.
  const ctx = fakeCtx({ artifactOf: (id) => (existsSync(join(sessions, id)) ? join(sessions, id) : undefined) })
  const table = memoryTable()
  const seedArtifact = async (childId) => {
    await mkdir(join(sessions, childId), { recursive: true })
    await writeFile(join(sessions, childId, 'session.jsonl'), childId)
  }

  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'One', prompt: 'Start.', trashLimit: 1, dataDir: root }))
  const first = memberNamed(table, 'reviewer', 1)
  await seedArtifact(first.childId)
  await spawnMember(call(ctx, table, { replace: 'reviewer', label: 'Two', prompt: 'Continue.', trashLimit: 1, dataDir: root }))
  const second = memberNamed(table, 'reviewer', 2)
  await seedArtifact(second.childId)
  await spawnMember(call(ctx, table, { replace: 'reviewer-g2', label: 'Three', prompt: 'Continue.', trashLimit: 1, dataDir: root }))

  const pruned = memberNamed(table, 'reviewer', 1)
  assert.equal(pruned.trashState, TRASH_STATE.pruned, 'the cap removed the oldest artifact this Lead retired')
  assert.equal(typeof pruned.trashRelPath, 'string', 'the tombstone still says where the artifact went')
  assert.equal(existsSync(join(root, pruned.trashRelPath)), false, 'and the bytes really are gone')

  const rows = await rowsOf(ctx, table)
  const oldRow = rowById(rows, first.memberId)
  const newRow = rowById(rows, second.memberId)
  assert.equal(oldRow.trashState, undefined, 'trashState is not a row field')
  assert.deepEqual(oldRow.successor, { target: 'reviewer-g2', member_id: second.memberId }, 'the pruned predecessor still says who took over')
  assert.deepEqual(newRow.predecessor, { target: 'reviewer', member_id: first.memberId }, 'and the successor still says who it replaced')
  assert.equal(rowById(rows, first.memberId).child_id, first.childId, 'the pruned row still answers which child it was')
})

/** One record as a roster file holds it, with whatever edge the caller is testing. */
const stored = (member = {}) => ({
  leadSessionId: 'lead-1',
  members: [{
    memberId: 'member-1',
    name: 'reviewer',
    generation: 1,
    childId: 'child-1',
    phase: PHASE.retired,
    label: 'Check the diff',
    createdAt: new Date(0).toISOString(),
    ...member,
  }],
})

/** Load one hand-written record the way the plugin does: through the file, with a fresh store. */
async function loadHandWritten(root, member) {
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, TEAM_DIR), { recursive: true })
  await writeFile(
    join(workspace, TEAM_DIR, ROSTER_FILE_NAME),
    JSON.stringify({ version: 1, serial: 1, updatedAt: 'x', rosters: { 'lead-1': stored(member) } }),
    'utf8',
  )
  const source = createRosterSource({ binder: createRootBinder({ env: {}, home: join(root, 'home') }) })
  source.bind('lead-1', workspace)
  await source.readyFor('lead-1')
  return source
}

test('a stored succession edge is validated when the record loads', async () => {
  const cases = [
    ['a successor without a target', { successor: { member_id: 'member-2' } }, /successor needs a target/],
    ['a successor without a member id', { successor: { target: 'reviewer-g2' } }, /successor needs a member_id/],
    ['a successor that is not an object', { successor: 'member-2' }, /successor must be an object/],
    ['a predecessor that is not a member id', { predecessor: 42 }, /predecessor must be a non-empty member id/],
  ]
  for (const [label, member, message] of cases) {
    const source = await loadHandWritten(await scratch(), member)
    assert.match(source.report('lead-1').read_problem, message, label)
    assert.deepEqual(readRoster(source.table, 'lead-1').members, [], 'and the record is refused rather than half-served')
  }

  // A record written before this field existed loads exactly as it did.
  const legacy = await loadHandWritten(await scratch(), {})
  assert.equal(legacy.report('lead-1').read_problem, undefined)
  assert.equal(readRoster(legacy.table, 'lead-1').members.length, 1)

  // And an edge naming a member that is not in this record is *legal*, which is the whole reason the check
  // is structural: the record it names may be in the archive (ADR 0030), and a referential check could not
  // tell that apart from a stale edge.
  const dangling = await loadHandWritten(await scratch(), { successor: { target: 'reviewer-g2', member_id: 'member-9' } })
  assert.equal(dangling.report('lead-1').read_problem, undefined)
  assert.deepEqual(
    readRoster(dangling.table, 'lead-1').members[0].successor,
    { target: 'reviewer-g2', member_id: 'member-9' },
  )
})

test('a seeded record carrying a malformed edge is refused, and the root stays empty', async () => {
  const root = await scratch()
  const seed = join(root, 'carried.json')
  await writeFile(
    seed,
    JSON.stringify({ version: 1, serial: 1, rosters: { 'lead-1': stored({ successor: { target: 'reviewer-g2' } }) } }),
    'utf8',
  )
  const workspace = join(root, 'workspace')
  const source = createRosterSource({ binder: createRootBinder({ env: {}, home: join(root, 'home') }), seed })
  source.bind('lead-1', workspace)
  await source.readyFor('lead-1')

  assert.match(source.report('lead-1').read_problem, /successor needs a member_id/, 'the refusal names the field')
  assert.deepEqual(readRoster(source.table, 'lead-1').members, [], 'and nothing half-valid was adopted')
  assert.equal(existsSync(join(workspace, TEAM_DIR, PROVENANCE_FILE_NAME)), false, 'nothing was imported, so nothing is recorded as imported')
})

test('a walk that reaches an archived tombstone stops with the id, and the read says where history is', async () => {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  // Three generations, the two oldest tombstoned with their artifacts provably gone, so the window can
  // archive the oldest one and the walk has to cross that boundary.
  const tombstone = (index, edges) => ({
    memberId: `member-${index}`,
    name: 'reviewer',
    generation: index,
    childId: `child-${index}`,
    label: 'Check the diff',
    phase: PHASE.retired,
    retiredAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    archived: false,
    trashState: TRASH_STATE.pruned,
    trashDir: `child-${index}-${1000 + index}`,
    trashRelPath: join('trash', 'lead-1', `child-${index}-${1000 + index}`),
    originalPath: join('/old', 'sessions', `child-${index}`, 'session.jsonl'),
    ...edges,
  })
  const live = {
    memberId: 'member-3',
    name: 'reviewer',
    generation: 3,
    childId: 'child-3',
    label: 'Check the diff',
    phase: PHASE.active,
    predecessor: 'member-2',
  }
  const roster = {
    leadSessionId: 'lead-1',
    members: [
      tombstone(1, { successor: { target: 'reviewer-g2', member_id: 'member-2' } }),
      tombstone(2, { predecessor: 'member-1', successor: { target: 'reviewer-g3', member_id: 'member-3' } }),
      live,
    ],
  }
  await mkdir(join(workspace, TEAM_DIR), { recursive: true })
  await writeFile(
    join(workspace, TEAM_DIR, ROSTER_FILE_NAME),
    JSON.stringify({ version: 1, serial: 1, updatedAt: 'x', rosters: { 'lead-1': roster } }),
    'utf8',
  )
  // A window of one: the newest tombstone stays, the oldest leaves for the archive. The window is enforced
  // on a write (ADR 0030), so the record is written once before it is read.
  const source = createRosterSource({ binder: createRootBinder({ env: {}, home: join(root, 'home') }), trashLimit: 1 })
  source.bind('lead-1', workspace)
  await source.readyFor('lead-1')
  await updateRoster(source.table, 'lead-1', (current) => ({ ...current }))

  const ctx = fakeCtx()
  const listed = await listMembers(call(ctx, source.table, { dataDir: join(workspace, TEAM_DIR) }))
  const rows = listed.members
  assert.deepEqual(rows.map((row) => row.target).sort(), ['reviewer-g2', 'reviewer-g3'], 'generation 1 left the roster')

  // Forward, from what is left: the tombstone still names the successor it left behind.
  assert.deepEqual(rowById(rows, 'member-2').successor, { target: 'reviewer-g3', member_id: 'member-3' })
  // Backward, from the live member: the first hop resolves, the second stops.
  const second = rowById(rows, 'member-3').predecessor
  assert.deepEqual(second, { target: 'reviewer-g2', member_id: 'member-2' }, 'the hop inside the roster resolves')
  const first = rowById(rows, second.member_id).predecessor
  assert.deepEqual(first, { member_id: 'member-1' }, 'the hop the archive swallowed keeps the id and drops the target')
  assert.equal(rowById(rows, first.member_id), undefined, 'the walk stops there: no row to continue from')

  // The same read says where that id went, and the archive really does hold both halves of the link, so a
  // person reading the file by hand gets the whole chain.
  assert.equal(listed.archived_records, 1)
  assert.equal(listed.archive_file, join(workspace, TEAM_DIR, ARCHIVE_FILE_NAME))
  const archived = (await readFile(listed.archive_file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(archived.length, 1)
  assert.equal(archived[0].member.memberId, 'member-1')
  assert.deepEqual(archived[0].member.successor, { target: 'reviewer-g2', member_id: 'member-2' })
})
