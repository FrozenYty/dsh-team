/**
 * The roster's tombstone window.
 *
 * A tombstone belongs in `roster.json` exactly while its artifact could still exist; past the newest
 * `trashLimit` retirements the retention cap has already removed the bytes, so the record can only answer
 * `pruned` and moves to the append-only archive. The window is derived from that cap so the two cannot
 * drift apart, and a tombstone may only leave the roster when its artifact is on no leg of the chain
 * `restore_member` would search — the filesystem decides, whatever the age.
 *
 * Everything here runs against a bound store in a temporary workspace: the window is a property of the
 * file, so a table fake would not exercise it at all.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listMembers, restoreMember } from '../actions.js'
import { stripRetiredMembers } from '../host-hooks.js'
import {
  ARCHIVE_FILE_NAME,
  ARCHIVE_REASON,
  PHASE,
  TRASH_STATE,
  createRosterSource,
  readRoster,
} from '../roster.js'
import { TEAM_DIR, createRootBinder } from '../trash.js'
import { memoryTable } from './memory-table.mjs'

const LEAD = 'lead-1'
const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-bound-'))

/** One retired record of the shape a retirement writes: it names a trash directory, and its bytes are gone. */
function tombstone(index) {
  const childId = `child-${index}`
  const dirName = `${childId}-${1000 + index}`
  return {
    memberId: `member-${index}`,
    childId,
    name: `member-${index}`,
    label: 'Check the diff',
    generation: 1,
    phase: PHASE.retired,
    retiredAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    archived: false,
    trashState: TRASH_STATE.pruned,
    trashDir: dirName,
    trashRelPath: join('trash', LEAD, dirName),
    originalPath: join('/old', 'sessions', childId, 'session.jsonl'),
  }
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => from + offset)

/** A bound store on a fresh workspace, with the cap the window is derived from. */
async function bound({ trashLimit = 5, records = [] } = {}) {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const binder = createRootBinder({ env: {}, home })
  const source = createRosterSource({ domainTable: memoryTable(), binder, trashLimit, home })
  source.bind(LEAD, workspace)
  await source.readyFor(LEAD)
  const f = {
    root,
    workspace,
    home,
    binder,
    source,
    dataDir: join(workspace, TEAM_DIR),
    archiveFile: join(workspace, TEAM_DIR, ARCHIVE_FILE_NAME),
  }
  if (records.length > 0) await f.source.table.put(LEAD, { leadSessionId: LEAD, members: records })
  return f
}

const archiveLines = async (file) => (existsSync(file) ? (await readFile(file, 'utf8')).trim().split('\n') : [])

/** A context fake carrying what a roster read touches. */
function fakeCtx({ shippedRoster = [] } = {}) {
  const lead = { session: { id: LEAD } }
  const ctx = {
    agentTeams: { listMembers: () => shippedRoster },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => ({ childId: spec.childId }),
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
      getProvider: () => undefined,
    },
    agents: { get: () => undefined },
    get: () => undefined,
  }
  return { ctx, lead }
}

const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

const read = (f) => readRoster(f.source.table, LEAD)

test('the backlog converges in one write: a cap of five leaves five tombstones and archives twenty-five', async () => {
  const f = await bound({ trashLimit: 5, records: range(1, 30).map(tombstone) })
  const roster = read(f)

  assert.equal(roster.members.length, 5, 'the roster holds the newest five')
  assert.deepEqual(roster.members.map((member) => member.name), ['member-26', 'member-27', 'member-28', 'member-29', 'member-30'])
  assert.equal(roster.retiredChildIds.length, 30, 'and every retired child id is kept, archived or not')

  const lines = await archiveLines(f.archiveFile)
  assert.equal(lines.length, 25, 'the other twenty-five are in the archive')
  const rows = lines.map((line) => JSON.parse(line))
  for (const row of rows) {
    assert.equal(row.reason, ARCHIVE_REASON)
    assert.equal(row.leadSessionId, LEAD)
    assert.equal(row.member.phase, PHASE.retired, 'each line is the full tombstone')
    assert.equal(typeof row.archivedAt, 'string')
  }
  assert.deepEqual(
    rows.map((row) => row.member.name).sort(),
    range(1, 25).map((index) => `member-${index}`).sort(),
    'the oldest left, the newest stayed',
  )
})

