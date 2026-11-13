/**
 * The one-off migration script.
 *
 * Every test runs on fixtures in a temporary directory: the real storage domain and the real trash root
 * are never touched. The cross-volume branch is exercised by injecting the `EXDEV` rename the machine
 * this was written for produces (`C:\` to `D:\`), so the copy path — and its verification — is what runs.
 */

import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  RESTART_NOTICE,
  applyMigration,
  destinationOf,
  formatReport,
  parseArgs,
  planMigration,
} from '../scripts/migrate-roster.mjs'
import { ROSTER_FILE_NAME, TRASH_STATE } from '../roster.js'

const LEAD = 'session-00000000-0000-4000-8000-000000000001'
const DIR_NAME = 'child-aaaaaaaa-0000-4000-8000-000000000002-1794483563443'
const NOW = () => '2026-11-13T00:00:00.000Z'

/** The cross-device rename Windows produces for a `C:\` -> `D:\` move. */
const crossVolume = async () => {
  const error = new Error('EXDEV: cross-device link not permitted')
  error.code = 'EXDEV'
  throw error
}

/**
 * A workspace, an empty roster file, an empty storage domain and an old trash root, all in one temporary
 * directory. Nothing here is the real thing.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-migrate-'))
  const workspace = join(root, 'workspace')
  const dataRoot = join(workspace, '.agents', 'team')
  await mkdir(dataRoot, { recursive: true })
  const fx = {
    root,
    workspace,
    dataRoot,
    trashRoot: join(root, 'old-team-roster'),
    domain: join(root, 'team_roster.json'),
    rosterFile: join(dataRoot, ROSTER_FILE_NAME),
    request: undefined,
  }
  fx.request = { workspace, home: root, dataDir: dataRoot, trashRoot: fx.trashRoot, domain: fx.domain }
  await stage(fx, [])
  await stageDomain(fx, [])
  return fx
}

/** Write the roster file the plugin owns: `{version, serial, updatedAt, rosters}`. */
async function stage(fx, members) {
  await writeFile(fx.rosterFile, JSON.stringify({
    version: 1,
    serial: 4,
    updatedAt: '2026-11-12T00:00:00.000Z',
    rosters: { [LEAD]: { leadSessionId: LEAD, members } },
  }, null, 2), 'utf8')
}

/** Write the storage domain, which wraps the same records in `tables`. */
async function stageDomain(fx, members) {
  await writeFile(fx.domain, JSON.stringify({
    unit: 'storage',
    global: {},
    tables: { rosters: { [LEAD]: { leadSessionId: LEAD, members } } },
  }, null, 2), 'utf8')
}

/** One artifact in the old trash root, holding one file, and its absolute path. */
async function artifact(fx, dirName) {
  const dir = join(fx.trashRoot, 'trash', LEAD, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), `log for ${dirName}\n`, 'utf8')
  return dir
}

/** One retired record naming a trash destination, the shape every release before v0.26.0 wrote. */
function legacy(fx, memberId, dirName, { trashState = TRASH_STATE.done, name = 'reviewer' } = {}) {
  return {
    memberId,
    childId: dirName.replace(/-\d+$/, ''),
    name,
    label: 'Check the diff',
    phase: 'retired',
    retiredAt: '2026-11-11T00:00:00.000Z',
    archived: false,
    trashState,
    trashKind: 'directory',
    trashPath: join(fx.trashRoot, 'trash', LEAD, dirName),
    originalPath: join('/old', 'sessions', 'child', 'session.jsonl'),
  }
}

const readRoster = async (file) => JSON.parse(await readFile(file, 'utf8'))
const findByID = async (file, memberId) => (await readRoster(file)).rosters[LEAD].members.find((member) => member.memberId === memberId)

test('a legacy artifact is planned, moved, and the record is rewritten for the new root', async () => {
  const fx = await fixture()
  const dir = await artifact(fx, DIR_NAME)
  await stage(fx, [legacy(fx, '11111111-aaaa-4000-8000-000000000001', DIR_NAME)])
  const before = await readFile(fx.rosterFile, 'utf8')

  const planned = await planMigration(fx.request)
  assert.equal(planned.refusal, undefined)
  assert.equal(planned.plan.source.kind, 'file', 'the roster file is the source once it exists')
  assert.equal(planned.plan.summary.artifactsToMove, 1)
  assert.equal(planned.plan.summary.recordsToRewrite, 1)
  assert.equal(planned.plan.actions[0].source, dir)
  assert.ok(planned.plan.actions[0].files > 0, 'the plan carries the size it would verify')

  // A dry run touches nothing at all.
  assert.equal(await readFile(fx.rosterFile, 'utf8'), before, 'the dry run did not write the roster file')
  assert.equal((await stat(dir)).isDirectory(), true, 'the artifact is where it was')

  const outcome = await applyMigration(planned.plan, { renameFn: crossVolume, now: NOW })
  assert.equal(outcome.moved, 1)
  assert.equal(outcome.rewritten, 1)
  assert.deepEqual(outcome.refused, [])

  const destination = destinationOf(fx.dataRoot, LEAD, DIR_NAME)
  assert.equal(await readFile(join(destination, 'session.jsonl'), 'utf8'), `log for ${DIR_NAME}\n`, 'the bytes arrived')
  await assert.rejects(() => stat(dir), 'the source is gone only after the copy verified')

  const migrated = await findByID(fx.rosterFile, '11111111-aaaa-4000-8000-000000000001')
  assert.equal(migrated.trashDir, DIR_NAME)
  assert.equal(migrated.trashRelPath, ['trash', LEAD, DIR_NAME].join('/'))
  assert.equal(migrated.trashPath, undefined, 'the absolute path is gone')
  assert.equal(migrated.originalPath, join('/old', 'sessions', 'child', 'session.jsonl'), 'originalPath stays absolute')
  assert.equal((await readRoster(fx.rosterFile)).serial, 5, 'the file records that it changed')
})

