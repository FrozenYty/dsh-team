/**
 * The roster file this plugin owns.
 *
 * The storage domain is the import source and the rollback path; the bytes live at the workspace root
 * the Lead is bound to. Every test here is one acceptance statement of T2, and the import test runs on a
 * verbatim copy of the real domain file (`tests/fixtures/team_roster.json`) rather than on a fixture
 * invented for the purpose — the numbers it asserts are the ones the plan measured on the live data.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  IMPORT_MARKER_NAME,
  PHASE,
  ROSTER_FILE_NAME,
  createRosterSource,
  planMember,
  readRoster,
  updateRoster,
} from '../roster.js'
import { TEAM_DIR, createRootBinder } from '../trash.js'

const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-store-'))

/** The real domain, copied verbatim: 2 Leads, 110 records, 94 of them carrying a trash path. */
const FIXTURE = new URL('./fixtures/team_roster.json', import.meta.url)
const REAL_LEAD = 'session-83a0217f-450d-41db-9fb1-b78e4ff9ecc4'
const OTHER_LEAD = 'session-bb909ae6-0d64-415a-ac99-510dff3b74c2'

/**
 * A storage-domain fake with the table methods the store may reach, and a count of the writes, because
 * half of these tests are about the domain *not* being written to.
 */
function domainTable(records = {}) {
  const rows = new Map(Object.entries(records))
  const writes = { put: 0, update: 0 }
  return {
    writes,
    get: (key) => rows.get(key),
    put: async (key, value) => {
      writes.put += 1
      rows.set(key, value)
    },
    update: async (key, mutate) => {
      if (!rows.has(key)) throw new Error(`no record "${key}" to update`)
      writes.update += 1
      const next = mutate(rows.get(key))
      rows.set(key, next)
      return next
    },
    entries: () => rows.entries(),
  }
}

/** The copied real domain as a domain table. */
async function realDomain() {
  const parsed = JSON.parse(await readFile(FIXTURE, 'utf8'))
  return domainTable(parsed.tables.rosters)
}

/** One valid member record, shaped by the same planner a spawn uses. */
function member(overrides = {}) {
  return { ...planMember({ leadSessionId: 'lead-1', members: [] }, 'reviewer', 'Check the diff'), ...overrides }
}

/** A binder whose configured-root override is never set, so the workspace decides. */
const workspaceBinder = (home) => createRootBinder({ env: {}, home })

test('a new Lead\'s data lands under the workspace and nothing new is written under the home directory', async () => {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const source = createRosterSource({ domainTable: domainTable(), binder: workspaceBinder(home) })

  assert.equal(source.bind('lead-1', workspace), join(workspace, TEAM_DIR), 'the root is the workspace\'s own directory')
  await source.readyFor('lead-1')
  await updateRoster(source.table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [member()] }))

  const file = join(workspace, TEAM_DIR, ROSTER_FILE_NAME)
  assert.equal(existsSync(file), true, 'the roster is a file this plugin owns, under the workspace')
  assert.equal(readRoster(source.table, 'lead-1').members.length, 1)
  assert.equal(existsSync(home), false, 'nothing new is written under the user\'s home directory')
  assert.deepEqual(source.report('lead-1'), { source: 'file', path: file })
})

test('the real domain imports once, and the marker records what came across', async () => {
  const parsed = JSON.parse(await readFile(FIXTURE, 'utf8'))
  const rosters = parsed.tables.rosters
  // The fixture is the live file, so these are the measured numbers of the plan's §1 and §2, not invented.
  assert.deepEqual(Object.keys(rosters).sort(), [OTHER_LEAD, REAL_LEAD].sort())
  assert.equal(rosters[REAL_LEAD].members.length, 100)
  assert.equal(rosters[REAL_LEAD].members.filter((entry) => entry.phase === PHASE.retired).length, 95)
  assert.equal(rosters[REAL_LEAD].tasks.length, 3)
  assert.equal(rosters[OTHER_LEAD].members.length, 10)

  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const domain = await realDomain()
  const source = createRosterSource({ domainTable: domain, binder: workspaceBinder(home) })
  source.bind(REAL_LEAD, workspace)
  await source.readyFor(REAL_LEAD)

  const imported = readRoster(source.table, REAL_LEAD)
  assert.equal(imported.members.length, 100, 'every record came across')
  assert.equal(imported.members.filter((entry) => entry.phase === PHASE.retired).length, 95)
  assert.equal(imported.tasks.length, 3)
  assert.deepEqual(domain.writes, { put: 0, update: 0 }, 'the domain is the source, never the destination')

  const marker = JSON.parse(await readFile(join(workspace, TEAM_DIR, IMPORT_MARKER_NAME), 'utf8'))
  assert.equal(marker.source, 'team_roster', 'the marker names the domain it came from')
  assert.equal(marker.leads[REAL_LEAD].members, 100)
  assert.equal(marker.leads[REAL_LEAD].tasks, 3)
  assert.equal(typeof marker.leads[REAL_LEAD].importedAt, 'string', 'and when it was imported')
  assert.equal(source.report(REAL_LEAD).imported_at, marker.leads[REAL_LEAD].importedAt)

  // The import is one-time because the file is now the record: a second load with an empty domain still
  // serves the Lead, which is only possible if the records came from the file.
  const second = createRosterSource({ domainTable: domainTable(), binder: workspaceBinder(home) })
  second.bind(REAL_LEAD, workspace)
  await second.readyFor(REAL_LEAD)
  assert.equal(readRoster(second.table, REAL_LEAD).members.length, 100, 'read from the file, with no domain at all')
})

