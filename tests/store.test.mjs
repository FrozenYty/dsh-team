/**
 * The roster file this plugin owns.
 *
 * The bytes live at the root the Lead is bound to. There is no host storage domain behind them any more
 * (ADR 0031), so nothing here passes a fake domain table: a profile whose records lived only in a domain
 * file points `DSH_TEAM_SEED` at it, and the strongest test this file has is that the real dump — the
 * verbatim copy of what the domain held, `tests/fixtures/team_roster.json` — seeds a new root through that
 * escape hatch, with the numbers the plan measured on the live data.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ARCHIVE_FILE_NAME,
  ARCHIVE_REASON,
  PHASE,
  PROVENANCE_FILE_NAME,
  PROVENANCE_SOURCE,
  ROSTER_FILE_NAME,
  createRosterSource,
  planMember,
  readRoster,
  updateRoster,
} from '../roster.js'
import { TEAM_DIR, createRootBinder } from '../trash.js'

const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-store-'))

/** The real domain's contents, copied verbatim: 2 Leads, 110 records, 94 of them carrying a trash path. */
const FIXTURE = new URL('./fixtures/team_roster.json', import.meta.url)
const REAL_LEAD = 'session-83a0217f-450d-41db-9fb1-b78e4ff9ecc4'
const OTHER_LEAD = 'session-bb909ae6-0d64-415a-ac99-510dff3b74c2'

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
  const source = createRosterSource({ binder: workspaceBinder(home) })

  assert.equal(source.bind('lead-1', workspace), join(workspace, TEAM_DIR), 'the root is the workspace\'s own directory')
  await source.readyFor('lead-1')
  await updateRoster(source.table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: [member()] }))

  const file = join(workspace, TEAM_DIR, ROSTER_FILE_NAME)
  assert.equal(existsSync(file), true, 'the roster is a file this plugin owns, under the workspace')
  assert.equal(readRoster(source.table, 'lead-1').members.length, 1)
  assert.equal(existsSync(home), false, 'nothing new is written under the user\'s home directory')
  assert.deepEqual(source.report('lead-1'), { source: 'file', path: file })
})

test('the real domain dump seeds a new root through the escape hatch, and the marker records what came across', async () => {
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
  // The domain's own shape, read as a seed: the file the user still has is not stranded data.
  // `home` is passed so the artifact chain's frozen leg reads this fixture, not the machine's real trash
  // directory: the fixture's records carry absolute paths from the live machine.
  const source = createRosterSource({ binder: workspaceBinder(home), home, seed: fileURLToPath(FIXTURE) })
  source.bind(REAL_LEAD, workspace)
  await source.readyFor(REAL_LEAD)

  const imported = readRoster(source.table, REAL_LEAD)
  // The import is a write, so it is bounded like any other: the window keeps the newest 20 tombstones and
  // the 5 live members, and the one tombstone that names no trash destination cannot be archived at all.
  assert.equal(imported.members.length, 26, 'the import is bounded, not the whole backlog')
  assert.equal(imported.members.filter((entry) => entry.phase === PHASE.retired).length, 21)
  assert.equal(imported.tasks.length, 3)
  assert.equal(imported.retiredChildIds.length, 95, 'every retired id is kept, archived or not')

  const archived = (await readFile(join(workspace, TEAM_DIR, ARCHIVE_FILE_NAME), 'utf8')).trim().split('\n')
  assert.equal(archived.length, 74, 'the 74 tombstones past the window are in the archive')
  assert.equal(JSON.parse(archived[0]).reason, ARCHIVE_REASON)
  assert.equal(JSON.parse(archived[0]).leadSessionId, REAL_LEAD)
  assert.equal(JSON.parse(archived[0]).member.phase, PHASE.retired, 'each line is the full tombstone')

  const marker = JSON.parse(await readFile(join(workspace, TEAM_DIR, PROVENANCE_FILE_NAME), 'utf8'))
  assert.equal(marker.source, PROVENANCE_SOURCE.seed, 'the marker names the seed it came from')
  assert.equal(marker.path, fileURLToPath(FIXTURE), 'and the path, because that is what a reader needs to check')
  assert.equal(marker.leads[REAL_LEAD].members, 100, 'and records what came across, not what the window kept')
  assert.equal(marker.leads[REAL_LEAD].tasks, 3)
  assert.equal(typeof marker.leads[REAL_LEAD].importedAt, 'string', 'and when it was imported')
  assert.equal(source.report(REAL_LEAD).imported_at, marker.leads[REAL_LEAD].importedAt)

  // The import is one-time because the file is now the record: a second load with no seed at all still
  // serves the Lead, which is only possible if the records came from the file.
  const second = createRosterSource({ binder: workspaceBinder(home), home })
  second.bind(REAL_LEAD, workspace)
  await second.readyFor(REAL_LEAD)
  assert.equal(readRoster(second.table, REAL_LEAD).members.length, 26, 'read from the file, with no seed and no domain')
})