test('a record whose artifact is on no leg is reconciled to pruned', async () => {
  const fx = await fixture()
  const record = legacy(fx, '22222222-aaaa-4000-8000-000000000002', DIR_NAME)
  record.trashPath = join('C:', 'gone', 'trash', LEAD, DIR_NAME)
  await stage(fx, [record])

  const planned = await planMigration(fx.request)
  assert.equal(planned.plan.summary.recordsToPrune, 1)
  assert.equal(planned.plan.summary.artifactsToMove, 0)
  assert.equal(planned.plan.actions[0].kind, 'reconcile-pruned')

  const outcome = await applyMigration(planned.plan, { now: NOW })
  assert.equal(outcome.reconciled, 1)
  assert.equal((await findByID(fx.rosterFile, '22222222-aaaa-4000-8000-000000000002')).trashState, TRASH_STATE.pruned)
})

test('a pending move and a record naming no destination are left alone', async () => {
  const fx = await fixture()
  const pending = legacy(fx, '33333333-aaaa-4000-8000-000000000003', DIR_NAME, { trashState: TRASH_STATE.pending })
  pending.trashPath = join('C:', 'gone', 'trash', LEAD, DIR_NAME)
  const bare = legacy(fx, '44444444-aaaa-4000-8000-000000000004', DIR_NAME, { trashState: TRASH_STATE.none })
  delete bare.trashPath
  await stage(fx, [pending, bare])
  const before = await readFile(fx.rosterFile, 'utf8')

  const planned = await planMigration(fx.request)
  assert.deepEqual(planned.plan.summary.leftAlone, { 'pending-move': 1, 'no-destination': 1 })
  assert.equal(planned.plan.summary.recordsToPrune, 0, 'a pending move is not a lost one')

  const outcome = await applyMigration(planned.plan, { now: NOW })
  assert.equal(outcome.reconciled, 0)
  assert.equal(outcome.rewritten, 0)
  assert.equal(await readFile(fx.rosterFile, 'utf8'), before, 'nothing changed, so the file was not rewritten')
})

test('a record already in the new shape is a no-op', async () => {
  const fx = await fixture()
  const record = legacy(fx, '55555555-aaaa-4000-8000-000000000005', DIR_NAME)
  delete record.trashPath
  record.trashDir = DIR_NAME
  record.trashRelPath = join('trash', LEAD, DIR_NAME)
  await stage(fx, [record])
  const destination = destinationOf(fx.dataRoot, LEAD, DIR_NAME)
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'session.jsonl'), `log for ${DIR_NAME}\n`, 'utf8')
  const before = await readFile(fx.rosterFile, 'utf8')

  const planned = await planMigration(fx.request)
  assert.equal(planned.plan.actions[0].kind, 'noop')
  assert.equal(planned.plan.summary.recordsAlreadyMigrated, 1)
  assert.equal(planned.plan.summary.artifactsToMove, 0)
  await applyMigration(planned.plan, { now: NOW })
  assert.equal(await readFile(fx.rosterFile, 'utf8'), before, 'a second run changes nothing')
})

test('applying twice changes nothing the second time', async () => {
  const fx = await fixture()
  await artifact(fx, DIR_NAME)
  await stage(fx, [legacy(fx, '66666666-aaaa-4000-8000-000000000006', DIR_NAME)])

  const first = await planMigration(fx.request)
  await applyMigration(first.plan, { renameFn: crossVolume, now: NOW })
  const afterFirst = await readFile(fx.rosterFile, 'utf8')

  const second = await planMigration(fx.request)
  assert.equal(second.plan.summary.artifactsToMove, 0, 'nothing left to move')
  assert.equal(second.plan.summary.recordsToPrune, 0, 'and nothing was mistaken for a pruned artifact')
  assert.equal(second.plan.summary.recordsAlreadyMigrated, 1)
  const outcome = await applyMigration(second.plan, { renameFn: crossVolume, now: NOW })
  assert.equal(outcome.moved, 0)
  assert.equal(outcome.rewritten, 0)
  assert.equal(outcome.reconciled, 0)
  assert.equal(await readFile(fx.rosterFile, 'utf8'), afterFirst, 'the file is untouched')
})

