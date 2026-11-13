/**
 * Reading the archive, and the one thing that must not happen while reading anything else.
 *
 * `archive.jsonl` is load-bearing on a machine that has run this plugin for a while — a tombstone past the
 * trash window lives there and nowhere else — and ADR 0030 keeps it off the hot path: a plain read must not
 * open it, because the archive is unbounded by design and the ordinary read is the one a model makes often.
 * `list_members { archived: true }` is the caller saying "I know this is a file read, do it" (ADR 0035), so
 * every test here is about one of two things: what that read returns, or what it does not cost when nobody
 * asked.
 *
 * The file is one append-only history for every Lead under a data root, so the reader owns four rules the
 * writer cannot: this Lead's lines only, one row per member id, a damaged line counted rather than raised,
 * and a bound on how much of an unbounded file reaches one answer.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listMembers } from '../actions.js'
import { ARCHIVE_FILE_NAME, ARCHIVE_READ_LIMIT, PHASE, TRASH_STATE, planMember } from '../roster.js'
import { memoryTable } from './memory-table.mjs'

const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-archive-read-'))
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })
const lead = { session: { id: 'lead-1' } }

/** The context `list_members` reads: a Lead, no children, and nothing that needs a persistence backend. */
function fakeCtx() {
  const caller = { id: 'lead-1', status: 'idle', session: { id: 'lead-1' } }
  return {
    agents: { list: () => [caller], get: (id) => (id === caller.id ? caller : undefined) },
    agentTeams: { tryMembership: () => undefined, listMembers: () => [] },
    subagents: { listDescendants: async () => [], drainChildren: async () => {}, interrupt: () => {} },
    get: () => undefined,
  }
}

const call = (ctx, table, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: extra.dataDir,
  hooks: hooks(),
  ...extra,
})

/** One stored member, live or tombstoned, with whatever fields the caller is testing. */
function member(fields = {}) {
  return {
    ...planMember({ leadSessionId: 'lead-1', members: [] }, fields.name ?? 'reviewer', 'Check the diff'),
    ...fields,
  }
}

/** Write an archive the way the plugin does: one JSON line per record, in the order they happened. */
async function writeArchive(dataDir, rows) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(
    join(dataDir, ARCHIVE_FILE_NAME),
    rows.map((row) => (typeof row === 'string' ? row : `${JSON.stringify(row)}\n`)).join(''),
    'utf8',
  )
}

/** One archive line: a record that left the roster, for a named Lead, at a named time. */
const line = (leadSessionId, stored, archivedAt) => ({
  archivedAt,
  reason: 'beyond-trash-window',
  leadSessionId,
  member: { ...member(stored), phase: PHASE.retired },
})

test('a plain read is unchanged, and never opens the archive', async () => {
  const dataDir = await scratch()
  const live = member({ name: 'reviewer' })
  await writeArchive(dataDir, [line('lead-1', { memberId: 'member-old', childId: 'child-old', name: 'older' }, '2026-01-01T00:00:00.000Z')])
  const table = memoryTable()
  // The record keeps every retired child id it has ever had, which is how a read that never opens the
  // archive can still say how many tombstones are not in it (`retiredChildIds`, ADR 0030).
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [live], retiredChildIds: ['child-old'] })

  const plain = await listMembers(call(fakeCtx(), table, { dataDir }))
  // The spy first, rather than an assertion about output: the seam throws if it is touched at all, so the
  // plain path is proved not to open the file rather than inferred not to from what it returned.
  let opened = 0
  const spy = () => { opened += 1; throw new Error('the archive was opened by a plain read') }
  const spied = await listMembers(call(fakeCtx(), table, { dataDir, readArchive: spy }))
  assert.equal(opened, 0, 'the plain read called the archive reader zero times')
  assert.deepEqual(spied.members.map((row) => row.target), ['reviewer'], 'and answered the same thing')

  assert.deepEqual(plain.members.map((row) => row.target), ['reviewer'], 'the archived record is not in a plain read')
  assert.equal(plain.archived_records, 1, 'the roster still says one tombstone is elsewhere')
  assert.equal(plain.archived_returned, undefined, 'and nothing was returned from the file')
  assert.equal(plain.archived_total, undefined)

  // The other direction: the flag is what calls it, so the same spy fails the flagged read.
  await assert.rejects(
    listMembers(call(fakeCtx(), table, { dataDir, readArchive: spy, archived: true })),
    /the archive was opened by a plain read/,
  )
  assert.equal(opened, 1, 'the flagged read is the one that called it')
})