test('the window follows the configured cap rather than a fixed count', async () => {
  const f = await bound({ trashLimit: 3, records: range(1, 30).map(tombstone) })
  assert.equal(read(f).members.length, 3)
  assert.equal((await archiveLines(f.archiveFile)).length, 27)
})

test('an archived id is still stripped from a session-list payload', async () => {
  const f = await bound({ trashLimit: 5, records: range(1, 30).map(tombstone) })
  // The real hook path, not the archive: the ids the record keeps are what the shipped panels are filtered
  // by, so a member whose tombstone left the roster must still disappear from them.
  const frame = {
    sessions: [{
      id: LEAD,
      subagentCatalog: range(1, 30).map((index) => ({ id: `child-${index}` })),
      agentTeam: { members: [{ id: LEAD }, ...range(1, 30).map((index) => ({ id: `child-${index}` }))] },
    }],
  }
  stripRetiredMembers(frame, new Set(read(f).retiredChildIds))
  assert.deepEqual(frame.sessions[0].subagentCatalog, [], 'every one of the thirty is stripped, archived or not')
  assert.deepEqual(frame.sessions[0].agentTeam.members.map((row) => row.id), [LEAD])
})

test('a tombstone whose artifact still exists stays, whatever the window says', async () => {
  // The window decides when to look; the filesystem decides. This is the safety argument, and it is a
  // condition in the code rather than an intention in a comment.
  const f = await bound({ trashLimit: 1 })
  const kept = join(f.dataDir, 'trash', LEAD, 'child-1-1001')
  await mkdir(kept, { recursive: true })
  await writeFile(join(kept, 'session.jsonl'), 'log\n', 'utf8')
  await f.source.table.put(LEAD, { leadSessionId: LEAD, members: [tombstone(1), tombstone(2)] })

  const roster = read(f)
  assert.equal(roster.members.length, 2, 'the older tombstone is past the window but its artifact is on disk')
  assert.deepEqual(roster.members.map((member) => member.name).sort(), ['member-1', 'member-2'])
  assert.equal(existsSync(f.archiveFile), false, 'and nothing was written to the archive at all')
})

test('writing twice changes nothing the second time', async () => {
  const f = await bound({ trashLimit: 5, records: range(1, 30).map(tombstone) })
  const first = await archiveLines(f.archiveFile)
  const before = read(f).members.map((member) => member.name)

  await f.source.table.update(LEAD, (current) => ({ ...current, handoffTemplate: '{successor} {predecessor} {label} {assignment} {task_board}' }))

  assert.equal((await archiveLines(f.archiveFile)).length, first.length, 'the archive was not appended to again')
  assert.deepEqual(read(f).members.map((member) => member.name), before)
  assert.equal(read(f).handoffTemplate, '{successor} {predecessor} {label} {assignment} {task_board}', 'and the write itself landed')
})