test('with the roster file deleted the domain is the source again, and the plugin keeps working', async () => {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const file = join(workspace, TEAM_DIR, ROSTER_FILE_NAME)
  const first = createRosterSource({ domainTable: await realDomain(), binder: workspaceBinder(home) })
  first.bind(REAL_LEAD, workspace)
  await first.readyFor(REAL_LEAD)
  assert.equal(existsSync(file), true)

  // Rollback is one deletion: the domain is never written and never deleted, so it is still the source.
  await rm(file)
  const second = createRosterSource({ domainTable: await realDomain(), binder: workspaceBinder(home) })
  second.bind(REAL_LEAD, workspace)
  await second.readyFor(REAL_LEAD)
  assert.equal(readRoster(second.table, REAL_LEAD).members.length, 100, 'served from the domain again')

  await updateRoster(second.table, REAL_LEAD, (roster) => ({ ...roster, handoffTemplate: '{successor} {predecessor} {label} {assignment} {task_board}' }))
  assert.equal(readRoster(second.table, REAL_LEAD).handoffTemplate, '{successor} {predecessor} {label} {assignment} {task_board}')
  assert.equal(existsSync(file), true, 'and the file is written again from there')
})

test('a roster file that cannot be used falls back to the domain instead of throwing', async () => {
  const root = await scratch()
  const home = join(root, 'home')

  // Half a JSON document: what a write interrupted by a power cut leaves behind.
  const truncated = join(root, 'truncated', TEAM_DIR)
  await mkdir(truncated, { recursive: true })
  await writeFile(join(truncated, ROSTER_FILE_NAME), '{"version":1,"serial":4,"rosters":{"lead-1":')
  const source = createRosterSource({ domainTable: await realDomain(), binder: workspaceBinder(home) })
  source.bind(REAL_LEAD, join(root, 'truncated'))
  await source.readyFor(REAL_LEAD)
  assert.equal(readRoster(source.table, REAL_LEAD).members.length, 100, 'the domain answers instead')
  assert.match(source.report(REAL_LEAD).read_problem, /not valid JSON/)
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(join(truncated, ROSTER_FILE_NAME), 'utf8')).rosters),
    [REAL_LEAD],
    'and the file is rebuilt from what the domain served',
  )

  // A complete document holding one record the loader refuses: the domain refuses the whole file rather
  // than putting a malformed record in front of every tool, and this does the same.
  const invalid = join(root, 'invalid', TEAM_DIR)
  await mkdir(invalid, { recursive: true })
  await writeFile(join(invalid, ROSTER_FILE_NAME), JSON.stringify({
    version: 1,
    serial: 2,
    rosters: { 'lead-9': { leadSessionId: 'lead-9', members: 'not an array' } },
  }))
  const other = createRosterSource({ domainTable: await realDomain(), binder: workspaceBinder(home) })
  other.bind(REAL_LEAD, join(root, 'invalid'))
  await other.readyFor(REAL_LEAD)
  assert.equal(readRoster(other.table, REAL_LEAD).members.length, 100)
  assert.match(other.report(REAL_LEAD).read_problem, /record "lead-9" is invalid/)
})

test('a crash between the temporary write and the rename leaves the previous file intact', async () => {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const directory = join(workspace, TEAM_DIR)
  await mkdir(directory, { recursive: true })
  const file = join(directory, ROSTER_FILE_NAME)
  const seeded = JSON.stringify({
    version: 1,
    serial: 7,
    updatedAt: '2026-11-13T00:00:00.000Z',
    rosters: { 'lead-1': { leadSessionId: 'lead-1', members: [member()] } },
  })
  await writeFile(file, seeded)

  const crashing = createRosterSource({
    domainTable: domainTable(),
    binder: workspaceBinder(join(root, 'home')),
    renameFn: async () => { throw new Error('crash between the write and the rename') },
  })
  crashing.bind('lead-1', workspace)
  await crashing.readyFor('lead-1')
  await assert.rejects(
    () => updateRoster(crashing.table, 'lead-1', (roster) => ({ ...roster, handoffTemplate: '{successor} {predecessor} {label} {assignment} {task_board}' })),
    /crash between the write and the rename/,
  )

  assert.equal(await readFile(file, 'utf8'), seeded, 'the previous file is exactly as it was')
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false, 'the temporary file is cleaned up')
  assert.equal(readRoster(crashing.table, 'lead-1').handoffTemplate, undefined, 'and the failed change was not committed')
})