test('the flag adds this Lead\'s archived tombstone, marked, with when it was archived', async () => {
  const dataDir = await scratch()
  const mine = {
    memberId: 'member-old',
    childId: 'child-old',
    name: 'older',
    label: 'Check the old diff',
    generation: 1,
    trashDir: 'child-old-1001',
    trashRelPath: 'trash/lead-1/child-old-1001',
    trashKind: 'directory',
    trashState: TRASH_STATE.done,
  }
  await writeArchive(dataDir, [
    line('lead-1', mine, '2026-02-01T10:00:00.000Z'),
    // Another Lead's history: the archive is one file for every Lead in the data root.
    line('lead-2', { memberId: 'member-other', childId: 'child-other', name: 'someone-else' }, '2026-02-02T10:00:00.000Z'),
  ])
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true }))
  const archivedRows = listed.members.filter((row) => row.archived === true)
  assert.equal(archivedRows.length, 1, 'exactly the archived tombstone of this Lead')
  assert.equal(archivedRows[0].target, 'older')
  assert.equal(archivedRows[0].member_id, 'member-old')
  assert.equal(archivedRows[0].child_id, 'child-old')
  assert.equal(archivedRows[0].phase, PHASE.retired)
  assert.equal(archivedRows[0].archived_at, '2026-02-01T10:00:00.000Z', 'and when it left the roster')
  assert.equal(listed.members.some((row) => row.target === 'someone-else'), false, 'another Lead\'s record never appears')
  assert.equal(listed.archived_returned, 1)
  assert.equal(listed.archived_total, 1)
  assert.equal(listed.archive_file, join(dataDir, ARCHIVE_FILE_NAME), 'the answer names the file it read')
  // The rows of the roster are untouched by the flag: same targets, and none of them marked.
  assert.equal(listed.members.filter((row) => row.archived !== true).map((row) => row.target).join(','), 'reviewer')
})

test('two lines for one member, which is the crash window, yield one row', async () => {
  const dataDir = await scratch()
  const stored = { memberId: 'member-dup', childId: 'child-dup', name: 'twice', trashDir: 'child-dup-1001', trashState: TRASH_STATE.done }
  // Appended before the roster was replaced, so a crash between the two writes the same record twice: the
  // design accepts the duplicate line, and the reader is what makes it harmless.
  await writeArchive(dataDir, [
    line('lead-1', stored, '2026-03-01T00:00:00.000Z'),
    line('lead-1', stored, '2026-03-01T00:00:05.000Z'),
  ])
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [] })

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true }))
  const rows = listed.members.filter((row) => row.archived === true)
  assert.equal(rows.length, 1, 'one row for one member id')
  assert.equal(listed.archived_total, 1, 'and the total counts members, not lines')
  assert.equal(rows[0].archived_at, '2026-03-01T00:00:05.000Z', 'the surviving row is the newest line for it')
})

test('a truncated last line is counted, not raised', async () => {
  const dataDir = await scratch()
  const first = line('lead-1', { memberId: 'member-a', childId: 'child-a', name: 'first' }, '2026-04-01T00:00:00.000Z')
  const second = line('lead-1', { memberId: 'member-b', childId: 'child-b', name: 'second' }, '2026-04-02T00:00:00.000Z')
  // The crash mid-append: the last line stops in the middle of the JSON.
  const partial = JSON.stringify(line('lead-1', { memberId: 'member-c', childId: 'child-c', name: 'third' }, '2026-04-03T00:00:00.000Z')).slice(0, 60)
  await writeArchive(dataDir, [first, second, partial])
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [] })

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true }))
  assert.deepEqual(listed.members.filter((row) => row.archived === true).map((row) => row.target), ['first', 'second'], 'the intact rows are served')
  assert.equal(listed.archived_total, 2)
  assert.equal(listed.archived_unreadable, 1, 'and the reader says how much it had to skip')
})

test('more archived records than the cap yields the newest ones and the real total', async () => {
  const dataDir = await scratch()
  const rows = []
  for (let index = 0; index < ARCHIVE_READ_LIMIT + 5; index += 1) {
    rows.push(line('lead-1', {
      memberId: `member-${String(index).padStart(3, '0')}`,
      childId: `child-${String(index).padStart(3, '0')}`,
      name: `member-${index}`,
    }, `2026-05-01T00:00:${String(index).padStart(2, '0')}.000Z`))
  }
  await writeArchive(dataDir, rows)
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [] })

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true }))
  const archived = listed.members.filter((row) => row.archived === true)
  assert.equal(archived.length, ARCHIVE_READ_LIMIT, 'the answer carries the cap, not the file')
  assert.equal(listed.archived_returned, ARCHIVE_READ_LIMIT)
  assert.equal(listed.archived_total, ARCHIVE_READ_LIMIT + 5, 'the real total, so the bound is visible')
  assert.equal(archived[0].target, 'member-5', 'and what it carries is the newest: the tail of an append-only file')
  assert.equal(archived[archived.length - 1].target, `member-${ARCHIVE_READ_LIMIT + 4}`)
})