test('with the roster file deleted the seed refills a new root, and the plugin keeps working', async () => {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const file = join(workspace, TEAM_DIR, ROSTER_FILE_NAME)
  const seed = fileURLToPath(FIXTURE)
  const first = createRosterSource({ binder: workspaceBinder(home), home, seed })
  first.bind(REAL_LEAD, workspace)
  await first.readyFor(REAL_LEAD)
  assert.equal(existsSync(file), true)

  // Rollback is one deletion: the seed is read again, so the root is not left empty.
  await rm(file)
  const second = createRosterSource({ binder: workspaceBinder(home), home, seed })
  second.bind(REAL_LEAD, workspace)
  await second.readyFor(REAL_LEAD)
  assert.equal(readRoster(second.table, REAL_LEAD).members.length, 26, 'seeded again, bounded again')

  await updateRoster(second.table, REAL_LEAD, (roster) => ({ ...roster, handoffTemplate: '{successor} {predecessor} {label} {assignment} {task_board}' }))
  assert.equal(readRoster(second.table, REAL_LEAD).handoffTemplate, '{successor} {predecessor} {label} {assignment} {task_board}')
  assert.equal(existsSync(file), true, 'and the file is written again from there')
})

test('a roster file that cannot be used is reported, and the root stays usable', async () => {
  const root = await scratch()
  const home = join(root, 'home')

  // Half a JSON document: what a write interrupted by a power cut leaves behind.
  const truncated = join(root, 'truncated', TEAM_DIR)
  await mkdir(truncated, { recursive: true })
  await writeFile(join(truncated, ROSTER_FILE_NAME), '{"version":1,"serial":4,"rosters":{"lead-1":')
  const source = createRosterSource({ binder: workspaceBinder(home), home, seed: fileURLToPath(FIXTURE) })
  source.bind(REAL_LEAD, join(root, 'truncated'))
  await source.readyFor(REAL_LEAD)
  assert.match(source.report(REAL_LEAD).read_problem, /not valid JSON/, 'the file is reported rather than ignored')
  assert.deepEqual(readRoster(source.table, REAL_LEAD).members, [], 'and a file that exists is the root: the seed does not overwrite it')
  // A write repairs it, so the Lead keeps working from an empty roster rather than being stuck.
  await updateRoster(source.table, REAL_LEAD, () => ({ leadSessionId: REAL_LEAD, members: [] }))
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(join(truncated, ROSTER_FILE_NAME), 'utf8')).rosters),
    [REAL_LEAD],
    'and the file is rebuilt by the next write',
  )

  // A complete document holding one record the loader refuses: the loader refuses the whole file rather
  // than putting a malformed record in front of every tool, and this does the same.
  const invalid = join(root, 'invalid', TEAM_DIR)
  await mkdir(invalid, { recursive: true })
  await writeFile(join(invalid, ROSTER_FILE_NAME), JSON.stringify({
    version: 1,
    serial: 2,
    rosters: { 'lead-9': { leadSessionId: 'lead-9', members: 'not an array' } },
  }))
  const other = createRosterSource({ binder: workspaceBinder(home), home })
  other.bind(REAL_LEAD, join(root, 'invalid'))
  await other.readyFor(REAL_LEAD)
  assert.deepEqual(readRoster(other.table, REAL_LEAD).members, [], 'the good Lead\'s record is refused with the file, not served beside it')
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
  const first = createRosterSource({ binder: workspaceBinder(home) })
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
  const moved_ = createRosterSource({ binder })
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

  const source = createRosterSource({ binder })
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
  const source = createRosterSource({ binder: workspaceBinder(home) })
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

test('a Session with no workspace gets the frozen directory as its root, and writes there', async () => {
  const root = await scratch()
  const home = join(root, 'home')
  const frozen = join(home, '.dsh', 'team-roster')
  const source = createRosterSource({ binder: workspaceBinder(home) })

  assert.equal(source.bind(REAL_LEAD, undefined), frozen, 'a Session always has a root: the frozen one, when there is no workspace')
  await source.readyFor(REAL_LEAD)
  await updateRoster(source.table, REAL_LEAD, () => ({ leadSessionId: REAL_LEAD, members: [member()] }))
  assert.equal(source.report(REAL_LEAD).source, 'file')
  assert.equal(source.report(REAL_LEAD).path, join(frozen, ROSTER_FILE_NAME), 'and the report says which file')
  assert.equal(readRoster(source.table, REAL_LEAD).members.length, 1, 'the record is served from the file it was written to')

  await updateRoster(source.table, REAL_LEAD, (roster) => ({ ...roster, handoffTemplate: '{successor} {predecessor} {label} {assignment} {task_board}' }))
  assert.equal(JSON.parse(await readFile(join(frozen, ROSTER_FILE_NAME), 'utf8')).rosters[REAL_LEAD].handoffTemplate, '{successor} {predecessor} {label} {assignment} {task_board}', 'the write went to the frozen file')
})