test('a crash between the archive append and the roster write leaves duplicates, not a lost record', async () => {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const archiveFile = join(workspace, TEAM_DIR, ARCHIVE_FILE_NAME)
  const rosterFile = join(workspace, TEAM_DIR, 'roster.json')
  const records = range(1, 30).map(tombstone)

  const crashing = async () => { throw new Error('crash before the rename') }
  const first = createRosterSource({ domainTable: memoryTable(), binder: createRootBinder({ env: {}, home }), trashLimit: 5, home, renameFn: crashing })
  first.bind(LEAD, workspace)
  await first.readyFor(LEAD)
  await assert.rejects(
    () => first.table.put(LEAD, { leadSessionId: LEAD, members: records }),
    /crash before the rename/,
  )
  assert.equal((await archiveLines(archiveFile)).length, 25, 'the records reached the archive before the failure')
  assert.equal(existsSync(rosterFile), false, 'and the roster file was never written')

  // The next write converges: the archive now holds a duplicate line, which an append-only history can
  // carry, where the opposite order would have lost the record entirely.
  const recovering = createRosterSource({ domainTable: memoryTable(), binder: createRootBinder({ env: {}, home }), trashLimit: 5, home })
  recovering.bind(LEAD, workspace)
  await recovering.readyFor(LEAD)
  await recovering.table.put(LEAD, { leadSessionId: LEAD, members: records })
  assert.equal(readRoster(recovering.table, LEAD).members.length, 5)
  assert.equal((await archiveLines(archiveFile)).length, 50, 'twenty-five lines twice: duplicates, not a loss')
})

test('list_members names the archived count and the file it went to', async () => {
  const f = await bound({ trashLimit: 5, records: range(1, 30).map(tombstone) })
  const { ctx, lead } = fakeCtx()
  const listed = await listMembers({ ctx, table: f.source.table, leadSessionId: LEAD, leadAgent: lead, dataDir: f.dataDir, hooks: hooks() })

  assert.equal(listed.members.length, 5)
  assert.equal(listed.archived_records, 25, 'the read says how many records are not in this list')
  assert.equal(listed.archive_file, f.archiveFile)

  // A Lead with nothing archived reports zero and no path: the field is not noise on an ordinary roster.
  const clean = await bound({ trashLimit: 5, records: [tombstone(1)] })
  const other = fakeCtx()
  const listedClean = await listMembers({ ctx: other.ctx, table: clean.source.table, leadSessionId: LEAD, leadAgent: other.lead, dataDir: clean.dataDir, hooks: hooks() })
  assert.equal(listedClean.archived_records, 0)
  assert.equal(Object.hasOwn(listedClean, 'archive_file'), false)
})

test('restore_member on an archived target answers the typed reason and names the archive', async () => {
  const f = await bound({ trashLimit: 5, records: range(1, 30).map(tombstone) })
  const { ctx, lead } = fakeCtx()
  const restored = await restoreMember({
    ctx,
    table: f.source.table,
    leadSessionId: LEAD,
    target: 'member-1',
    hooks: hooks(),
    dataDir: f.dataDir,
  })

  assert.equal(restored.restored, false)
  assert.equal(restored.reason, 'archived')
  assert.equal(restored.target, 'member-1')
  assert.match(restored.message, /archive\.jsonl/, 'the refusal names the file that still holds the record')

  // A target that never existed is still the generic refusal, so the archive lookup does not swallow it.
  await assert.rejects(
    () => restoreMember({ ctx, table: f.source.table, leadSessionId: LEAD, target: 'nobody', hooks: hooks(), dataDir: f.dataDir }),
    /no member named "nobody" in the roster, live or retired/,
  )
})

test('a child whose tombstone is archived is not adopted back as a live member', async () => {
  // The one coupling an archive must not break: the catalog may still list the child, and adoption matches
  // by child id against the roster's members. An archived id that is not "seen" would come back to life.
  const f = await bound({ trashLimit: 1, records: [tombstone(1), tombstone(2)] })
  const { ctx, lead } = fakeCtx({ shippedRoster: [{ id: 'child-1', name: 'member-1', description: 'still in the catalog', role: 'teammate', status: 'active' }] })
  const listed = await listMembers({ ctx, table: f.source.table, leadSessionId: LEAD, leadAgent: lead, dataDir: f.dataDir, hooks: hooks() })

  // The adoption answer first: an archived member that comes back is the failure this test exists for.
  assert.deepEqual(listed.members.map((member) => member.target), ['member-2'], 'the archived member did not come back')
  assert.equal(listed.archived_records, 1)
})