test('moving the folder and pointing the configured root at it changes no record', async () => {
  const root = await scratch()
  const home = join(root, 'home')
  const first = createRosterSource({ domainTable: domainTable(), binder: workspaceBinder(home) })
  first.bind('lead-1', join(root, 'ws-a'))
  await first.readyFor('lead-1')
  await updateRoster(first.table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [member()] }))

  const fileA = join(root, 'ws-a', TEAM_DIR, ROSTER_FILE_NAME)
  const before = await readFile(fileA, 'utf8')
  const moved = join(root, 'moved-team')
  await rename(join(root, 'ws-a', TEAM_DIR), moved)

  // The operator moved the folder and pointed a profile at it. The working directory is now somewhere
  // else entirely; the configured root is the answer, and no record has to be rewritten to follow it.
  const binder = createRootBinder({ env: { DSH_TEAM_DATA_DIR: moved }, home })
  const moved_ = createRosterSource({ domainTable: domainTable(), binder })
  assert.equal(moved_.bind('lead-1', join(root, 'ws-b')), moved, 'the configured root outranks the working directory')
  await moved_.readyFor('lead-1')
  assert.equal(readRoster(moved_.table, 'lead-1').members.length, 1, 'the records came with the folder')
  assert.equal(await readFile(join(moved, ROSTER_FILE_NAME), 'utf8'), before, 'and nothing was rewritten')
  assert.equal(existsSync(join(root, 'ws-a', TEAM_DIR)), false)

  // The pre-rename spelling of the same variable is a frozen contract (ADR 0014), not a fallback.
  const legacy = createRootBinder({ env: { DSH_TEAM_ROSTER_DATA_DIR: moved }, home })
  assert.equal(legacy.bind('lead-1', join(root, 'ws-b')), moved)
})

test('a Lead keeps the root it bound when its working directory changes mid-session', async () => {
  const root = await scratch()
  const home = join(root, 'home')
  const binder = workspaceBinder(home)
  const bound = binder.bind('lead-1', join(root, 'ws-a'))
  assert.equal(bound, join(root, 'ws-a', TEAM_DIR))

  // `working_directory` is a tool: the same Lead names a second directory later in the same session.
  assert.equal(binder.bind('lead-1', join(root, 'ws-b')), bound, 'the bound root does not move')
  assert.equal(binder.rootOf('lead-1'), bound)

  const source = createRosterSource({ domainTable: domainTable(), binder })
  await source.readyFor('lead-1')
  await updateRoster(source.table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [member()] }))
  assert.equal(readRoster(source.table, 'lead-1').members.length, 1, 'its data is where it bound it')
  assert.equal(existsSync(join(root, 'ws-b', TEAM_DIR)), false, 'the second directory was never written to')

  // A binding is per Lead Session: the second Lead is not dragged to the first one's root.
  assert.equal(binder.bind('lead-2', join(root, 'ws-b')), join(root, 'ws-b', TEAM_DIR))
})

test('a change this process did not write is merged, and reported as a second writer', async () => {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const source = createRosterSource({ domainTable: domainTable(), binder: workspaceBinder(home) })
  source.bind('lead-1', workspace)
  await source.readyFor('lead-1')
  await updateRoster(source.table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [member()] }))
  const file = join(workspace, TEAM_DIR, ROSTER_FILE_NAME)

  // The second writer: another process, opening the same workspace's file.
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({
    ...onDisk,
    serial: onDisk.serial + 1,
    updatedAt: '2026-11-13T09:00:00.000Z',
    rosters: { ...onDisk.rosters, 'lead-2': { leadSessionId: 'lead-2', members: [member({ memberId: 'other' })] } },
  }))

  await updateRoster(source.table, 'lead-1', (roster) => ({ ...roster, handoffTemplate: '{successor} {predecessor} {label} {assignment} {task_board}' }))

  const after = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(after.rosters['lead-2'].members.length, 1, 'the other writer\'s record survived the merge')
  assert.equal(after.rosters['lead-1'].handoffTemplate, '{successor} {predecessor} {label} {assignment} {task_board}')
  assert.equal(source.report('lead-1').foreign_write_at, '2026-11-13T09:00:00.000Z', 'and the second writer is reported')
  assert.match(source.report('lead-1').message, /one writer per workspace/)
})

test('a Session with no workspace keeps using the domain, which is the rollback path', async () => {
  const root = await scratch()
  const home = join(root, 'home')
  const domain = await realDomain()
  const source = createRosterSource({ domainTable: domain, binder: workspaceBinder(home) })

  assert.equal(source.bind(REAL_LEAD, undefined), undefined, 'no workspace, no root to own')
  await source.readyFor(REAL_LEAD)
  assert.equal(readRoster(source.table, REAL_LEAD).members.length, 100, 'the domain still answers')
  assert.equal(source.report(REAL_LEAD).source, 'storage-domain')
  assert.equal(existsSync(home), false, 'and the frozen pre-move directory is not a write target')

  await updateRoster(source.table, REAL_LEAD, (roster) => ({ ...roster, handoffTemplate: '{successor} {predecessor} {label} {assignment} {task_board}' }))
  assert.equal(domain.writes.update > 0 || domain.writes.put > 0, true, 'the write went to the domain, as it did before this change')
  assert.equal(existsSync(home), false)
})