test('an edge into the archive resolves with the flag and stays a bare id without it', async () => {
  const dataDir = await scratch()
  const predecessor = { memberId: 'member-gone', childId: 'child-gone', name: 'predecessor' }
  await writeArchive(dataDir, [line('lead-1', predecessor, '2026-06-01T00:00:00.000Z')])
  const table = memoryTable()
  // The successor is live and names the member it took over from; that member's record is in the archive.
  await table.put('lead-1', {
    leadSessionId: 'lead-1',
    members: [member({ memberId: 'member-now', childId: 'child-now', name: 'reviewer', predecessor: 'member-gone' })],
  })

  const plain = await listMembers(call(fakeCtx(), table, { dataDir }))
  assert.deepEqual(plain.members[0].predecessor, { member_id: 'member-gone' }, 'without the flag the id stands alone (ADR 0030)')

  const flagged = await listMembers(call(fakeCtx(), table, { dataDir, archived: true }))
  assert.deepEqual(flagged.members[0].predecessor, { target: 'predecessor', member_id: 'member-gone' }, 'with the flag the target is read back')
  // And the other direction: the archived row's own link to the successor resolves from the roster.
  const archivedRow = flagged.members.find((row) => row.archived === true)
  assert.deepEqual(archivedRow.successor, undefined, 'this member was retired without a successor, so it carries no reverse edge')
})

test('a missing archive file is not an error: the flag asks for something that may not exist', async () => {
  const dataDir = await scratch()
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true }))
  assert.deepEqual(listed.members.map((row) => row.target), ['reviewer'])
  assert.equal(listed.archived_returned, 0)
  assert.equal(listed.archived_total, 0)
  assert.equal(listed.archived_unreadable, undefined, 'nothing was damaged, so nothing is reported as damaged')
  assert.equal(listed.archive_file, undefined, 'and no path is claimed for a file that is not there')
})

test('a lookup by target returns exactly that record, and by member id the same one', async () => {
  const dataDir = await scratch()
  await writeArchive(dataDir, [
    line('lead-1', { memberId: 'member-old', childId: 'child-old', name: 'older', generation: 2 }, '2026-08-01T00:00:00.000Z'),
    line('lead-1', { memberId: 'member-other', childId: 'child-other', name: 'other', generation: 1 }, '2026-08-02T00:00:00.000Z'),
  ])
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })

  // The target form an edge's `successor.target` carries, and the id form its `member_id` carries.
  for (const [looked, label] of [['older-g2', 'a target'], ['member-old', 'a member id']]) {
    const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true, archivedTarget: looked }))
    const archivedRows = listed.members.filter((row) => row.archived === true)
    assert.equal(archivedRows.length, 1, `one record by ${label}`)
    assert.equal(listed.archived_returned, 1)
    assert.equal(archivedRows[0].target, 'older-g2')
    assert.equal(archivedRows[0].member_id, 'member-old')
    assert.equal(archivedRows[0].archived_at, '2026-08-01T00:00:00.000Z')
    assert.equal(listed.archived_total, 2, 'the total is the whole history, unchanged by the lookup')
    assert.equal(listed.archived_scanned, 2, 'and the scan says what it read')
    assert.deepEqual(listed.members.filter((row) => row.archived !== true).map((row) => row.target), ['reviewer'], 'the roster rows are still there')
  }
})