test('a copy that does not verify aborts that artifact and leaves the source in place', async () => {
  const fx = await fixture()
  await artifact(fx, DIR_NAME)
  await stage(fx, [legacy(fx, '77777777-aaaa-4000-8000-000000000007', DIR_NAME)])
  const before = await readFile(fx.rosterFile, 'utf8')

  // A copy that "succeeds" and comes up short — the failure a byte count catches and a glance does not.
  const shortCopy = async (from, to) => {
    await cp(from, to, { recursive: true })
    await writeFile(join(to, 'session.jsonl'), 'x', 'utf8')
  }
  const planned = await planMigration(fx.request)
  const outcome = await applyMigration(planned.plan, { renameFn: crossVolume, copyFn: shortCopy, now: NOW })

  assert.equal(outcome.moved, 0)
  assert.equal(outcome.refused.length, 1)
  assert.match(outcome.refused[0].reason, /copy verification failed: source 1 files\/\d+ bytes, copy 1 files\/\d+ bytes/)
  assert.equal(await readFile(join(fx.trashRoot, 'trash', LEAD, DIR_NAME, 'session.jsonl'), 'utf8'), `log for ${DIR_NAME}\n`, 'the source survived')
  await assert.rejects(() => stat(destinationOf(fx.dataRoot, LEAD, DIR_NAME)), 'the incomplete copy was removed, so the next run can retry')
  assert.equal(await readFile(fx.rosterFile, 'utf8'), before, 'the record still names the old shape')
})

test('the backup holds both files and the manifest before anything else is written', async () => {
  const fx = await fixture()
  await artifact(fx, DIR_NAME)
  await stage(fx, [legacy(fx, '88888888-aaaa-4000-8000-000000000008', DIR_NAME)])
  const rosterBefore = await readFile(fx.rosterFile, 'utf8')
  const domainBefore = await readFile(fx.domain, 'utf8')

  const planned = await planMigration(fx.request)
  const outcome = await applyMigration(planned.plan, { renameFn: crossVolume, now: NOW })

  assert.equal(await readFile(join(outcome.backupDir, ROSTER_FILE_NAME), 'utf8'), rosterBefore, 'the roster file, byte for byte')
  assert.equal(await readFile(join(outcome.backupDir, 'team_roster.json'), 'utf8'), domainBefore, 'the domain, byte for byte')
  const manifest = JSON.parse(await readFile(join(outcome.backupDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.domain.copied, true)
  assert.equal(manifest.records.length, 1)
  assert.equal(manifest.records[0].source, join(fx.trashRoot, 'trash', LEAD, DIR_NAME))
  assert.equal(manifest.records[0].destination, destinationOf(fx.dataRoot, LEAD, DIR_NAME))
  assert.ok(manifest.records[0].bytes > 0, 'the size of the artifact is in the manifest')
  assert.equal(await readFile(fx.domain, 'utf8'), domainBefore, 'the domain itself is never written: it is the rollback')
})

test('--apply refuses while the roster file does not exist, and the dry run reads the domain instead', async () => {
  const fx = await fixture()
  await artifact(fx, DIR_NAME)
  const record = legacy(fx, '99999999-aaaa-4000-8000-000000000009', DIR_NAME)
  await stageDomain(fx, [record])
  const domain = await readFile(fx.domain, 'utf8')
  // The state this script was written in: the plugin has not imported the records into the workspace yet.
  await rm(fx.rosterFile)

  const refused = await planMigration({ ...fx.request, apply: true })
  assert.equal(refused.refusal.reason, 'roster-file-missing')
  assert.match(refused.refusal.message, /restart the app/)
  assert.equal(refused.plan, undefined, 'nothing was planned')

  const dry = await planMigration(fx.request)
  assert.equal(dry.plan.source.kind, 'domain')
  assert.equal(dry.plan.summary.artifactsToMove, 1, 'and the plan still finds the artifact')

  const report = formatReport(dry.plan)
  assert.match(report, /DRY RUN \(nothing was written\)/)
  assert.match(report, /does not exist; reading the storage domain/)
  assert.ok(report.endsWith(RESTART_NOTICE), 'every report ends with the restart notice the plugin needs')
  assert.equal(await readFile(fx.domain, 'utf8'), domain, 'the dry run did not write the domain either')
})

test('a dry run is the default, and an unknown argument is refused', () => {
  assert.equal(parseArgs(['--workspace', 'D:\\somewhere']).apply, false, 'no --apply means no writes')
  assert.equal(parseArgs(['--workspace', 'D:\\somewhere', '--apply']).apply, true)
  assert.equal(parseArgs(['--workspace', 'x', '--trash-root', 'y']).trashRoot, 'y')
  assert.throws(() => parseArgs(['--workspace', 'x', '--nope']), /unknown argument "--nope"/)
  assert.throws(() => parseArgs(['--workspace']), /--workspace needs a value/)
})