test('a miss is an answer: the line count, the target and the total, never an empty success', async () => {
  const dataDir = await scratch()
  await writeArchive(dataDir, [
    line('lead-1', { memberId: 'member-a', childId: 'child-a', name: 'first' }, '2026-08-01T00:00:00.000Z'),
    line('lead-1', { memberId: 'member-b', childId: 'child-b', name: 'second' }, '2026-08-02T00:00:00.000Z'),
    // Another Lead's line is scanned but is not part of this Lead's answer; the count is the cost of the
    // scan, which is what the caller needs to tell a real miss from a file that was never read.
    line('lead-2', { memberId: 'member-z', childId: 'child-z', name: 'elsewhere' }, '2026-08-03T00:00:00.000Z'),
  ])
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true, archivedTarget: 'nobody-g3' }))
  assert.equal(listed.archived_returned, 0, 'nothing was returned')
  assert.equal(listed.archived_total, 2, 'but the history this Lead has is named')
  assert.equal(listed.archived_scanned, 3, 'and how much of the file was read to say so')
  assert.match(listed.message, /nothing in .*matches "nobody-g3"/i, 'the message names the target it looked for')
  assert.match(listed.message, /3 line\(s\) scanned/, 'and the work it did')
  assert.match(listed.message, /2 archived record\(s\) for this Lead/, 'and that the archive is not empty')
  assert.equal(listed.members.filter((row) => row.archived === true).length, 0)
})

test('archived_target without archived: true is refused by name, and nothing is read', async () => {
  const dataDir = await scratch()
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [member()] })
  // Both seams throw if touched: the refusal must come from the arguments, not from a read that happened
  // first and was then reported as an error.
  const touched = () => { throw new Error('the archive was opened before the arguments were checked') }
  await assert.rejects(
    listMembers(call(fakeCtx(), table, { dataDir, archivedTarget: 'older-g2', readArchive: touched, findArchive: touched })),
    (error) => {
      assert.match(error.message, /archived_target/, 'the refusal names the parameter')
      assert.match(error.message, /archived: true/, 'and the one it belongs with')
      assert.match(error.message, /"older-g2"/, 'and the value it was given')
      return true
    },
  )
})

test('a record older than the cap is still reachable by target', async () => {
  const dataDir = await scratch()
  const rows = []
  for (let index = 0; index < ARCHIVE_READ_LIMIT + 5; index += 1) {
    rows.push(line('lead-1', {
      memberId: `member-${String(index).padStart(3, '0')}`,
      childId: `child-${String(index).padStart(3, '0')}`,
      name: `member-${index}`,
      generation: 1,
    }, `2026-09-01T00:00:${String(index).padStart(2, '0')}.000Z`))
  }
  await writeArchive(dataDir, rows)
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [] })

  // The oldest record is beyond the newest ARCHIVE_READ_LIMIT, so the capped read cannot serve it — which is
  // the whole reason the lookup exists (ADR 0036).
  const capped = await listMembers(call(fakeCtx(), table, { dataDir, archived: true }))
  assert.equal(capped.members.some((row) => row.target === 'member-0'), false, 'the window does not reach it')

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true, archivedTarget: 'member-0' }))
  const archivedRows = listed.members.filter((row) => row.archived === true)
  assert.equal(archivedRows.length, 1)
  assert.equal(archivedRows[0].target, 'member-0')
  assert.equal(listed.archived_returned, 1)
  assert.equal(listed.archived_total, ARCHIVE_READ_LIMIT + 5)
  assert.equal(listed.archived_scanned, ARCHIVE_READ_LIMIT + 5, 'the lookup read the whole file and says so')
})

test('a lookup matches identity, never prose', async () => {
  const dataDir = await scratch()
  // A record whose own words mention the target a caller might look for. `retireReason` and `label` are
  // prose; the member is `scribe`, and no `reviewer-g2` record exists, so this must be a miss.
  await writeArchive(dataDir, [
    line('lead-1', {
      memberId: 'member-scribe',
      childId: 'child-scribe',
      name: 'scribe',
      generation: 1,
      label: 'Replaced by reviewer-g2',
      retireReason: 'Replaced by reviewer-g2',
    }, '2026-10-01T00:00:00.000Z'),
  ])
  const table = memoryTable()
  await table.put('lead-1', { leadSessionId: 'lead-1', members: [] })

  const listed = await listMembers(call(fakeCtx(), table, { dataDir, archived: true, archivedTarget: 'reviewer-g2' }))
  assert.equal(listed.archived_returned, 0, 'a sentence is not an identity')
  assert.equal(listed.members.filter((row) => row.archived === true).length, 0)
  assert.match(listed.message, /reviewer-g2/)
  // And the generation is part of the identity: the same name at another generation is not a match either.
  const wrongGeneration = await listMembers(call(fakeCtx(), table, { dataDir, archived: true, archivedTarget: 'scribe-g2' }))
  assert.equal(wrongGeneration.archived_returned, 0, 'scribe is generation one, so scribe-g2 does not name it')
  const rightGeneration = await listMembers(call(fakeCtx(), table, { dataDir, archived: true, archivedTarget: 'scribe' }))
  assert.equal(rightGeneration.archived_returned, 1, 'while the bare name answers generation one')
})
